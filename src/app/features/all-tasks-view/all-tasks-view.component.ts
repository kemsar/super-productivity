import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { toSignal } from '@angular/core/rxjs-interop';
import { AsyncPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { TranslatePipe } from '@ngx-translate/core';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatInput } from '@angular/material/input';
import { MatTooltip } from '@angular/material/tooltip';

import { T } from '../../t.const';
import { TaskComponent } from '../tasks/task/task.component';
import { TaskWithSubTasks } from '../tasks/task.model';
import { selectAllTasksWithSubTasks } from '../tasks/store/task.selectors';
import { selectAllProjects } from '../project/store/project.selectors';
import { selectAllTagsWithoutMyDay } from '../tag/store/tag.reducer';
import { ISSUE_PROVIDER_TYPES, ISSUE_PROVIDER_HUMANIZED } from '../issue/issue.const';
import {
  AllTasksCustomView,
  AllTasksFilter,
  AllTasksGroupBy,
  AllTasksIssueTypeFilter,
  AllTasksSort,
  AllTasksSortField,
  DEFAULT_ALL_TASKS_FILTER,
  DEFAULT_ALL_TASKS_GROUP_BY,
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
  readonly T = T;
  readonly ISSUE_PROVIDER_TYPES = ISSUE_PROVIDER_TYPES;
  readonly ISSUE_PROVIDER_HUMANIZED = ISSUE_PROVIDER_HUMANIZED;
  readonly savedViews = this._customViewsService.sortedViews;
  /** Currently-loaded view id, if any. Enables the "Update" affordance. */
  readonly activeViewId = signal<string | null>(null);

  filter = signal<AllTasksFilter>(DEFAULT_ALL_TASKS_FILTER);
  sort = signal<AllTasksSort>(DEFAULT_ALL_TASKS_SORT);
  groupBy = signal<AllTasksGroupBy>(DEFAULT_ALL_TASKS_GROUP_BY);
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
    groupTasks(this.visibleTasks(), this.groupBy(), this._groupingContext()),
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
  ];

  readonly SORT_FIELD_LABELS: Record<AllTasksSortField, string> = {
    issueLastUpdated: 'Issue last updated',
    created: 'Created',
    title: 'Title',
    dueDay: 'Due date',
    timeEstimate: 'Time estimate',
    issueProviderId: 'Issue provider',
  };

  readonly GROUP_BY_OPTIONS: { value: AllTasksGroupBy; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'project', label: 'Project' },
    { value: 'issueType', label: 'Issue provider' },
    { value: 'dueDay', label: 'Due date' },
    { value: 'isDone', label: 'Done state' },
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

  setGroupBy(v: AllTasksGroupBy): void {
    this.groupBy.set(v);
    // Reset collapsed-state on group-by change — the previous keys don't
    // apply once buckets recompute, and open-by-default is the sane starting
    // point after any regrouping.
    this._collapsedGroups.set({});
  }

  resetFilter(): void {
    this.filter.set(DEFAULT_ALL_TASKS_FILTER);
    this.sort.set(DEFAULT_ALL_TASKS_SORT);
    this.groupBy.set(DEFAULT_ALL_TASKS_GROUP_BY);
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
}
