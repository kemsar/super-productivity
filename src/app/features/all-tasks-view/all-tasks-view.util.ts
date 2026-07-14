import { Task } from '../tasks/task.model';
import {
  AllTasksFilter,
  AllTasksGroupBy,
  AllTasksGroupDir,
  AllTasksSort,
  AllTasksSortField,
} from './all-tasks-view.model';

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

/**
 * "Age" source for grouping/sorting: falls back through remote-issue update
 * → local task creation. Returns undefined if neither exists (rare — the
 * unknown-age bucket catches those). This drives the aging-issues view
 * (issue #18) so tasks age off both remote silence AND local staleness.
 */
export const ageSourceMs = (task: Task): number | undefined =>
  task.issueLastUpdated ?? task.created ?? undefined;

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
    case 'age':
      return ageSourceMs(task) ?? 0;
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

/**
 * A single collapsible section rendered in the grouped list view. `key` is
 * a stable string that survives filter/sort re-renders (used as the
 * `track` in the template), `label` is displayed, `tasks` is already
 * filtered + sorted by the pipeline that ran before grouping.
 */
export interface TaskGroup<T extends Task> {
  key: string;
  label: string;
  tasks: T[];
}

export interface TaskGroupingContext {
  /** SP project id → title. Used for the `'project'` grouping mode. */
  projectTitle: (projectId: string | null | undefined) => string;
  /** GitLab/plugin issue key → humanized label. Used for `'issueType'`. */
  issueTypeLabel: (issueType: string | null | undefined) => string;
  /** Label shown when the group value is missing (e.g. no due date). */
  noValueLabel: string;
  /** "Now" reference for the `'age'` grouping mode. Injected so tests
   *  can pin it and so the value refreshes when the grouping recomputes.
   *  Optional — falls back to `Date.now()` when omitted. */
  nowMs?: number;
}

/**
 * Aging buckets used by the `'age'` group-by mode (issue #18). Cutoffs are
 * in days-since-{issueLastUpdated ?? created} and mirror the CU automation
 * `daily_digest.sh` bucket() function so a stale-15-days item shows up
 * under the same header the digest email complained about it under.
 * Keys are 0-prefixed so ordering follows fresh → stale.
 *
 * Source note: the digest prefers days-since-last-user-note and only
 * falls back to `issue.updated_at` when there are no user notes. SP
 * doesn't track notes per task, so we always ride the fallback path.
 * Close enough for grouping; full parity would need per-task /notes.
 */
const _ageBucket = (
  ageMs: number | undefined,
  nowMs: number,
): { key: string; label: string; sortKey: string } => {
  if (ageMs === undefined || ageMs === null) {
    return { key: 'age:__unknown', label: 'Unknown age', sortKey: '9' };
  }
  const days = Math.max(0, Math.floor((nowMs - ageMs) / (1000 * 60 * 60 * 24)));
  if (days <= 7) return { key: 'age:fresh', label: 'Fresh (≤7 days)', sortKey: '0' };
  if (days <= 14) {
    return { key: 'age:update-needed', label: 'Stale 8–14 days', sortKey: '1' };
  }
  if (days <= 30) {
    return { key: 'age:please-update', label: 'Stale 15–30 days', sortKey: '2' };
  }
  return { key: 'age:closed-inactivity', label: 'Stale >30 days', sortKey: '3' };
};

const _pickGroupBucket = (
  task: Task,
  groupBy: AllTasksGroupBy,
  ctx: TaskGroupingContext,
): { key: string; label: string; sortKey: string } => {
  switch (groupBy) {
    case 'project': {
      const id = task.projectId ?? '';
      return {
        key: `project:${id || '__none'}`,
        label: id ? ctx.projectTitle(id) : ctx.noValueLabel,
        sortKey: (id ? ctx.projectTitle(id) : `￿${ctx.noValueLabel}`).toLowerCase(),
      };
    }
    case 'issueType': {
      const it = task.issueType ?? '';
      return {
        key: `issueType:${it || '__none'}`,
        label: it ? ctx.issueTypeLabel(it) : ctx.noValueLabel,
        sortKey: (it ? ctx.issueTypeLabel(it) : `￿${ctx.noValueLabel}`).toLowerCase(),
      };
    }
    case 'dueDay': {
      const d = task.dueDay ?? '';
      return {
        key: `dueDay:${d || '__none'}`,
        label: d || ctx.noValueLabel,
        // Chronological ascending; no-due bucket sorts to the end via ￿.
        sortKey: d || `￿${ctx.noValueLabel}`,
      };
    }
    case 'isDone': {
      const done = !!task.isDone;
      return {
        key: `isDone:${done ? '1' : '0'}`,
        label: done ? 'Done' : 'Not done',
        // Not-done first (0), done second (1).
        sortKey: done ? '1' : '0',
      };
    }
    case 'age':
      return _ageBucket(ageSourceMs(task), ctx.nowMs ?? Date.now());
    case 'none':
      return { key: 'all', label: '', sortKey: '' };
  }
};

/**
 * Bucket a task list by the given dimension. `'none'` returns a single
 * unnamed group containing every task, in the caller-provided order.
 *
 * The context (project titles, issue-type labels) is passed in rather than
 * imported so this util stays testable without spinning up the store —
 * callers wire it once from selectors/registry signals.
 */
export const groupTasks = <T extends Task>(
  tasks: T[],
  groupBy: AllTasksGroupBy,
  ctx: TaskGroupingContext,
  dir: AllTasksGroupDir = 'asc',
): TaskGroup<T>[] => {
  if (groupBy === 'none') {
    return [{ key: 'all', label: '', tasks: [...tasks] }];
  }

  const bucketMap = new Map<string, { label: string; sortKey: string; tasks: T[] }>();
  for (const task of tasks) {
    const bucket = _pickGroupBucket(task, groupBy, ctx);
    const existing = bucketMap.get(bucket.key);
    if (existing) {
      existing.tasks.push(task);
    } else {
      bucketMap.set(bucket.key, {
        label: bucket.label,
        sortKey: bucket.sortKey,
        tasks: [task],
      });
    }
  }

  const sign = dir === 'asc' ? 1 : -1;
  return [...bucketMap.entries()]
    .sort(([, a], [, b]) => a.sortKey.localeCompare(b.sortKey) * sign)
    .map(([key, v]) => ({ key, label: v.label, tasks: v.tasks }));
};
