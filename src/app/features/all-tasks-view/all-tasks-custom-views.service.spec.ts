import { TestBed } from '@angular/core/testing';

import { AllTasksCustomViewsService } from './all-tasks-custom-views.service';
import {
  DEFAULT_ALL_TASKS_FILTER,
  DEFAULT_ALL_TASKS_GROUP_BY,
  DEFAULT_ALL_TASKS_SORT,
} from './all-tasks-view.model';

describe('AllTasksCustomViewsService', () => {
  let service: AllTasksCustomViewsService;

  beforeEach(() => {
    localStorage.removeItem('sp_all_tasks_custom_views_v1');
    TestBed.configureTestingModule({ providers: [AllTasksCustomViewsService] });
    service = TestBed.inject(AllTasksCustomViewsService);
  });

  const inputView = (
    name: string,
  ): {
    name: string;
    filter: typeof DEFAULT_ALL_TASKS_FILTER;
    sort: typeof DEFAULT_ALL_TASKS_SORT;
    groupBy: typeof DEFAULT_ALL_TASKS_GROUP_BY;
  } => ({
    name,
    filter: DEFAULT_ALL_TASKS_FILTER,
    sort: DEFAULT_ALL_TASKS_SORT,
    groupBy: DEFAULT_ALL_TASKS_GROUP_BY,
  });

  it('starts with an empty list when localStorage has nothing', () => {
    expect(service.views()).toEqual([]);
  });

  it('save() returns a persisted view with a generated id and createdAt', () => {
    const created = service.save(inputView('Overdue GitLab'));
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeGreaterThan(0);
    expect(service.views()).toEqual([created]);
  });

  it('sortedViews orders by name (case-insensitive)', () => {
    service.save(inputView('zeta'));
    service.save(inputView('alpha'));
    service.save(inputView('Beta'));
    expect(service.sortedViews().map((v) => v.name)).toEqual(['alpha', 'Beta', 'zeta']);
  });

  it('update() applies a partial change and persists', () => {
    const v = service.save(inputView('Untitled'));
    service.update(v.id, { name: 'Renamed' });
    expect(service.views()[0].name).toBe('Renamed');
    // A fresh service instance re-reads from storage; it should see the
    // renamed view.
    const fresh = TestBed.runInInjectionContext(() => new AllTasksCustomViewsService());
    expect(fresh.views()[0].name).toBe('Renamed');
  });

  it('remove() drops the view and persists', () => {
    const v = service.save(inputView('to-delete'));
    service.remove(v.id);
    expect(service.views()).toEqual([]);
    expect(localStorage.getItem('sp_all_tasks_custom_views_v1')).toBe('[]');
  });

  it('tolerates a malformed localStorage blob without throwing', () => {
    localStorage.setItem('sp_all_tasks_custom_views_v1', 'not-json');
    const fresh = TestBed.runInInjectionContext(() => new AllTasksCustomViewsService());
    expect(fresh.views()).toEqual([]);
  });

  it('drops individual malformed entries but keeps the well-formed ones', () => {
    const good = { ...inputView('good'), id: 'g1', createdAt: 1 };
    localStorage.setItem(
      'sp_all_tasks_custom_views_v1',
      JSON.stringify([good, { id: 42, name: 'wrong-id-type' }, null, 'string']),
    );
    const fresh = TestBed.runInInjectionContext(() => new AllTasksCustomViewsService());
    expect(fresh.views().map((v) => v.id)).toEqual(['g1']);
  });
});
