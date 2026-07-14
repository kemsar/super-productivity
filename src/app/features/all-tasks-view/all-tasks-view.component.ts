import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
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

import { T } from '../../t.const';
import { TaskComponent } from '../tasks/task/task.component';
import { TaskWithSubTasks } from '../tasks/task.model';
import { selectAllTasksWithSubTasks } from '../tasks/store/task.selectors';
import { selectAllProjects } from '../project/store/project.selectors';
import { selectAllTagsWithoutMyDay } from '../tag/store/tag.reducer';
import { ISSUE_PROVIDER_TYPES, ISSUE_PROVIDER_HUMANIZED } from '../issue/issue.const';
import {
  AllTasksFilter,
  AllTasksIssueTypeFilter,
  AllTasksSort,
  AllTasksSortField,
  DEFAULT_ALL_TASKS_FILTER,
  DEFAULT_ALL_TASKS_SORT,
} from './all-tasks-view.model';
import { filterTasks, sortTasks } from './all-tasks-view.util';

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
    TaskComponent,
  ],
  templateUrl: './all-tasks-view.component.html',
  styleUrls: ['./all-tasks-view.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AllTasksViewComponent {
  private readonly _store = inject(Store);
  readonly T = T;
  readonly ISSUE_PROVIDER_TYPES = ISSUE_PROVIDER_TYPES;
  readonly ISSUE_PROVIDER_HUMANIZED = ISSUE_PROVIDER_HUMANIZED;

  filter = signal<AllTasksFilter>(DEFAULT_ALL_TASKS_FILTER);
  sort = signal<AllTasksSort>(DEFAULT_ALL_TASKS_SORT);

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

  resetFilter(): void {
    this.filter.set(DEFAULT_ALL_TASKS_FILTER);
    this.sort.set(DEFAULT_ALL_TASKS_SORT);
  }

  trackByTaskId(_index: number, task: TaskWithSubTasks): string {
    return task.id;
  }
}
