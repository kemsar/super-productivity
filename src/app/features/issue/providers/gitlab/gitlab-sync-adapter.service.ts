import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabCfg } from './gitlab.model';
import { IssueSyncAdapter } from '../../two-way-sync/issue-sync-adapter.interface';
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
    taskContext?: { projectId?: string | null },
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
    });
    const issue = await firstValueFrom(
      this._api.createIssue$(targetProjectPath, { title }, cfg),
    );
    const issueRaw = issue as unknown as Record<string, unknown>;
    // `references.full` is the canonical `<path>#<iid>` format SP already
    // uses everywhere as `issue.id`. Fall back to synthesizing it from the
    // request path + iid if the response omits it (older GitLab versions
    // sometimes do on POST responses).
    const references = (issueRaw['references'] ?? {}) as Record<string, unknown>;
    const fullRef =
      typeof references['full'] === 'string' ? (references['full'] as string) : null;
    const iid =
      typeof issueRaw['iid'] === 'number' ? (issueRaw['iid'] as number) : undefined;
    const issueId = fullRef ?? `${targetProjectPath}#${iid ?? ''}`;
    return {
      issueId,
      issueNumber: iid,
      issueData: issueRaw,
    };
  }

  async fetchIssue(issueId: string, cfg: GitlabCfg): Promise<Record<string, unknown>> {
    const issue = await firstValueFrom(this._api.getById$(issueId, cfg));
    return (issue ?? {}) as unknown as Record<string, unknown>;
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
}
