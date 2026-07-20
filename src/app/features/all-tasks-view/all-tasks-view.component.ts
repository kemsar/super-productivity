import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { AsyncPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { TranslatePipe } from '@ngx-translate/core';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatIcon } from '@angular/material/icon';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatInput } from '@angular/material/input';
import { MatTooltip } from '@angular/material/tooltip';

import { T } from '../../t.const';
import { TaskComponent } from '../tasks/task/task.component';
import { TaskWithSubTasks } from '../tasks/task.model';
import { selectAllTasksWithSubTasks } from '../tasks/store/task.selectors';
import { selectAllProjects } from '../project/store/project.selectors';
import { selectAllTagsWithoutMyDay } from '../tag/store/tag.reducer';
import {
  GITLAB_TYPE,
  ISSUE_PROVIDER_HUMANIZED,
  ISSUE_PROVIDER_TYPES,
} from '../issue/issue.const';
import { TaskService } from '../tasks/task.service';
import { IssueProviderService } from '../issue/issue-provider.service';
import { GitlabApiService } from '../issue/providers/gitlab/gitlab-api/gitlab-api.service';
import { GitlabCfg } from '../issue/providers/gitlab/gitlab.model';
import { SnackService } from '../../core/snack/snack.service';
import { IssueLog } from '../../core/log';
import { unique } from '../../util/unique';
import {
  AllTasksCustomView,
  AllTasksFilter,
  AllTasksGroupBy,
  AllTasksGroupDir,
  AllTasksIssueTypeFilter,
  AllTasksSort,
  AllTasksSortField,
  DEFAULT_ALL_TASKS_FILTER,
  DEFAULT_ALL_TASKS_GROUP_BY,
  DEFAULT_ALL_TASKS_GROUP_DIR,
  DEFAULT_ALL_TASKS_SORT,
} from './all-tasks-view.model';
import { AllTasksCustomViewsService } from './all-tasks-custom-views.service';
import { DialogPromptComponent } from '../../ui/dialog-prompt/dialog-prompt.component';
import { DialogConfirmComponent } from '../../ui/dialog-confirm/dialog-confirm.component';
import { firstValueFrom } from 'rxjs';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import {
  filterTasks,
  groupTasks,
  sortTasks,
  TaskGroup,
  TaskGroupingContext,
} from './all-tasks-view.util';

/** Per-device preference — remembers whether the extra-filters panel is
 *  expanded across reloads. Not synced (mirrors the pattern used for the
 *  project/tag nav-tree collapse state, `LS.IS_PROJECT_LIST_EXPANDED`). */
const ALL_TASKS_FILTERS_EXPANDED_KEY = 'sp_all_tasks_filters_expanded_v1';

/**
 * Phase 1 of the "All Tasks" cross-project filtered view (issue #16).
 * Reads all tasks from the store, applies a signal-backed filter + sort,
 * renders results as a flat list of `<task>` rows. No persistence yet —
 * filter state resets on navigation. Grouping, saved views, and bulk
 * edit ship in follow-up phases.
 */
@Component({
  selector: 'all-tasks-view',
  standalone: true,
  imports: [
    AsyncPipe,
    FormsModule,
    TranslatePipe,
    MatCheckbox,
    MatFormField,
    MatLabel,
    MatOption,
    MatSelect,
    MatButton,
    MatIcon,
    MatIconButton,
    MatInput,
    MatMenu,
    MatMenuItem,
    MatMenuTrigger,
    MatTooltip,
    TaskComponent,
  ],
  templateUrl: './all-tasks-view.component.html',
  styleUrls: ['./all-tasks-view.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AllTasksViewComponent {
  private readonly _store = inject(Store);
  private readonly _customViewsService = inject(AllTasksCustomViewsService);
  private readonly _matDialog = inject(MatDialog);
  private readonly _route = inject(ActivatedRoute);
  private readonly _router = inject(Router);
  private readonly _destroyRef = inject(DestroyRef);
  private readonly _taskService = inject(TaskService);
  private readonly _issueProviderService = inject(IssueProviderService);
  private readonly _gitlabApiService = inject(GitlabApiService);
  private readonly _snackService = inject(SnackService);
  readonly T = T;
  readonly ISSUE_PROVIDER_TYPES = ISSUE_PROVIDER_TYPES;
  readonly ISSUE_PROVIDER_HUMANIZED = ISSUE_PROVIDER_HUMANIZED;
  readonly savedViews = this._customViewsService.sortedViews;
  /** Currently-loaded view id, if any. Enables the "Update" affordance. */
  readonly activeViewId = signal<string | null>(null);

  filter = signal<AllTasksFilter>(DEFAULT_ALL_TASKS_FILTER);
  sort = signal<AllTasksSort>(DEFAULT_ALL_TASKS_SORT);
  groupBy = signal<AllTasksGroupBy>(DEFAULT_ALL_TASKS_GROUP_BY);
  groupDir = signal<AllTasksGroupDir>(DEFAULT_ALL_TASKS_GROUP_DIR);
  /**
   * "Extra filters" panel expanded state — collapsed default so the vertical
   * footprint on the /all-tasks page stays compact (search + sort + group
   * are always visible). Persisted per-device to localStorage so a habitual
   * setting sticks across restarts.
   */
  isFiltersExpanded = signal<boolean>(
    localStorage.getItem(ALL_TASKS_FILTERS_EXPANDED_KEY) === '1',
  );

  /** Bulk-edit mode toggle — surfaces row checkboxes + the bulk-action
   *  toolbar. Off by default so the list stays clean until the user
   *  explicitly opts in. Kept in-memory (per-visit); persisting felt
   *  wrong — bulk edit is a transient mode, not a preference. */
  readonly isBulkEditMode = signal<boolean>(false);

  /** Ids of tasks currently selected for a bulk action (issue #16 phase 4).
   *  A `Set` gives us O(1) toggles + membership checks for the row-render
   *  loop, which matters when the visible list is large. */
  readonly selectedTaskIds = signal<Set<string>>(new Set());
  readonly hasSelection = computed(() => this.selectedTaskIds().size > 0);
  readonly selectionSize = computed(() => this.selectedTaskIds().size);
  /**
   * Collapsed-group state, keyed by `TaskGroup.key`. Kept local to the
   * component (per-visit) — persistence follows in Phase 3 alongside saved
   * custom views. Undefined = open (default).
   */
  private readonly _collapsedGroups = signal<Record<string, boolean>>({});

  readonly allTasks = toSignal(this._store.select(selectAllTasksWithSubTasks), {
    initialValue: [] as TaskWithSubTasks[],
  });
  readonly allProjects = toSignal(this._store.select(selectAllProjects), {
    initialValue: [],
  });
  readonly allTags = toSignal(this._store.select(selectAllTagsWithoutMyDay), {
    initialValue: [],
  });

  readonly visibleTasks = computed<TaskWithSubTasks[]>(() =>
    sortTasks(filterTasks(this.allTasks(), this.filter()), this.sort()),
  );

  private readonly _groupingContext = computed<TaskGroupingContext>(() => {
    const projects = this.allProjects();
    // No-value label is dimension-specific: "Local task" reads better than
    // a generic dash for the issueType bucket that catches native SP tasks,
    // and each dimension has an equivalent semantic zero.
    const noValueLabel = ((): string => {
      switch (this.groupBy()) {
        case 'issueType':
          return 'Local task';
        case 'dueDay':
          return 'No due date';
        case 'project':
          return 'No project';
        default:
          return '—';
      }
    })();
    return {
      projectTitle: (id) => (id && projects.find((p) => p.id === id)?.title) || id || '',
      issueTypeLabel: (it) =>
        (it &&
          this.ISSUE_PROVIDER_HUMANIZED[
            it as keyof typeof this.ISSUE_PROVIDER_HUMANIZED
          ]) ||
        it ||
        '',
      noValueLabel,
    };
  });

  readonly groups = computed<TaskGroup<TaskWithSubTasks>[]>(() =>
    groupTasks(
      this.visibleTasks(),
      this.groupBy(),
      this._groupingContext(),
      this.groupDir(),
    ),
  );

  isGroupCollapsed(key: string): boolean {
    return !!this._collapsedGroups()[key];
  }

  toggleGroup(key: string): void {
    this._collapsedGroups.update((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  readonly SORT_FIELDS: AllTasksSortField[] = [
    'issueLastUpdated',
    'created',
    'title',
    'dueDay',
    'timeEstimate',
    'issueProviderId',
    'age',
  ];

  readonly SORT_FIELD_LABELS: Record<AllTasksSortField, string> = {
    issueLastUpdated: 'Issue last updated',
    created: 'Created',
    title: 'Title',
    dueDay: 'Due date',
    timeEstimate: 'Time estimate',
    issueProviderId: 'Issue provider',
    age: 'Age',
  };

  readonly GROUP_BY_OPTIONS: { value: AllTasksGroupBy; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'project', label: 'Project' },
    { value: 'issueType', label: 'Issue provider' },
    { value: 'dueDay', label: 'Due date' },
    { value: 'isDone', label: 'Done state' },
    { value: 'age', label: 'Age' },
  ];

  readonly ISSUE_TYPE_OPTIONS: { value: AllTasksIssueTypeFilter; label: string }[] = [
    { value: 'any', label: 'Any' },
    { value: 'has', label: 'Any issue-linked' },
    { value: 'none', label: 'Native SP only' },
    ...ISSUE_PROVIDER_TYPES.map((key) => ({
      value: key as AllTasksIssueTypeFilter,
      label: ISSUE_PROVIDER_HUMANIZED[key],
    })),
  ];

  setSearchText(v: string): void {
    this.filter.update((prev) => ({ ...prev, searchText: v }));
  }

  setIssueWasUpdatedOnly(v: boolean): void {
    this.filter.update((prev) => ({ ...prev, issueWasUpdatedOnly: v }));
  }

  setDoneFilter(v: 'any' | 'done' | 'undone'): void {
    this.filter.update((prev) => ({ ...prev, doneFilter: v }));
  }

  setIssueTypeFilter(v: AllTasksIssueTypeFilter): void {
    this.filter.update((prev) => ({ ...prev, issueTypeFilter: v }));
  }

  setProjectIds(v: string[] | null): void {
    this.filter.update((prev) => ({ ...prev, projectIds: v }));
  }

  setIncludedTagIds(v: string[]): void {
    this.filter.update((prev) => ({ ...prev, includedTagIds: v }));
  }

  setExcludedTagIds(v: string[]): void {
    this.filter.update((prev) => ({ ...prev, excludedTagIds: v }));
  }

  setHasNotesOnly(v: boolean): void {
    this.filter.update((prev) => ({ ...prev, hasNotesOnly: v }));
  }

  setSortField(v: AllTasksSortField): void {
    this.sort.update((prev) => ({ ...prev, field: v }));
  }

  toggleSortDir(): void {
    this.sort.update((prev) => ({ ...prev, dir: prev.dir === 'asc' ? 'desc' : 'asc' }));
  }

  toggleFiltersExpanded(): void {
    this.isFiltersExpanded.update((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(ALL_TASKS_FILTERS_EXPANDED_KEY, next ? '1' : '0');
      } catch {
        // localStorage full/blocked — swallow. The in-memory signal still
        // toggles for the current session, which is the least-broken fallback.
      }
      return next;
    });
  }

  /**
   * Count of filter dimensions that differ from `DEFAULT_ALL_TASKS_FILTER`.
   * Shown as a small badge next to the collapsed "Filters" toggle so the
   * user can see at a glance whether the hidden panel is doing anything.
   * Search text is deliberately not counted because it sits in its own
   * always-visible row above the collapsible section.
   */
  readonly activeFilterCount = computed<number>(() => {
    const f = this.filter();
    let n = 0;
    if (f.issueWasUpdatedOnly) n++;
    if (f.hasNotesOnly) n++;
    if (f.doneFilter !== DEFAULT_ALL_TASKS_FILTER.doneFilter) n++;
    if (f.issueTypeFilter !== DEFAULT_ALL_TASKS_FILTER.issueTypeFilter) n++;
    if (f.projectIds !== null) n++;
    if (f.includedTagIds.length > 0) n++;
    if (f.excludedTagIds.length > 0) n++;
    return n;
  });

  setGroupBy(v: AllTasksGroupBy): void {
    this.groupBy.set(v);
    // Reset collapsed-state on group-by change — the previous keys don't
    // apply once buckets recompute, and open-by-default is the sane starting
    // point after any regrouping.
    this._collapsedGroups.set({});
  }

  toggleGroupDir(): void {
    this.groupDir.update((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  }

  resetFilter(): void {
    this.filter.set(DEFAULT_ALL_TASKS_FILTER);
    this.sort.set(DEFAULT_ALL_TASKS_SORT);
    this.groupBy.set(DEFAULT_ALL_TASKS_GROUP_BY);
    this.groupDir.set(DEFAULT_ALL_TASKS_GROUP_DIR);
    this._collapsedGroups.set({});
    this.activeViewId.set(null);
    // Drop the ?view=... query param so refreshes don't reload a view the
    // user just cleared.
    this._router.navigate([], {
      relativeTo: this._route,
      queryParams: { view: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  constructor() {
    // React to `?view=<id>` changes — a saved view loaded from the nav or a
    // direct link should apply its filter/sort/groupBy on entry.
    this._route.queryParamMap
      .pipe(takeUntilDestroyed(this._destroyRef))
      .subscribe((params) => {
        const id = params.get('view');
        if (id && id !== this.activeViewId()) {
          this._applyViewById(id);
        } else if (!id && this.activeViewId()) {
          this.activeViewId.set(null);
        }
      });
    // If a saved view is deleted while it's active, silently drop back to
    // "unsaved / free-form" state instead of showing a stale name.
    effect(() => {
      const active = this.activeViewId();
      if (active && !this._customViewsService.getById(active)) {
        this.activeViewId.set(null);
      }
    });
  }

  private _applyViewById(id: string): void {
    const view = this._customViewsService.getById(id);
    if (!view) {
      return;
    }
    this.filter.set(view.filter);
    this.sort.set(view.sort);
    this.groupBy.set(view.groupBy);
    this.groupDir.set(view.groupDir ?? DEFAULT_ALL_TASKS_GROUP_DIR);
    this._collapsedGroups.set({});
    this.activeViewId.set(view.id);
  }

  async saveAsNewView(): Promise<void> {
    const name = await firstValueFrom(
      this._matDialog
        .open(DialogPromptComponent, {
          restoreFocus: true,
          data: {
            placeholder: 'View name',
          },
        })
        .afterClosed(),
    );
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return;
    const view = this._customViewsService.save({
      name: trimmed,
      filter: this.filter(),
      sort: this.sort(),
      groupBy: this.groupBy(),
      groupDir: this.groupDir(),
    });
    this.activeViewId.set(view.id);
    this._router.navigate([], {
      relativeTo: this._route,
      queryParams: { view: view.id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  updateActiveView(): void {
    const id = this.activeViewId();
    if (!id) return;
    this._customViewsService.update(id, {
      filter: this.filter(),
      sort: this.sort(),
      groupBy: this.groupBy(),
      groupDir: this.groupDir(),
    });
  }

  loadView(view: AllTasksCustomView): void {
    this._router.navigate([], {
      relativeTo: this._route,
      queryParams: { view: view.id },
      queryParamsHandling: 'merge',
    });
  }

  async deleteView(view: AllTasksCustomView, event?: MouseEvent): Promise<void> {
    // The delete button lives inside the view row in the menu; suppress
    // the row's click (which would load the view) so a delete gesture is
    // unambiguous.
    event?.stopPropagation();
    const confirmed = await firstValueFrom(
      this._matDialog
        .open(DialogConfirmComponent, {
          restoreFocus: true,
          data: {
            message: `Delete saved view "${view.name}"? This cannot be undone.`,
          },
        })
        .afterClosed(),
    );
    if (!confirmed) return;
    this._customViewsService.remove(view.id);
  }

  trackByTaskId(_index: number, task: TaskWithSubTasks): string {
    return task.id;
  }

  trackByGroupKey(_index: number, group: TaskGroup<TaskWithSubTasks>): string {
    return group.key;
  }

  // -- Bulk selection (phase 4) ---------------------------------------------

  /** Toggle bulk-edit mode. Turning it off also clears the selection so
   *  the next entry starts clean and no stale checked-state leaks. */
  toggleBulkEditMode(): void {
    this.isBulkEditMode.update((prev) => {
      const next = !prev;
      if (!next) {
        this.selectedTaskIds.set(new Set());
      }
      return next;
    });
  }

  isTaskSelected(taskId: string): boolean {
    return this.selectedTaskIds().has(taskId);
  }

  toggleTaskSelected(taskId: string, checked: boolean): void {
    this.selectedTaskIds.update((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(taskId);
      } else {
        next.delete(taskId);
      }
      return next;
    });
  }

  selectAllVisible(): void {
    this.selectedTaskIds.set(new Set(this.visibleTasks().map((t) => t.id)));
  }

  clearSelection(): void {
    this.selectedTaskIds.set(new Set());
  }

  /** All-checked / all-unchecked / mixed for a group's rows. Used by the
   *  select-all-in-group checkbox in the group header (bulk-edit mode). */
  groupSelectionState(group: TaskGroup<TaskWithSubTasks>): 'none' | 'some' | 'all' {
    const selected = this.selectedTaskIds();
    let count = 0;
    for (const t of group.tasks) {
      if (selected.has(t.id)) count++;
    }
    if (count === 0) return 'none';
    if (count === group.tasks.length) return 'all';
    return 'some';
  }

  toggleGroupSelected(group: TaskGroup<TaskWithSubTasks>, checked: boolean): void {
    this.selectedTaskIds.update((prev) => {
      const next = new Set(prev);
      for (const t of group.tasks) {
        if (checked) {
          next.add(t.id);
        } else {
          next.delete(t.id);
        }
      }
      return next;
    });
  }

  private _selectedTasks(): TaskWithSubTasks[] {
    const ids = this.selectedTaskIds();
    return this.visibleTasks().filter((t) => ids.has(t.id));
  }

  /** Only top-level tasks — the moveToProject action rejects subtasks
   *  (they move with their parent). We surface this filter here so the
   *  toolbar's "Move to project" button can enable/disable accordingly. */
  private _selectedRootTasks(): TaskWithSubTasks[] {
    return this._selectedTasks().filter((t) => !t.parentId);
  }

  readonly selectedGitlabCount = computed<number>(() => {
    const ids = this.selectedTaskIds();
    if (ids.size === 0) return 0;
    return this.allTasks().filter(
      (t) => ids.has(t.id) && t.issueType === GITLAB_TYPE && !!t.issueId,
    ).length;
  });

  async bulkMarkDone(isDone: boolean): Promise<void> {
    const tasks = this._selectedTasks();
    if (tasks.length === 0) return;
    for (const t of tasks) {
      if (t.isDone === isDone) continue;
      this._taskService.update(t.id, { isDone });
    }
    // Rule #6: settle the reducer after a bulk-dispatch loop so downstream
    // effects observe the finished state.
    await new Promise((r) => setTimeout(r, 0));
  }

  async bulkDelete(): Promise<void> {
    const tasks = this._selectedTasks();
    if (tasks.length === 0) return;
    const confirmed = await firstValueFrom(
      this._matDialog
        .open(DialogConfirmComponent, {
          restoreFocus: true,
          data: {
            message: `Delete ${tasks.length} task(s)? This cannot be undone.`,
          },
        })
        .afterClosed(),
    );
    if (!confirmed) return;
    // Includes GitLab-linked tasks — deleting them from SP does NOT close
    // the remote issue (same guarantee as the provider-delete flow in #11).
    this._taskService.removeMultipleTasks(tasks.map((t) => t.id));
    this.clearSelection();
  }

  async bulkAddTag(tagId: string): Promise<void> {
    const tasks = this._selectedTasks();
    if (tasks.length === 0) return;
    for (const t of tasks) {
      const merged = unique([...(t.tagIds ?? []), tagId]);
      if (merged.length === (t.tagIds ?? []).length) continue;
      this._taskService.updateTags(t, merged);
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  async bulkRemoveTag(tagId: string): Promise<void> {
    const tasks = this._selectedTasks();
    if (tasks.length === 0) return;
    for (const t of tasks) {
      const filtered = (t.tagIds ?? []).filter((id) => id !== tagId);
      if (filtered.length === (t.tagIds ?? []).length) continue;
      this._taskService.updateTags(t, filtered);
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  async bulkMoveToProject(projectId: string): Promise<void> {
    const tasks = this._selectedRootTasks();
    if (tasks.length === 0) return;
    for (const t of tasks) {
      if (t.projectId === projectId) continue;
      this._taskService.moveToProject(t, projectId);
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  async bulkAddComment(): Promise<void> {
    const gitlabTasks = this._selectedTasks().filter(
      (t) => t.issueType === GITLAB_TYPE && !!t.issueId && !!t.issueProviderId,
    );
    if (gitlabTasks.length === 0) {
      this._snackService.open({
        type: 'ERROR',
        msg: 'No GitLab-linked tasks in selection — comment supported for GitLab only.',
      });
      return;
    }
    const body = await firstValueFrom(
      this._matDialog
        .open(DialogPromptComponent, {
          restoreFocus: true,
          data: {
            placeholder: `Comment (posted to ${gitlabTasks.length} GitLab issue(s))`,
          },
        })
        .afterClosed(),
    );
    const trimmed = typeof body === 'string' ? body.trim() : '';
    if (!trimmed) return;

    // Cache cfg by provider id — a selection can span multiple providers
    // (e.g. work-management group + integrations-platform project).
    const cfgCache = new Map<string, GitlabCfg>();
    let posted = 0;
    let failed = 0;
    for (const t of gitlabTasks) {
      try {
        const providerId = t.issueProviderId as string;
        let cfg = cfgCache.get(providerId);
        if (!cfg) {
          cfg = await firstValueFrom(
            this._issueProviderService.getCfgOnce$(providerId, 'GITLAB'),
          );
          cfgCache.set(providerId, cfg);
        }
        await firstValueFrom(
          this._gitlabApiService.postIssueNote$(t.issueId as string, trimmed, cfg),
        );
        posted++;
      } catch (err) {
        failed++;
        IssueLog.err('bulk-comment post failed', err);
      }
    }
    const skippedNonGitlab = this._selectedTasks().length - gitlabTasks.length;
    this._snackService.open({
      type: failed > 0 ? 'ERROR' : 'SUCCESS',
      msg:
        `Posted comment to ${posted} of ${gitlabTasks.length} GitLab issue(s)` +
        (failed > 0 ? `, ${failed} failed` : '') +
        (skippedNonGitlab > 0 ? ` (${skippedNonGitlab} non-GitLab task(s) skipped)` : ''),
    });
  }
}
