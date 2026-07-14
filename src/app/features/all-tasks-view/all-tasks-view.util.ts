import { Task } from '../tasks/task.model';
import { AllTasksFilter, AllTasksSort, AllTasksSortField } from './all-tasks-view.model';

/**
 * Apply an `AllTasksFilter` to a task list. Pure function so it composes well
 * with signals/selectors and stays trivial to test. Every predicate is a
 * short-circuit; the order is roughly "cheapest first, most-selective last"
 * — the sync-updated toggle is the top of the list because it's the
 * cheapest scalar check and the most common user gesture (issue #16).
 */
const _passesDone = (task: Task, filter: AllTasksFilter): boolean => {
  if (filter.doneFilter === 'done') return !!task.isDone;
  if (filter.doneFilter === 'undone') return !task.isDone;
  return true;
};

const _passesIssueType = (task: Task, filter: AllTasksFilter): boolean => {
  const f = filter.issueTypeFilter;
  if (f === 'any') return true;
  if (f === 'has') return !!task.issueType;
  if (f === 'none') return !task.issueType;
  return task.issueType === f;
};

const _passesText = (task: Task, filter: AllTasksFilter): boolean => {
  const needle = filter.searchText.trim().toLowerCase();
  if (!needle) return true;
  if (task.title?.toLowerCase().includes(needle)) return true;
  if (task.notes?.toLowerCase().includes(needle)) return true;
  return false;
};

const _passesTags = (task: Task, filter: AllTasksFilter): boolean => {
  const taskTagIds = task.tagIds ?? [];
  if (filter.includedTagIds.length > 0) {
    if (!filter.includedTagIds.some((id) => taskTagIds.includes(id))) return false;
  }
  if (filter.excludedTagIds.length > 0) {
    if (filter.excludedTagIds.some((id) => taskTagIds.includes(id))) return false;
  }
  return true;
};

export const filterTasks = <T extends Task>(tasks: T[], filter: AllTasksFilter): T[] => {
  return tasks.filter((task) => {
    if (filter.issueWasUpdatedOnly && !task.issueWasUpdated) return false;
    if (!_passesDone(task, filter)) return false;
    if (!_passesIssueType(task, filter)) return false;
    if (filter.projectIds !== null && !filter.projectIds.includes(task.projectId)) {
      return false;
    }
    if (!_passesTags(task, filter)) return false;
    if (filter.hasNotesOnly && !task.notes) return false;
    if (!_passesText(task, filter)) return false;
    return true;
  });
};

const _pickSortValue = (task: Task, field: AllTasksSortField): unknown => {
  switch (field) {
    case 'created':
      return task.created ?? 0;
    case 'title':
      return task.title ?? '';
    case 'dueDay':
      return task.dueDay ?? '';
    case 'timeEstimate':
      return task.timeEstimate ?? 0;
    case 'issueLastUpdated':
      return task.issueLastUpdated ?? 0;
    case 'issueProviderId':
      return task.issueProviderId ?? '';
  }
};

/**
 * Stable sort a task list by an `AllTasksSort`. Strings compare via
 * `localeCompare` for i18n correctness; numbers subtract. Empty/missing
 * values sort as "least" so unset dueDays/estimates bunch together
 * predictably at the ascending end (or descending start).
 */
export const sortTasks = <T extends Task>(tasks: T[], sort: AllTasksSort): T[] => {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    const va = _pickSortValue(a, sort.field);
    const vb = _pickSortValue(b, sort.field);
    if (typeof va === 'number' && typeof vb === 'number') {
      return (va - vb) * sign;
    }
    if (typeof va === 'string' && typeof vb === 'string') {
      return va.localeCompare(vb) * sign;
    }
    return 0;
  });
};
