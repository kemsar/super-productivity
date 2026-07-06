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
}
