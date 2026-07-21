import { FieldMapping, FieldSyncConfig } from './issue-sync.model';

export interface IssueSyncAdapter<TCfg> {
  getFieldMappings(): FieldMapping[];
  getSyncConfig(cfg: TCfg): FieldSyncConfig;
  fetchIssue(issueId: string, cfg: TCfg): Promise<Record<string, unknown>>;
  pushChanges(
    issueId: string,
    changes: Record<string, unknown>,
    cfg: TCfg,
  ): Promise<void>;
  extractSyncValues(issue: Record<string, unknown>): Record<string, unknown>;
  /** Extract the provider-specific last-updated marker (e.g. timestamp or etag hash) */
  getIssueLastUpdated?(issue: Record<string, unknown>): number;
  /**
   * Create a new issue on the remote from a locally-added task. `taskContext`
   * carries fields the adapter may need to route the request that aren't
   * derivable from the cfg alone — most importantly `projectId` for
   * providers where a single cfg targets multiple remote projects (GitLab
   * group provider with tree-import; issue #26). Adapters that ignore it
   * (e.g. Plainspace, which targets its cfg's single space) can simply drop
   * the arg.
   */
  createIssue?(
    title: string,
    cfg: TCfg,
    taskContext?: {
      projectId?: string | null;
    },
  ): Promise<{
    issueId: string;
    issueNumber?: number;
    issueData: Record<string, unknown>;
  }>;
  deleteIssue?(issueId: string, cfg: TCfg): Promise<void>;
}
