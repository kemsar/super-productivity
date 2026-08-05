export enum BoardPanelCfgTaskDoneState {
  All = 1,
  Done = 2,
  UnDone = 3,
}

export enum BoardPanelCfgScheduledState {
  All = 1,
  Scheduled = 2,
  NotScheduled = 3,
}

export enum BoardPanelCfgTaskTypeFilter {
  All = 1,
  NoBacklog = 2,
  OnlyBacklog = 3,
}

export enum BoardPanelCfgIssueState {
  All = 1,
  Open = 2,
  Closed = 3,
}

export type BoardSortField = 'dueDate' | 'created' | 'title' | 'timeEstimate';
export type BoardMatchMode = 'all' | 'any';

export interface BoardSrcCfg {
  includedTagIds: string[];
  excludedTagIds: string[];
  // Absent = 'all' (today's behavior): all required tags must match.
  includedTagsMatch?: BoardMatchMode;
  // Absent = 'any' (today's behavior): exclude on any match.
  excludedTagsMatch?: BoardMatchMode;
  // Absent/[''] = "All Projects". Optional so the typia validator tolerates
  // legacy data (panels that still carry `projectId` and no `projectIds`) on
  // raw-data paths that validate before the reducer's `sanitizePanelCfg` runs
  // (e.g. the legacy PFAPI → op-log migration). `sanitizePanelCfg` always
  // normalizes this to a defined array before it reaches any component.
  projectIds?: string[];
  taskDoneState: BoardPanelCfgTaskDoneState;
  scheduledState: BoardPanelCfgScheduledState;
  isParentTasksOnly: boolean;
  // Absent = manual order (user-controlled taskIds).
  sortBy?: BoardSortField;
  sortDir?: 'asc' | 'desc';
  /** @deprecated Migrated to sortBy/sortDir on load and scrubbed on save. */
  sortByDue?: 'off' | 'asc' | 'desc';
  // optional since newly added
  backlogState?: BoardPanelCfgTaskTypeFilter;
  // Filter by a linked issue's lifecycle state (currently GitLab open/closed).
  // Absent/All = don't filter by state. Matches against `task.issueState`;
  // tasks without a linked issue never match Open/Closed.
  issueState?: BoardPanelCfgIssueState;
  // Filter by a linked issue's customizable work-item status name (GitLab).
  // Absent/empty = don't filter by status. Matches ANY of the listed names
  // against `task.issueStatus`.
  issueStatuses?: string[];
}

export interface BoarFieldsToRemove {
  tagIds?: string[];
}

export interface BoardPanelCfg extends BoardSrcCfg {
  id: string;
  title: string;
  taskIds: string[];
}

export interface BoardCfg {
  id: string;
  title: string;
  cols: number;
  panels: BoardPanelCfg[];
}
