import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { FieldType } from '@ngx-formly/material';
import { FormlyFieldConfig, FormlyModule } from '@ngx-formly/core';
import { MatOption, MatSelect } from '@angular/material/select';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest, forkJoin, of } from 'rxjs';
import { catchError, map, startWith, switchMap } from 'rxjs/operators';
import { T } from 'src/app/t.const';
import { selectAllTasks } from '../../tasks/store/task.selectors';
import { selectEnabledIssueProviders } from '../../issue/store/issue-provider.selectors';
import { GITLAB_TYPE } from '../../issue/issue.const';
import { GitlabGraphqlApiService } from '../../issue/providers/gitlab/gitlab-api/gitlab-graphql-api.service';
import { IssueProviderGitlab } from '../../issue/issue.model';

/**
 * Formly field for picking one or more GitLab work-item statuses to filter a
 * board column by. Options are the union of:
 *  - every enabled GitLab provider's allowed custom statuses (authoritative,
 *    same source as the quick-add `>` picker); and
 *  - any `issueStatus` snapshots already present on tasks (offline fallback,
 *    so the picker still works when GraphQL is unreachable).
 */
@Component({
  selector: 'board-issue-status-select',
  templateUrl: './board-issue-status-select.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [FormsModule, ReactiveFormsModule, FormlyModule, MatSelect, MatOption],
})
export class BoardIssueStatusSelectComponent extends FieldType<FormlyFieldConfig> {
  private readonly _store = inject(Store);
  private readonly _graphqlApiService = inject(GitlabGraphqlApiService);

  T: typeof T = T;

  // Fetch allowed statuses once per provider set (not per task edit).
  private readonly _providerStatuses$ = this._store
    .select(selectEnabledIssueProviders)
    .pipe(
      switchMap((providers) => {
        const gitlabCfgs = providers.filter(
          (p): p is IssueProviderGitlab =>
            p?.issueProviderKey === GITLAB_TYPE &&
            this._graphqlApiService.isAvailable(p as IssueProviderGitlab),
        );
        if (!gitlabCfgs.length) {
          return of([] as string[]);
        }
        return forkJoin(
          gitlabCfgs.map((cfg) =>
            this._graphqlApiService
              .getAllowedStatuses$(cfg)
              .pipe(catchError(() => of([] as { id: string; name: string }[]))),
          ),
        ).pipe(map((lists) => lists.flat().map((s) => s.name)));
      }),
      startWith([] as string[]),
    );

  private readonly _taskStatuses$ = this._store
    .select(selectAllTasks)
    .pipe(
      map((tasks) =>
        tasks
          .map((task) => task.issueStatus)
          .filter((s): s is string => typeof s === 'string' && s.length > 0),
      ),
    );

  readonly availableStatuses = toSignal(
    combineLatest([this._providerStatuses$, this._taskStatuses$]).pipe(
      map(([providerStatuses, taskStatuses]) =>
        [...new Set([...providerStatuses, ...taskStatuses])].sort((a, b) =>
          a.localeCompare(b),
        ),
      ),
    ),
    { initialValue: [] as string[] },
  );
}
