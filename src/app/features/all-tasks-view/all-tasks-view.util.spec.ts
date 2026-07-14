import { Task } from '../tasks/task.model';
import { createTask } from '../tasks/task.test-helper';
import {
  AllTasksFilter,
  AllTasksSort,
  DEFAULT_ALL_TASKS_FILTER,
  DEFAULT_ALL_TASKS_SORT,
} from './all-tasks-view.model';
import { filterTasks, sortTasks } from './all-tasks-view.util';

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
});
