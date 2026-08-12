import { inject, Injectable } from '@angular/core';
import { firstValueFrom, from, Observable } from 'rxjs';
import { catchError, map, mergeMap, tap, toArray } from 'rxjs/operators';
import { Task, TaskCopy } from 'src/app/features/tasks/task.model';
import { BaseIssueProviderService } from '../../base/base-issue-provider.service';
import { IssueData, SearchResultItem } from '../../issue.model';
import { IssueLog } from '../../../../core/log';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { GitlabCfg } from './gitlab.model';
import { GitlabIssue } from './gitlab-issue.model';
import { toCanonicalGitlabState } from './gitlab-issue-map.util';
import { truncate } from '../../../../util/truncate';
import { GITLAB_BASE_URL, GITLAB_POLL_INTERVAL } from './gitlab.const';
import { TagService } from '../../../tag/tag.service';
import { TODAY_TAG } from '../../../tag/tag.const';
import { MenuTreeService } from '../../../menu-tree/menu-tree.service';
import {
  MenuTreeFolderNode,
  MenuTreeKind,
  MenuTreeTagNode,
  MenuTreeTreeNode,
} from '../../../menu-tree/store/menu-tree.model';

const GITLAB_TAG_FOLDER_NAME = 'GitLab';

/**
 * Parse the CSV bot-ids string on `GitlabCfg` into a Set for O(1) lookup.
 * Silently drops non-numeric fragments so a stray space or trailing comma
 * doesn't disable the filter — the digest script's tokenizer has the same
 * forgiving semantics.
 */
const _parseBotAuthorIds = (csv: string | undefined): Set<number> => {
  if (!csv) return new Set();
  const out = new Set<number>();
  for (const raw of csv.split(',')) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out;
};

@Injectable({
  providedIn: 'root',
})
export class GitlabCommonInterfacesService extends BaseIssueProviderService<GitlabCfg> {
  private readonly _gitlabApiService = inject(GitlabApiService);
  private readonly _gitlabGraphqlApiService = inject(GitlabGraphqlApiService);
  private readonly _tagService = inject(TagService);
  private readonly _menuTreeService = inject(MenuTreeService);
  private _cachedCfg?: GitlabCfg;

  readonly providerKey = 'GITLAB' as const;

  get pollInterval(): number {
    return this._cachedCfg?.pollIntervalMinutes
      ? this._cachedCfg.pollIntervalMinutes * 60 * 1000
      : GITLAB_POLL_INTERVAL;
  }

  isEnabled(cfg: GitlabCfg): boolean {
    if (!cfg || !cfg.isEnabled) {
      return false;
    }
    const mode = cfg.sourceMode || 'project';
    if (mode === 'group') {
      return !!cfg.group;
    }
    if (mode === 'all-assigned') {
      return !!cfg.token;
    }
    return !!cfg.project;
  }

  testConnection(cfg: GitlabCfg): Promise<boolean> {
    return firstValueFrom(
      this._searchIssuesWithFallback$('', cfg).pipe(map((res) => Array.isArray(res))),
    ).then((result) => result ?? false);
  }

  issueLink(issueId: string, issueProviderId: string): Promise<string> {
    return firstValueFrom(
      this._getCfgOnce$(issueProviderId).pipe(
        map((cfg) => {
          // In group / all-assigned modes there is no single project on the
          // config — each issue can live in a different project. The issue
          // id itself carries that: mapGitlabIssue writes `references.full`
          // (e.g. `group/project#42`) into it, so parse the project out of
          // the id and only fall back to cfg.project for legacy ids that
          // are missing the namespace prefix.
          const idStr = issueId.toString();
          const hashIdx = idStr.indexOf('#');
          const projectFromId = hashIdx > 0 ? idStr.slice(0, hashIdx) : '';
          const project: string | null = projectFromId || cfg.project;

          if (!project) {
            return '';
          }

          const cleanIssueId = idStr.replace(/^.*#/, '');

          if (cfg.gitlabBaseUrl) {
            const fixedUrl = cfg.gitlabBaseUrl.match(/.*\/$/)
              ? cfg.gitlabBaseUrl
              : `${cfg.gitlabBaseUrl}/`;
            return `${fixedUrl}${project}/-/issues/${cleanIssueId}`;
          } else {
            return `${GITLAB_BASE_URL}${project}/-/issues/${cleanIssueId}`;
          }
        }),
      ),
    ).then((result) => result ?? '');
  }

  getAddTaskData(issue: GitlabIssue, cfg?: GitlabCfg): Partial<Task> & { title: string } {
    return {
      title: this._formatIssueTitle(issue),
      issuePoints: issue.weight,
      issueWasUpdated: false,
      issueLastUpdated: new Date(issue.updated_at).getTime(),
      lastUserNoteAt: this._computeLastUserNoteAt(issue, cfg),
      issueId: issue.id,
      isDone: issue.state === 'closed',
      dueDay: issue.due_date || undefined,
      // Persist state + custom work-item status snapshots so board columns can
      // filter by them synchronously/offline (issues aren't cached in the
      // store). Flows to both import and poll-refresh via the base service,
      // which spreads getAddTaskData(issue) into taskChanges.
      issueState: issue.state,
      issueStatus: issue.status?.name,
    };
  }

  /**
   * Newest `updated_at` among non-system, non-bot comments on the issue.
   * Returns `null` when there are no qualifying comments so the aging util
   * can fall back to `issueLastUpdated ?? created` cleanly.
   *
   * `system=true` comments are GitLab-generated (label/state/MR-linkage
   * notes) — always excluded. Bot-authored regular comments are filtered
   * via `cfg.botAuthorIds`, mirroring the digest email's `BOT_IDS` env.
   */
  private _computeLastUserNoteAt(
    issue: GitlabIssue,
    cfg: GitlabCfg | undefined,
  ): number | null {
    const comments = issue.comments ?? [];
    if (comments.length === 0) {
      return null;
    }
    const botIds = _parseBotAuthorIds(cfg?.botAuthorIds);
    let maxMs = 0;
    for (const c of comments) {
      if (c.system) continue;
      if (botIds.has(c.author?.id ?? -1)) continue;
      const ms = new Date(c.updated_at).getTime();
      if (ms > maxMs) maxMs = ms;
    }
    return maxMs > 0 ? maxMs : null;
  }

  /**
   * Cfg-aware variant consumed by `IssueService._getAddTaskData` on the
   * initial-import path. Composes two orthogonal projections onto the base
   * task data:
   *
   * - Tree-import routing (issue #10): route to the mapped SP project when
   *   `cfg.treeImportMapping` has an entry for the issue's GitLab path.
   * - Label sync (issue #14): project `labels` onto `tagIds` and stamp
   *   `issueLastSyncedValues.labels` so the write-side effect has a
   *   baseline to diff against.
   *
   * Both are opt-in and independent — either can be enabled without the
   * other.
   */
  getAddTaskDataForCfg(
    issue: GitlabIssue,
    cfg: GitlabCfg,
  ): Partial<Task> & { title: string } {
    let out: Partial<Task> & { title: string } = this.getAddTaskData(issue, cfg);

    // Route to mapped SP project via tree-import mapping when present.
    const mapping = cfg.treeImportMapping;
    if (mapping) {
      const projectPath = issue.id.split('#')[0];
      const entry = mapping[projectPath];
      if (entry) {
        out = { ...out, projectId: entry.spProjectId };
      }
    }

    // Stamp the two-way-sync baseline. The `state` baseline is required for
    // "complete task → close issue" to push at all (issue #26): without it
    // computePushDecisions bails with `no-baseline`. The `labels` baseline is
    // added only when label-sync is on (issue #14).
    const syncedValues: Record<string, unknown> = {
      state: toCanonicalGitlabState(issue.state),
    };
    if (cfg.isSyncLabelsAsTags) {
      const labels = issue.labels ?? [];
      out = { ...out, tagIds: this._labelsToTagIds(labels) };
      syncedValues.labels = [...labels].sort((a, b) => a.localeCompare(b));
    }
    out = { ...out, issueLastSyncedValues: syncedValues };

    return out;
  }

  override async getFreshDataForIssueTask(task: Task): Promise<{
    taskChanges: Partial<Task>;
    issue: IssueData;
    issueTitle: string;
  } | null> {
    const base = await super.getFreshDataForIssueTask(task);
    if (!task.issueProviderId) {
      return base;
    }
    const cfg = await firstValueFrom(this._getCfgOnce$(task.issueProviderId));

    // The base fills lastUserNoteAt via `getAddTaskData(issue)` — but that
    // path doesn't know about `cfg.botAuthorIds`. When base returns changes,
    // recompute with cfg so bot-authored notes don't slip through and inflate
    // the "last human comment" timestamp.
    if (base && cfg.botAuthorIds) {
      const filtered = this._computeLastUserNoteAt(base.issue as GitlabIssue, cfg);
      base.taskChanges = { ...base.taskChanges, lastUserNoteAt: filtered };
    }

    const labelSyncOn = !!cfg.isSyncLabelsAsTags;
    const prevSyncedValues = (task.issueLastSyncedValues ?? {}) as Record<
      string,
      unknown
    >;
    // We only need to fetch the issue (beyond what the base already did) when
    // labels are synced, the board snapshot is missing (issue #19), or the
    // two-way-sync `state` baseline is missing (issue #26 — needed so
    // completing the task can push a close). Each is a one-time backfill; once
    // set, the base (updated_at) path keeps them fresh, so a settled task never
    // pays an extra request here.
    const needsSnapshotBackfill = task.issueState === undefined;
    const needsStateBaseline = prevSyncedValues['state'] === undefined;
    if (!labelSyncOn && !needsSnapshotBackfill && !needsStateBaseline) {
      return base;
    }

    // The base method returns null when the remote issue's `updated_at`
    // hasn't advanced. Labels/status can change (or a baseline may be missing)
    // without updated_at bumping, so fetch the issue directly when base bailed.
    const issue: GitlabIssue = ((base?.issue as GitlabIssue) ??
      ((await firstValueFrom(
        this._apiGetById$(task.issueId!, cfg),
      )) as GitlabIssue)) as GitlabIssue;
    if (!issue) {
      return base;
    }

    // Merged next baseline (issueLastSyncedValues). Only written into the task
    // when a portion below actually changes it. NOTE: stamping
    // issueLastSyncedValues here is safe from a push→pull loop — the two-way
    // sync effect skips any updateTask whose changes carry issueLastSyncedValues.
    const nextSyncedValues: Record<string, unknown> = { ...prevSyncedValues };

    // --- Label sync (issue #14) ---
    let tagIdsPortion: Partial<Task> = {};
    let labelsChanged = false;
    if (labelSyncOn) {
      const remoteLabels = [...(issue.labels ?? [])].sort((a, b) => a.localeCompare(b));
      const lastLabels = this._getLastSyncedLabels(task);
      labelsChanged = !(
        remoteLabels.length === lastLabels.length &&
        remoteLabels.every((l, i) => l === lastLabels[i])
      );
      tagIdsPortion = {
        tagIds: this._mergeLabelsIntoExistingTagIds(
          task.tagIds ?? [],
          lastLabels,
          remoteLabels,
        ),
      };
      nextSyncedValues.labels = remoteLabels;
    }

    // --- Two-way-sync state baseline (issue #26) ---
    // Track the last-seen remote state so "complete task → close issue" has a
    // baseline to push against (computePushDecisions skips without one).
    const canonicalState = toCanonicalGitlabState(issue.state);
    const stateBaselineChanged = prevSyncedValues['state'] !== canonicalState;
    if (stateBaselineChanged) {
      nextSyncedValues.state = canonicalState;
    }

    // --- Board state/status snapshot (issue #19) ---
    const snapshotPortion: Partial<TaskCopy> = {};
    if (issue.state !== task.issueState) {
      snapshotPortion.issueState = issue.state;
    }
    const remoteStatusName = issue.status?.name;
    if (remoteStatusName !== task.issueStatus) {
      snapshotPortion.issueStatus = remoteStatusName;
    }

    const hasLabelUpdate = labelSyncOn && labelsChanged;
    const hasSnapshotUpdate = Object.keys(snapshotPortion).length > 0;

    // Nothing to write beyond what the base already carried — no-op so we
    // don't spam an updateTask (and, for labels, the write-side effect).
    if (!base && !hasLabelUpdate && !hasSnapshotUpdate && !stateBaselineChanged) {
      return null;
    }

    // A pure snapshot/baseline backfill must NOT set issueWasUpdated —
    // otherwise every pre-existing task would show an "updated" badge on the
    // first poll after upgrade. Only a real remote label change sets it
    // (matching prior label behavior); base updates carry their own flag.
    const changes: Partial<Task> = {
      ...(base?.taskChanges ?? (hasLabelUpdate ? { issueWasUpdated: true } : {})),
      ...tagIdsPortion,
      ...snapshotPortion,
      ...(labelSyncOn || stateBaselineChanged
        ? { issueLastSyncedValues: nextSyncedValues }
        : {}),
    };

    return {
      taskChanges: changes,
      issue,
      issueTitle: base?.issueTitle ?? this._formatIssueTitleForSnack(issue),
    };
  }

  /**
   * Poll-fanout concurrency cap. GitLab.com throttles hard once bursts get
   * into triple digits — every issue refresh triggers 2 REST calls (issue
   * + `/notes`), so a 100-issue poll fires ~200 calls in ~1s and lands on
   * 429s. Serializing 6-at-a-time keeps us under the practical ceiling
   * while still finishing a 100-issue poll in a handful of seconds.
   */
  private static readonly _POLL_CONCURRENCY = 6;

  /**
   * Override the base's `Promise.all(...)` fanout with a bounded-concurrency
   * variant so GitLab doesn't 429 us on the initial-boot burst poll. The
   * shape of the returned promise matches the base — only the request
   * timing is different.
   */
  override async getFreshDataForIssueTasks(
    tasks: Task[],
  ): Promise<{ task: Task; taskChanges: Partial<Task>; issue: IssueData }[]> {
    if (tasks.length === 0) return [];
    return firstValueFrom(
      from(tasks).pipe(
        mergeMap(async (task) => {
          // Isolate per-task failures: a single malformed issueId (e.g.
          // legacy data where task.issueId lacks the `<path>#<iid>` shape)
          // used to reject the whole mergeMap and poison the entire poll
          // batch. Now we swallow, log, and skip so healthy tasks in the
          // same batch still refresh.
          try {
            const refreshDataForTask = await this.getFreshDataForIssueTask(task);
            return { task, refreshDataForTask };
          } catch (err) {
            IssueLog.err(
              '[Gitlab] getFreshDataForIssueTask failed for task',
              { taskId: task.id, issueId: task.issueId },
              err,
            );
            return { task, refreshDataForTask: null };
          }
        }, GitlabCommonInterfacesService._POLL_CONCURRENCY),
        toArray(),
        map((items) =>
          items.flatMap(({ refreshDataForTask, task }) =>
            refreshDataForTask
              ? [
                  {
                    task,
                    taskChanges: refreshDataForTask.taskChanges,
                    issue: refreshDataForTask.issue,
                  },
                ]
              : [],
          ),
        ),
      ),
    );
  }

  async getNewIssuesToAddToBacklog(
    issueProviderId: string,
    _allExistingIssueIds: number[] | string[],
  ): Promise<IssueData[]> {
    const cfg = await firstValueFrom(this._getCfgOnce$(issueProviderId));
    if (this._gitlabGraphqlApiService.isAvailable(cfg)) {
      try {
        return await firstValueFrom(this._gitlabGraphqlApiService.getProjectIssues$(cfg));
      } catch {
        // Fall through to REST — GraphQL is now marked unavailable for the session.
      }
    }
    return await firstValueFrom(this._gitlabApiService.getProjectIssues$(cfg));
  }

  protected _apiGetById$(
    id: string | number,
    cfg: GitlabCfg,
  ): Observable<IssueData | null> {
    const idStr = id.toString();
    if (this._canGraphqlFetchById(cfg, idStr)) {
      return this._gitlabGraphqlApiService
        .getById$(idStr, cfg)
        .pipe(catchError(() => this._gitlabApiService.getById$(idStr, cfg)));
    }
    return this._gitlabApiService.getById$(idStr, cfg);
  }

  /**
   * Whether a single issue can be fetched via GraphQL. `isAvailable(cfg)`
   * requires `cfg.project`, so it's false for group/all-assigned providers —
   * but single-issue GraphQL resolves the project from the issue id's own
   * path, so it works there too (and is the ONLY path that returns the custom
   * work-item Status widget). Prefer it whenever the id carries a resolvable
   * (non-numeric) path; raw-filter and numeric-id setups stay on REST. REST is
   * always the catchError fallback, so a wrong guess degrades gracefully.
   */
  private _canGraphqlFetchById(cfg: GitlabCfg, idStr: string): boolean {
    if (this._gitlabGraphqlApiService.isAvailable(cfg)) {
      return true;
    }
    // Project-mode and raw-filter providers keep their existing routing (REST
    // when isAvailable is false). Only extend to group/all-assigned providers:
    // they have no `cfg.project` (so isAvailable is false), but single-issue
    // GraphQL resolves the project from the issue id's own path — the only way
    // to read the custom work-item Status widget for those setups.
    if (cfg.project || cfg.filter) {
      return false;
    }
    const projectPath = idStr.split('#')[0];
    return !!projectPath && !/^\d+$/.test(projectPath);
  }

  protected _apiSearchIssues$(
    searchTerm: string,
    cfg: GitlabCfg,
  ): Observable<SearchResultItem[]> {
    return this._searchIssuesWithFallback$(searchTerm, cfg);
  }

  private _searchIssuesWithFallback$(
    searchTerm: string,
    cfg: GitlabCfg,
  ): Observable<SearchResultItem[]> {
    if (this._gitlabGraphqlApiService.isAvailable(cfg)) {
      return this._gitlabGraphqlApiService
        .searchIssueInProject$(searchTerm, cfg)
        .pipe(
          catchError(() => this._gitlabApiService.searchIssueInProject$(searchTerm, cfg)),
        );
    }
    return this._gitlabApiService.searchIssueInProject$(searchTerm, cfg);
  }

  protected _formatIssueTitleForSnack(issue: IssueData): string {
    return truncate(this._formatIssueTitle(issue as GitlabIssue));
  }

  protected _getIssueLastUpdated(issue: IssueData): number {
    return new Date((issue as GitlabIssue).updated_at).getTime();
  }

  // Caches config for the pollInterval getter (mirrors CalDAV / NextcloudDeck).
  protected override _getCfgOnce$(issueProviderId: string): Observable<GitlabCfg> {
    return super._getCfgOnce$(issueProviderId).pipe(
      tap((cfg) => {
        this._cachedCfg = cfg;
      }),
    );
  }

  private _formatIssueTitle(issue: GitlabIssue): string {
    return `#${issue.number} ${issue.title}`;
  }

  // -- label ↔ tag helpers (issue #14) --------------------------------------

  /**
   * Reads the last-known remote label list stashed on the task by a prior
   * sync run (see `getFreshDataForIssueTask` / `getAddTaskDataForCfg`).
   * Returns an empty array when the task has never been synced yet or when
   * the field is missing/malformed — never throws, so callers can treat a
   * pristine task as "no labels known" without a special case.
   */
  private _getLastSyncedLabels(task: Task): string[] {
    const raw = task.issueLastSyncedValues?.['labels'];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((v): v is string => typeof v === 'string');
  }

  /**
   * Maps a list of GitLab label titles to SP tag ids, creating tags that
   * don't exist yet by title (case-insensitive match). TODAY_TAG is virtual
   * and must not be added via tagIds (see CLAUDE.md rule #5) — the id
   * comparison filters it out even if a user has a label literally named
   * "TODAY".
   *
   * Newly-created tags are also moved into a shared "GitLab" tag folder
   * (issue #15) — the folder is created on demand if missing. Pre-existing
   * tags are left where the user placed them.
   */
  private _labelsToTagIds(labels: string[]): string[] {
    if (labels.length === 0) {
      return [];
    }
    const existing = this._tagService.tags();
    const ids: string[] = [];
    const newlyCreatedTagIds: string[] = [];
    for (const label of labels) {
      const trimmed = label.trim();
      if (!trimmed) continue;
      const match = existing.find(
        (t) => t.title.toLowerCase() === trimmed.toLowerCase() && t.id !== TODAY_TAG.id,
      );
      if (match) {
        ids.push(match.id);
      } else {
        // addTag returns synchronously with a fresh nanoid — no round-trip
        // to the store required to keep going with the rest of the list.
        const newId = this._tagService.addTag({ title: trimmed });
        ids.push(newId);
        newlyCreatedTagIds.push(newId);
      }
    }
    if (newlyCreatedTagIds.length > 0) {
      this._placeTagsInGitlabFolder(newlyCreatedTagIds);
    }
    return ids;
  }

  /**
   * Ensures a top-level "GitLab" tag folder exists in the menu tree and
   * moves the given tag ids into it. One `setTagTree` dispatch even if we
   * just created N tags — the reducer's `addTag` handler drops each new
   * tag into tagTree root, so we strip those root placements and re-insert
   * into the folder in a single atomic tree update.
   *
   * Idempotent: safe to call with a mix of pre-placed and new tag ids;
   * they end up in the folder either way (and get removed from any other
   * location they happened to occupy, so no duplicates).
   */
  private _placeTagsInGitlabFolder(tagIdsToMove: string[]): void {
    const currentTree = this._menuTreeService.tagTree();
    const newTagIds = new Set(tagIdsToMove);

    let folderNode: MenuTreeFolderNode | null = null;
    for (const node of currentTree) {
      if (node.k === MenuTreeKind.FOLDER && node.name === GITLAB_TAG_FOLDER_NAME) {
        folderNode = node;
        break;
      }
    }

    const strippedTree = _stripTagsFromTree(currentTree, newTagIds);
    const newTagNodes: MenuTreeTagNode[] = tagIdsToMove.map((id) => ({
      k: MenuTreeKind.TAG,
      id,
    }));

    let nextTree: MenuTreeTreeNode[];
    if (folderNode) {
      const updatedFolder: MenuTreeFolderNode = {
        ...folderNode,
        children: [..._filterOutTagNodes(folderNode.children, newTagIds), ...newTagNodes],
      };
      nextTree = strippedTree.map((n) =>
        n.k === MenuTreeKind.FOLDER && n.id === folderNode!.id ? updatedFolder : n,
      );
    } else {
      const newFolder: MenuTreeFolderNode = {
        k: MenuTreeKind.FOLDER,
        id: _createFolderId(),
        name: GITLAB_TAG_FOLDER_NAME,
        isExpanded: true,
        children: newTagNodes,
      };
      nextTree = [...strippedTree, newFolder];
    }

    this._menuTreeService.setTagTree(nextTree);
  }

  /**
   * Merges a fresh set of remote labels into the task's existing tagIds:
   *   - Drops tag ids that came from labels previously known (i.e. labels in
   *     `lastLabels` that are no longer in `remoteLabels`).
   *   - Preserves any other tag ids the user added by hand (or by another
   *     provider) — they don't correspond to a known GitLab label.
   *   - Adds tag ids for each new remote label, creating SP tags on demand.
   *
   * Case-insensitive title comparison throughout — GitLab treats "Bug" and
   * "bug" as the same label anyway.
   */
  private _mergeLabelsIntoExistingTagIds(
    existingTagIds: string[],
    lastLabels: string[],
    remoteLabels: string[],
  ): string[] {
    const removedLabels = new Set(
      lastLabels
        .filter((l) => !remoteLabels.some((r) => r.toLowerCase() === l.toLowerCase()))
        .map((l) => l.toLowerCase()),
    );
    const tags = this._tagService.tags();
    // Preserve tags whose title matches neither a removed label nor a new one
    // — those are user-added and untouched by the sync.
    const remoteLower = new Set(remoteLabels.map((l) => l.toLowerCase()));
    const preserved: string[] = [];
    for (const tagId of existingTagIds) {
      if (tagId === TODAY_TAG.id) continue;
      const tag = tags.find((t) => t.id === tagId);
      if (!tag) continue;
      const lower = tag.title.toLowerCase();
      if (removedLabels.has(lower)) continue;
      if (remoteLower.has(lower)) continue;
      preserved.push(tagId);
    }
    return [...preserved, ...this._labelsToTagIds(remoteLabels)];
  }
}

// -- module-scoped tree helpers (issue #15) ---------------------------------

/**
 * Walks the tag tree and strips any TAG node whose id is in `tagIds` — used
 * before re-inserting those tags into the "GitLab" folder so we don't leave
 * a duplicate at root (where the tag reducer parked it initially) or in a
 * stale prior placement.
 */
const _stripTagsFromTree = (
  tree: MenuTreeTreeNode[],
  tagIds: Set<string>,
): MenuTreeTreeNode[] => {
  return tree
    .filter((n) => !(n.k === MenuTreeKind.TAG && tagIds.has(n.id)))
    .map((n) =>
      n.k === MenuTreeKind.FOLDER
        ? { ...n, children: _stripTagsFromTree(n.children, tagIds) }
        : n,
    );
};

const _filterOutTagNodes = (
  children: MenuTreeTreeNode[],
  tagIds: Set<string>,
): MenuTreeTreeNode[] =>
  children.filter((n) => !(n.k === MenuTreeKind.TAG && tagIds.has(n.id)));

const _createFolderId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `folder-${Math.random().toString(16).slice(2)}`;
};
