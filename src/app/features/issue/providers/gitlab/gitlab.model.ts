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
}

export interface GitlabTreeImportEntry {
  spProjectId: string;
  /** GitLab numeric id at import time. Used only to distinguish stale mappings
   *  when the same path is later reused for a different project. */
  gitlabProjectId: number;
}
