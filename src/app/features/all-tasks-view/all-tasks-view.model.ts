import { IssueProviderKey } from '../issue/issue.model';

/**
 * Field to sort the filtered task list by. Kept small on purpose — every
 * option here needs UI real-estate and a comparator; more can join later
 * (Phase 2/3) once we know which ones users actually reach for.
 */
export type AllTasksSortField =
  | 'created'
  | 'title'
  | 'dueDay'
  | 'timeEstimate'
  | 'issueLastUpdated'
  | 'issueProviderId';

export type AllTasksSortDir = 'asc' | 'desc';

/**
 * `issueTypeFilter` semantics:
 *   'any'     → no constraint on issue linkage
 *   'has'     → only tasks that have any issueType
 *   'none'    → only tasks with no issueType (native SP tasks)
 *    string   → only tasks whose issueType matches (e.g. 'GITLAB')
 */
export type AllTasksIssueTypeFilter = 'any' | 'has' | 'none' | IssueProviderKey;

export type AllTasksDoneFilter = 'any' | 'done' | 'undone';

export interface AllTasksFilter {
  /** Case-insensitive substring match against task title and notes. Empty
   *  string = no text filter. Trimmed at the edges by the util so trailing
   *  whitespace doesn't accidentally drop everything. */
  searchText: string;
  /** Only tasks where `issueWasUpdated === true` (the sync-touched flag). */
  issueWasUpdatedOnly: boolean;
  issueTypeFilter: AllTasksIssueTypeFilter;
  /** null = all projects; empty array = no projects (an intentional dead
   *  filter, useful for testing but nothing more). */
  projectIds: string[] | null;
  /** Task must have at least one of these tags. Empty = no include-tag filter. */
  includedTagIds: string[];
  /** Task must not have any of these tags. Empty = no exclude-tag filter. */
  excludedTagIds: string[];
  /** Only tasks with a non-empty `notes` field. */
  hasNotesOnly: boolean;
  doneFilter: AllTasksDoneFilter;
}

export const DEFAULT_ALL_TASKS_FILTER: AllTasksFilter = {
  searchText: '',
  issueWasUpdatedOnly: false,
  issueTypeFilter: 'any',
  projectIds: null,
  includedTagIds: [],
  excludedTagIds: [],
  hasNotesOnly: false,
  doneFilter: 'undone',
};

export interface AllTasksSort {
  field: AllTasksSortField;
  dir: AllTasksSortDir;
}

export const DEFAULT_ALL_TASKS_SORT: AllTasksSort = {
  field: 'issueLastUpdated',
  dir: 'desc',
};

/**
 * Group-by dimensions for the flat list. `'none'` renders the list ungrouped
 * (Phase 1 behaviour). `'tag'` is deliberately absent for v1 because a task
 * can belong to multiple tags — a first-membership rule would surprise users
 * and true multi-group rendering means the same task shows up in every one
 * of its tags. Revisit in Phase 3 (saved views) once we have a real use case
 * to shape the tradeoff.
 */
export type AllTasksGroupBy = 'none' | 'project' | 'issueType' | 'dueDay' | 'isDone';

export const DEFAULT_ALL_TASKS_GROUP_BY: AllTasksGroupBy = 'none';

/**
 * A user-saved combination of filter + sort + groupBy that can be recalled
 * from the "Views" dropdown or a dedicated nav entry (issue #16, phase 3).
 * Local-only persistence for now (localStorage) — cross-device sync would
 * mean a new EntityType in the shared schema, which is worth doing only
 * when there's a clear user need for it.
 */
export interface AllTasksCustomView {
  id: string;
  name: string;
  filter: AllTasksFilter;
  sort: AllTasksSort;
  groupBy: AllTasksGroupBy;
  createdAt: number;
}
