import { Task } from '../tasks/task.model';
import { createTask } from '../tasks/task.test-helper';
import {
  AllTasksFilter,
  AllTasksSort,
  DEFAULT_ALL_TASKS_FILTER,
  DEFAULT_ALL_TASKS_SORT,
} from './all-tasks-view.model';
import {
  filterTasks,
  groupTasks,
  sortTasks,
  TaskGroupingContext,
} from './all-tasks-view.util';

const CTX: TaskGroupingContext = {
  projectTitle: (id) => (id ? `Project ${id}` : ''),
  issueTypeLabel: (it) => (it === 'GITLAB' ? 'GitLab' : (it ?? '')),
  noValueLabel: 'No value',
};

const t = (overrides: Partial<Task>): Task => createTask(overrides);

const f = (overrides: Partial<AllTasksFilter>): AllTasksFilter => ({
  ...DEFAULT_ALL_TASKS_FILTER,
  ...overrides,
});

const s = (overrides: Partial<AllTasksSort>): AllTasksSort => ({
  ...DEFAULT_ALL_TASKS_SORT,
  ...overrides,
});

describe('all-tasks-view.util', () => {
  describe('filterTasks', () => {
    it('defaults: only undone tasks pass', () => {
      const done = t({ id: '1', isDone: true });
      const undone = t({ id: '2', isDone: false });
      expect(filterTasks([done, undone], DEFAULT_ALL_TASKS_FILTER)).toEqual([undone]);
    });

    it('issueWasUpdatedOnly filters to sync-touched tasks only', () => {
      const stale = t({ id: '1', isDone: false, issueWasUpdated: false });
      const fresh = t({ id: '2', isDone: false, issueWasUpdated: true });
      expect(filterTasks([stale, fresh], f({ issueWasUpdatedOnly: true }))).toEqual([
        fresh,
      ]);
    });

    it('issueTypeFilter=has keeps only issue-linked tasks', () => {
      const native = t({ id: '1', isDone: false });
      const gitlab = t({ id: '2', isDone: false, issueType: 'GITLAB' });
      expect(filterTasks([native, gitlab], f({ issueTypeFilter: 'has' }))).toEqual([
        gitlab,
      ]);
    });

    it('issueTypeFilter=none keeps only native SP tasks', () => {
      const native = t({ id: '1', isDone: false });
      const gitlab = t({ id: '2', isDone: false, issueType: 'GITLAB' });
      expect(filterTasks([native, gitlab], f({ issueTypeFilter: 'none' }))).toEqual([
        native,
      ]);
    });

    it('issueTypeFilter=GITLAB narrows to that specific provider', () => {
      const gitlab = t({ id: '1', isDone: false, issueType: 'GITLAB' });
      const caldav = t({ id: '2', isDone: false, issueType: 'CALDAV' });
      expect(filterTasks([gitlab, caldav], f({ issueTypeFilter: 'GITLAB' }))).toEqual([
        gitlab,
      ]);
    });

    it('projectIds null → no gate', () => {
      const inA = t({ id: '1', isDone: false, projectId: 'a' });
      const inB = t({ id: '2', isDone: false, projectId: 'b' });
      expect(filterTasks([inA, inB], f({ projectIds: null }))).toEqual([inA, inB]);
    });

    it('projectIds narrows to listed projects', () => {
      const inA = t({ id: '1', isDone: false, projectId: 'a' });
      const inB = t({ id: '2', isDone: false, projectId: 'b' });
      expect(filterTasks([inA, inB], f({ projectIds: ['a'] }))).toEqual([inA]);
    });

    it('includedTagIds: task must have at least one', () => {
      const hasFoo = t({ id: '1', isDone: false, tagIds: ['foo'] });
      const noTags = t({ id: '2', isDone: false, tagIds: [] });
      expect(filterTasks([hasFoo, noTags], f({ includedTagIds: ['foo'] }))).toEqual([
        hasFoo,
      ]);
    });

    it('excludedTagIds: task must not have any', () => {
      const hasFoo = t({ id: '1', isDone: false, tagIds: ['foo'] });
      const noTags = t({ id: '2', isDone: false, tagIds: [] });
      expect(filterTasks([hasFoo, noTags], f({ excludedTagIds: ['foo'] }))).toEqual([
        noTags,
      ]);
    });

    it('hasNotesOnly filters to tasks with non-empty notes', () => {
      const empty = t({ id: '1', isDone: false, notes: '' });
      const withNotes = t({ id: '2', isDone: false, notes: 'hi' });
      expect(filterTasks([empty, withNotes], f({ hasNotesOnly: true }))).toEqual([
        withNotes,
      ]);
    });
  });

  describe('sortTasks', () => {
    it('sorts by title asc', () => {
      const b = t({ id: 'b', title: 'B' });
      const a = t({ id: 'a', title: 'A' });
      expect(
        sortTasks([b, a], s({ field: 'title', dir: 'asc' })).map((x) => x.id),
      ).toEqual(['a', 'b']);
    });

    it('sorts by issueLastUpdated desc — most recent first', () => {
      const older = t({ id: 'old', issueLastUpdated: 100 });
      const newer = t({ id: 'new', issueLastUpdated: 200 });
      expect(
        sortTasks([older, newer], s({ field: 'issueLastUpdated', dir: 'desc' })).map(
          (x) => x.id,
        ),
      ).toEqual(['new', 'old']);
    });

    it('unset numeric field sorts as 0 (bunches with the low end)', () => {
      const unset = t({ id: 'unset' });
      const set = t({ id: 'set', timeEstimate: 60000 });
      expect(
        sortTasks([set, unset], s({ field: 'timeEstimate', dir: 'asc' })).map(
          (x) => x.id,
        ),
      ).toEqual(['unset', 'set']);
    });

    it('does not mutate the input array', () => {
      const input = [t({ id: 'b', title: 'B' }), t({ id: 'a', title: 'A' })];
      const snap = input.slice();
      sortTasks(input, s({ field: 'title', dir: 'asc' }));
      expect(input).toEqual(snap);
    });
  });

  describe('groupTasks', () => {
    it('groupBy=none returns a single unnamed group with all tasks in order', () => {
      const tasks = [t({ id: '1' }), t({ id: '2' })];
      const groups = groupTasks(tasks, 'none', CTX);
      expect(groups).toHaveSize(1);
      expect(groups[0].key).toBe('all');
      expect(groups[0].label).toBe('');
      expect(groups[0].tasks.map((x) => x.id)).toEqual(['1', '2']);
    });

    it('groupBy=project buckets by projectId and sorts by title', () => {
      const inA = t({ id: '1', projectId: 'a' });
      const inB = t({ id: '2', projectId: 'b' });
      const inA2 = t({ id: '3', projectId: 'a' });
      const groups = groupTasks([inA, inB, inA2], 'project', CTX);
      expect(groups.map((g) => g.key)).toEqual(['project:a', 'project:b']);
      expect(groups[0].tasks.map((x) => x.id)).toEqual(['1', '3']);
      expect(groups[1].tasks.map((x) => x.id)).toEqual(['2']);
    });

    it('groupBy=issueType sends native tasks to a "No value" bucket sorted last', () => {
      const gitlab = t({ id: '1', issueType: 'GITLAB' });
      const native = t({ id: '2' });
      const groups = groupTasks([native, gitlab], 'issueType', CTX);
      expect(groups.map((g) => g.label)).toEqual(['GitLab', 'No value']);
    });

    it('groupBy=dueDay orders buckets chronologically with no-due last', () => {
      const later = t({ id: 'late', dueDay: '2026-08-01' });
      const earlier = t({ id: 'early', dueDay: '2026-07-01' });
      const noDue = t({ id: 'no-due' });
      const groups = groupTasks([later, noDue, earlier], 'dueDay', CTX);
      expect(groups.map((g) => g.label)).toEqual([
        '2026-07-01',
        '2026-08-01',
        'No value',
      ]);
    });

    it('groupBy=isDone puts not-done first, done second', () => {
      const done = t({ id: 'done', isDone: true });
      const undone = t({ id: 'undone', isDone: false });
      const groups = groupTasks([done, undone], 'isDone', CTX);
      expect(groups.map((g) => g.key)).toEqual(['isDone:0', 'isDone:1']);
      expect(groups[0].label).toBe('Not done');
      expect(groups[1].label).toBe('Done');
    });

    it('does not mutate the input array', () => {
      const input = [t({ id: 'a', projectId: 'p1' }), t({ id: 'b', projectId: 'p2' })];
      const snap = input.slice();
      groupTasks(input, 'project', CTX);
      expect(input).toEqual(snap);
    });
  });
});
