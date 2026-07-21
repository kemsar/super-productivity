import { FieldMapping, FieldSyncConfig } from './issue-sync.model';

/**
 * Structured metadata extracted from a quick-add task title by the shared
 * parser (electron/shared-with-frontend/quick-add-parser.js, issue #19).
 *
 * Passed into `IssueSyncAdapter.createIssue` under `taskContext.extras` so
 * adapters can populate the initial POST with description / assignees /
 * milestone / due-date / priority / status without re-parsing the title
 * on their own. Every field is optional — adapters ignore what they can't
 * honor. Non-parseable tokens land in `unresolved` so a downstream UI (or
 * a warning notification) can surface them without the adapter having to
 * re-inspect the title string.
 */
export interface QuickAddExtras {
  description?: string;
  assignees?: string[];
  milestone?: string;
  dueDate?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  status?: string;
  unresolved?: string[];
}

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
      /**
       * Optional parsed extras from the quick-add overlay's natural-language
       * grammar (#19). Adapters may consume as much of this as they can
       * honor — anything left over is discarded silently. The auto-create
       * effect never rejects a task because the adapter can't fulfil an
       * extra; the task lands, minus whatever the adapter dropped.
       */
      extras?: QuickAddExtras;
    },
  ): Promise<{
    issueId: string;
    issueNumber?: number;
    issueData: Record<string, unknown>;
  }>;
  deleteIssue?(issueId: string, cfg: TCfg): Promise<void>;
}
