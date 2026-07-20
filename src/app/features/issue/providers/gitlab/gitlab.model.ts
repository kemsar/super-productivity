import { BaseIssueProviderCfg } from '../../issue.model';

export type GitlabSourceMode = 'project' | 'group' | 'all-assigned';

export interface GitlabCfg extends BaseIssueProviderCfg {
  /**
   * Where to pull issues from. Missing/undefined is treated as 'project' so
   * configs persisted before this field existed keep working.
   */
  sourceMode?: GitlabSourceMode;
  project: string | null;
  /** Required only when sourceMode === 'group'. Path (e.g. `group/subgroup`) or numeric ID. */
  group?: string | null;
  filterUsername: string | null;
  /** @deprecated backwards compatibility: optional for persisted data created before this field existed */
  gitlabBaseUrl?: string | null;
  token: string | null;
  /** @deprecated backwards compatibility: optional for persisted data created before this field existed */
  scope?: string | null;
  /** @deprecated backwards compatibility: optional for persisted data created before this field existed */
  filter?: string | null;
  /** @deprecated backwards compatibility: optional for persisted data created before this field existed */
  isEnableTimeTracking?: boolean;
  pollIntervalMinutes?: number;
  /**
   * When true, GitLab issue labels sync bidirectionally with SP tags on
   * issue-linked tasks (issue #14). Read: labels project onto `task.tagIds`,
   * creating SP tags on demand. Write: `task.tagIds` changes push back as
   * `add_labels` / `remove_labels` on the issue. Both sides key off the
   * label title. Off by default — labels can be numerous and not all
   * workflows want them mirrored.
   */
  isSyncLabelsAsTags?: boolean;
  /**
   * Records what the "Generate SP tree" action created so re-runs are idempotent
   * and (later) so we can teach polling to route issues to the per-project SP
   * project. Keyed by GitLab project full path (`group/subgroup/project`).
   */
  treeImportMapping?: Record<string, GitlabTreeImportEntry>;
  /**
   * Records SP folder ids by GitLab group full path so re-runs can nest new
   * projects into the existing folder structure instead of duplicating it.
   */
  treeImportFolderMapping?: Record<string, string>;
  /**
   * Comma-separated GitLab user IDs to exclude when computing "last human
   * comment" for the aging-issues view (issue #18). Stored as a plain
   * string (e.g. "31559171, 9127544") so the config form can be a
   * standard text input — parsed to a Set<number> at read time. Mirrors
   * the `BOT_IDS` env var in `automation/scripts/daily_digest.sh` so
   * SP's age buckets can match the daily digest email exactly. Optional
   * — with an empty list we still strip GitLab-generated `system: true`
   * notes (which the digest doesn't, but SP's GraphQL path already filters
   * them out anyway).
   */
  botAuthorIds?: string;
  /**
   * When true, adding an SP task in a project targeted by this GitLab
   * provider auto-creates a matching GitLab issue via the two-way-sync
   * effect. The task is retro-linked to the returned issue (title
   * prefixed with `#<iid>`). Off by default: unlike Plainspace, existing
   * GitLab-linked SP projects predate this feature and users often use
   * SP as a lightweight overlay on top of GitLab, not a source of new
   * issues. See issue #26.
   */
  isAutoCreateIssues?: boolean;
}

export interface GitlabTreeImportEntry {
  spProjectId: string;
  /** GitLab numeric id at import time. Used only to distinguish stale mappings
   *  when the same path is later reused for a different project. */
  gitlabProjectId: number;
}
