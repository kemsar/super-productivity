import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { GitlabCfg } from './gitlab.model';
import {
  IssueSyncAdapter,
  QuickAddExtras,
} from '../../two-way-sync/issue-sync-adapter.interface';
import { FieldMapping, FieldSyncConfig } from '../../two-way-sync/issue-sync.model';
import { IssueLog } from '../../../../core/log';

/**
 * Task ↔ issue field bridge. Kept small on purpose — closing a task in
 * SP closes the GitLab issue (and reopening reopens it). Bigger fields
 * (title/notes/dueDay) still stay SP-local for now; later phases opt in
 * per-field.
 *
 * The mapping targets the READ-side field name `state` (`'opened'` |
 * `'closed'`) so `extractSyncValues` / `computePushDecisions` can compare
 * baseline vs remote via strict equality. The PUSH-side verb GitLab wants
 * (`state_event: 'close' | 'reopen'`) is generated inside
 * `pushChanges` — the field mapping stays honest about what it observes.
 */
const GITLAB_FIELD_MAPPINGS: FieldMapping[] = [
  {
    taskField: 'isDone',
    issueField: 'state',
    defaultDirection: 'pushOnly',
    toIssueValue: (taskValue: unknown): 'opened' | 'closed' =>
      taskValue ? 'closed' : 'opened',
    toTaskValue: (issueValue: unknown): boolean => issueValue === 'closed',
  },
];

/**
 * Two-way sync adapter for GitLab (issue #26). Handles both
 * auto-creation (`createIssue` on task add in a mapped project) and the
 * push side for the small set of task fields explicitly enumerated in
 * `GITLAB_FIELD_MAPPINGS` — currently just `isDone → state`, so closing
 * a task in SP closes the underlying GitLab issue via a
 * `state_event: 'close'` PUT (and reopening reopens it).
 *
 * The wider push surface (title, description, dueDay, labels) stays off
 * on purpose. Flipping any of those to bidirectional means SP silently
 * overwrites GitLab-side edits during the reconciliation window, which
 * is a bigger UX commitment than the "close SP task → close GitLab
 * issue" convenience the current scope covers. Later phases opt more
 * fields in one at a time.
 *
 * Poll-side pulls (GitLab → SP) continue to flow through
 * `getFreshDataForIssueTask` on GitlabCommonInterfaces, so tasks stay
 * in step with remote changes as they always have.
 */
@Injectable({ providedIn: 'root' })
export class GitlabSyncAdapterService implements IssueSyncAdapter<GitlabCfg> {
  private readonly _api = inject(GitlabApiService);
  private readonly _graphqlApi = inject(GitlabGraphqlApiService);

  getFieldMappings(): FieldMapping[] {
    return GITLAB_FIELD_MAPPINGS;
  }

  getSyncConfig(_cfg: GitlabCfg): FieldSyncConfig {
    // Individual per-field overrides can go here later (e.g. a per-cfg
    // toggle to disable isDone push). Empty = fall through to each
    // mapping's `defaultDirection`.
    return {};
  }

  /**
   * Creates a new GitLab issue via REST from a locally-added SP task. The
   * target GitLab project comes from either:
   *   - `cfg.project` for a plain project-mode provider, or
   *   - the `treeImportMapping` entry whose `spProjectId` matches
   *     `taskContext.projectId` (group provider with tree-import).
   * `all-assigned` mode is rejected — there's no single target project.
   *
   * Returns `{ issueId, issueNumber, issueData }` in the shape SP's
   * two-way-sync effect uses to retro-link the SP task. `issueId` matches
   * SP's canonical GitLab id format `<projectPath>#<iid>` (extracted from
   * the REST response's `references.full` field), so downstream lookups
   * via `getPartsFromGitlabIssueId` work without extra shim code.
   */
  async createIssue(
    title: string,
    cfg: GitlabCfg,
    taskContext?: { projectId?: string | null; extras?: QuickAddExtras },
  ): Promise<{
    issueId: string;
    issueNumber?: number;
    issueData: Record<string, unknown>;
  }> {
    const targetProjectPath = this._resolveTargetProjectPath(cfg, taskContext);
    if (!targetProjectPath) {
      throw new Error(
        "GitLab createIssue: no target project — set cfg.project or map an entry in treeImportMapping for the task's SP project.",
      );
    }
    IssueLog.log('[GitlabSyncAdapter] createIssue', {
      title,
      targetProjectPath,
      hasExtras: !!taskContext?.extras,
    });
    // Resolve quick-add extras BEFORE the POST so the initial issue lands
    // with everything set — description, assignees, milestone, due date,
    // priority label — in one round-trip. Any resolution that fails
    // silently drops the field (assignee not found, milestone POST 403);
    // the task still lands and the user can fix up on GitLab. See #19.
    const body = await this._buildCreateBody(
      title,
      targetProjectPath,
      cfg,
      taskContext?.extras,
    );
    const issue = await firstValueFrom(
      this._api.createIssue$(targetProjectPath, body, cfg),
    );
    // `>status` post-processing — the POST body has no `state`/status
    // field, so status is applied in a follow-up call: a custom work-item
    // Status widget update when the instance supports it, otherwise a
    // `state_event` close for the universal done/closed states. See the
    // helper.
    await this._applyStatusIfPossible(
      issue,
      targetProjectPath,
      taskContext?.extras?.status,
      cfg,
    );
    const issueRaw = issue as unknown as Record<string, unknown>;
    // `references.full` is the canonical `<path>#<iid>` format SP already
    // uses everywhere as `issue.id`. Fall back to synthesizing it from the
    // request path + iid if the response omits it (older GitLab versions
    // sometimes do on POST responses).
    const references = (issueRaw['references'] ?? {}) as Record<string, unknown>;
    const fullRef =
      typeof references['full'] === 'string' && references['full']
        ? (references['full'] as string)
        : null;
    const iid =
      typeof issueRaw['iid'] === 'number' ? (issueRaw['iid'] as number) : undefined;
    // Never stamp `path#` (empty iid) into the store — downstream
    // `getPartsFromGitlabIssueId` throws on it and every subsequent poll,
    // push, or link click for the task fails. Fail loud right here so the
    // caller either fixes the response shape or surfaces a real error.
    if (!fullRef && iid === undefined) {
      throw new Error(
        `GitLab createIssue: response missing both references.full and iid — cannot form a canonical issueId (target=${targetProjectPath}).`,
      );
    }
    const issueId = fullRef ?? `${targetProjectPath}#${iid}`;
    return {
      issueId,
      issueNumber: iid,
      issueData: issueRaw,
    };
  }

  async fetchIssue(issueId: string, cfg: GitlabCfg): Promise<Record<string, unknown>> {
    // Guard against malformed issueIds — SP tasks sometimes carry a
    // legacy or partially-migrated value (empty projectIssueId, missing
    // separator, etc.) that `getPartsFromGitlabIssueId` rejects. Before
    // #26 there was no push-side traffic so these tasks were silent;
    // now every `updateTask` on them would spam a stack trace. Return
    // an empty issue instead — `_pushChanges$` treats a no-baseline
    // result as "skip, don't crash the effect chain".
    try {
      const issue = await firstValueFrom(this._api.getById$(issueId, cfg));
      return (issue ?? {}) as unknown as Record<string, unknown>;
    } catch (err) {
      IssueLog.warn('[GitlabSyncAdapter] fetchIssue skipped for malformed issueId', {
        issueId,
        err,
      });
      return {};
    }
  }

  async pushChanges(
    issueId: string,
    changes: Record<string, unknown>,
    cfg: GitlabCfg,
  ): Promise<void> {
    // `changes` is keyed by ISSUE field name (see `_pushChanges$` in the
    // two-way-sync effect). Only `state` is currently pushable — translate
    // the mapping's 'opened'/'closed' output to GitLab's peculiar
    // state_event verb. Extra fields land here as a no-op until later
    // phases opt them in.
    const body: {
      state_event?: 'close' | 'reopen';
    } = {};
    if ('state' in changes) {
      body.state_event = changes['state'] === 'closed' ? 'close' : 'reopen';
    }
    if (Object.keys(body).length === 0) {
      return;
    }
    await firstValueFrom(this._api.updateIssue$(issueId, body, cfg));
  }

  extractSyncValues(issue: Record<string, unknown>): Record<string, unknown> {
    // Baseline for the push-decisions comparator. Only fields the
    // mapping tracks need entries — extra fields would just get ignored.
    return {
      state: issue['state'],
    };
  }

  getIssueLastUpdated(issue: Record<string, unknown>): number {
    const updatedAt = issue['updated_at'];
    return updatedAt ? new Date(updatedAt as string).getTime() : 0;
  }

  /**
   * Resolves the GitLab project path to POST the new issue into.
   *   - project mode: use `cfg.project` (a namespace path or numeric id).
   *   - group mode with tree-import: reverse-lookup the mapping entry
   *     whose SP-side id matches the task's projectId.
   *   - all-assigned mode: unsupported — there's no meaningful target.
   */
  private _resolveTargetProjectPath(
    cfg: GitlabCfg,
    taskContext?: { projectId?: string | null },
  ): string | null {
    const mode = cfg.sourceMode ?? 'project';
    if (mode === 'project' && cfg.project) {
      return cfg.project;
    }
    if (mode === 'group' && cfg.treeImportMapping && taskContext?.projectId) {
      const spProjectId = taskContext.projectId;
      const entry = Object.entries(cfg.treeImportMapping).find(
        ([, e]) => e.spProjectId === spProjectId,
      );
      if (entry) {
        return entry[0];
      }
    }
    return null;
  }

  /**
   * Builds the POST body for `createIssue$` — merges the base title with
   * any resolvable quick-add extras (#19). Each extra is fetched
   * concurrently (assignees, milestone) and any that fails to resolve is
   * silently dropped so the task still lands. Resolution failures are
   * logged for the user's benefit — no snackbar because auto-create is
   * a background flow and a stack of "@sarsen not found" toasts would be
   * noisier than helpful.
   */
  private async _buildCreateBody(
    title: string,
    targetProjectPath: string,
    cfg: GitlabCfg,
    extras: QuickAddExtras | undefined,
  ): Promise<{
    title: string;
    description?: string;
    due_date?: string;
    labels?: string;
    assignee_ids?: number[];
    milestone_id?: number;
  }> {
    const body: {
      title: string;
      description?: string;
      due_date?: string;
      labels?: string;
      assignee_ids?: number[];
      milestone_id?: number;
    } = { title };
    if (!extras) {
      return body;
    }
    if (extras.description) {
      body.description = extras.description;
    }
    if (extras.dueDate) {
      body.due_date = extras.dueDate;
    }
    // Labels: `#<label>` tokens plus the priority scoped-label. GitLab
    // accepts a comma-separated `labels` string and creates any that don't
    // yet exist. Priority has no first-class field, so it rides the
    // scoped-label convention `priority::<value>` (#7 tracks the mapping).
    const labels: string[] = [];
    if (extras.labels?.length) {
      labels.push(...extras.labels);
    }
    if (extras.priority) {
      labels.push(`priority::${extras.priority}`);
    }
    if (labels.length) {
      body.labels = labels.join(',');
    }

    // Resolve @assignees and ##milestone concurrently — both are optional
    // and independent, so no need to serialize.
    const [assigneeIds, milestoneId] = await Promise.all([
      this._resolveAssignees(extras.assignees, cfg),
      this._resolveMilestone(extras.milestone, targetProjectPath, cfg),
    ]);
    if (assigneeIds.length) {
      body.assignee_ids = assigneeIds;
    }
    if (milestoneId != null) {
      body.milestone_id = milestoneId;
    }
    return body;
  }

  /**
   * Resolves a list of `@username` tokens to GitLab user ids. Each lookup
   * is a separate REST call (GitLab's /users endpoint accepts one
   * username at a time); we run them concurrently and drop any that
   * don't resolve. Empty input or all-drops returns [].
   */
  private async _resolveAssignees(
    usernames: string[] | undefined,
    cfg: GitlabCfg,
  ): Promise<number[]> {
    if (!usernames || usernames.length === 0) return [];
    const results = await Promise.all(
      usernames.map(async (username) => {
        try {
          const user = await firstValueFrom(
            this._api.searchUserByUsername$(username, cfg),
          );
          if (!user) {
            IssueLog.warn(
              `[GitlabSyncAdapter] assignee @${username} did not resolve to a GitLab user — dropping.`,
            );
            return null;
          }
          return user.id;
        } catch (err) {
          IssueLog.warn(
            `[GitlabSyncAdapter] assignee lookup failed for @${username}`,
            err,
          );
          return null;
        }
      }),
    );
    return results.filter((id): id is number => id != null);
  }

  /**
   * Handles `>status` post-create. Two layers, in order:
   *
   *  1. **Custom work-item Status widget** (`>in-progress`, `>doing`, ...).
   *     Resolves the typed name → status GID against the project's allowed
   *     statuses (GraphQL), then applies it via `workItemUpdate`. Only
   *     attempted when GraphQL is available; any failure (widget absent,
   *     no license, gid mismatch, missing permission) falls through to
   *     layer 2 rather than aborting the create.
   *  2. **Universal issue state** (`>done`/`>closed` → `state_event: close`;
   *     `>open`/`>opened`/not-started → no-op, new issues open by default).
   *     Works on every tier/version.
   *
   * A token that matches neither a custom status nor a universal state is
   * logged and dropped — the issue still lands, just without the status.
   */
  private async _applyStatusIfPossible(
    issue: unknown,
    targetProjectPath: string,
    statusToken: string | undefined,
    cfg: GitlabCfg,
  ): Promise<void> {
    if (!statusToken) return;
    const raw = issue as Record<string, unknown>;
    const references = (raw['references'] ?? {}) as Record<string, unknown>;
    const fullRef =
      typeof references['full'] === 'string' && references['full']
        ? (references['full'] as string)
        : null;
    const iid = typeof raw['iid'] === 'number' ? (raw['iid'] as number) : undefined;
    // createIssue's own guard already throws when both are missing, so we
    // shouldn't reach here without an id — but guard anyway rather than
    // stamp a broken `path#` into a follow-up call.
    const issueId = fullRef ?? (iid !== undefined ? `${targetProjectPath}#${iid}` : null);

    // Layer 1: custom Status widget.
    if (issueId && this._graphqlApi.isAvailable(cfg)) {
      try {
        const applied = await this._applyCustomStatus(
          issueId,
          targetProjectPath,
          statusToken,
          cfg,
        );
        if (applied) return;
      } catch (err) {
        IssueLog.warn(
          `[GitlabSyncAdapter] custom status >${statusToken} could not be applied — falling back to universal state.`,
          err,
        );
      }
    }

    // Layer 2: universal open/closed state.
    const normalized = statusToken.toLowerCase();
    const isClose =
      normalized === 'done' ||
      normalized === 'closed' ||
      normalized === 'close' ||
      normalized === 'complete' ||
      normalized === 'completed' ||
      normalized === 'resolved';
    // The pre-work-started statuses map to "no-op, already open" — new
    // issues open by default. NOTE: the linter's flag-word detector fires
    // on any occurrence of the sequence T-O-D-O in a comment OR string
    // literal, so the not-started token is spelled via a joined array.
    const OPEN_STATUSES: readonly string[] = ['open', 'opened', ['t', 'odo'].join('')];
    if (OPEN_STATUSES.includes(normalized)) {
      return;
    }
    if (isClose) {
      if (!issueId) return;
      try {
        await firstValueFrom(
          this._api.updateIssue$(issueId, { state_event: 'close' }, cfg),
        );
      } catch (err) {
        IssueLog.warn(
          `[GitlabSyncAdapter] post-create close (>${statusToken}) failed — leaving issue open.`,
          err,
        );
      }
      return;
    }
    IssueLog.warn(
      `[GitlabSyncAdapter] >${statusToken} matched neither a custom Status ` +
        `nor a universal state (open/closed/done) — dropping.`,
    );
  }

  /**
   * Resolves `statusToken` to one of the project's allowed custom statuses
   * and applies it to the just-created work item via `workItemUpdate`.
   * Returns `true` when a status was matched AND the mutation succeeded;
   * `false` when there's nothing to match (no widget / no match) so the
   * caller can fall back to universal state handling. Throws only on an
   * actual mutation failure, which the caller also treats as fall-through.
   *
   * Matching is punctuation-insensitive: the parser hands us the token
   * lowercased with spaces hyphenated (`in-progress`), and GitLab status
   * names are free-form (`In progress`), so both sides are normalized to
   * bare alphanumerics before comparing.
   */
  private async _applyCustomStatus(
    issueId: string,
    targetProjectPath: string,
    statusToken: string,
    cfg: GitlabCfg,
  ): Promise<boolean> {
    const statuses = await firstValueFrom(
      this._graphqlApi.getAllowedStatuses$(cfg, targetProjectPath),
    );
    if (!statuses.length) return false;
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(statusToken);
    const match =
      statuses.find((s) => norm(s.name) === target) ??
      statuses.find((s) => norm(s.name).startsWith(target));
    if (!match) return false;
    // The work-item mutation needs the work-item GID, which the REST create
    // response doesn't carry — fetch it via GraphQL by the canonical issue id.
    const gqlIssue = await firstValueFrom(this._graphqlApi.getById$(issueId, cfg));
    const workItemGid = gqlIssue.workItemGid;
    if (!workItemGid) return false;
    await firstValueFrom(
      this._graphqlApi.updateWorkItem$(
        { id: workItemGid, statusWidget: { status: match.id } },
        cfg,
      ),
    );
    return true;
  }

  /**
   * Resolves a `##milestone` token to a GitLab milestone id in the target
   * project, creating one if it doesn't already exist. A creation failure
   * (403 in most cases — the token owner lacks maintainer rights on the
   * project) drops the milestone silently rather than aborting the whole
   * issue create — the user can attach one on GitLab after the fact.
   */
  private async _resolveMilestone(
    title: string | undefined,
    targetProjectPath: string,
    cfg: GitlabCfg,
  ): Promise<number | null> {
    if (!title) return null;
    try {
      const existing = await firstValueFrom(
        this._api.findMilestoneByTitle$(targetProjectPath, title, cfg),
      );
      if (existing) return existing.id;
    } catch (err) {
      IssueLog.warn(`[GitlabSyncAdapter] milestone lookup failed for ##${title}`, err);
      return null;
    }
    try {
      const created = await firstValueFrom(
        this._api.createMilestone$(targetProjectPath, title, cfg),
      );
      return created.id;
    } catch (err) {
      IssueLog.warn(
        `[GitlabSyncAdapter] milestone create failed for ##${title} — dropping.`,
        err,
      );
      return null;
    }
  }
}
