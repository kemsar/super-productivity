import { Injectable, inject } from '@angular/core';
import { createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { EMPTY, firstValueFrom, from } from 'rxjs';
import { catchError, concatMap, filter } from 'rxjs/operators';

import { LOCAL_ACTIONS } from '../../../../util/local-actions.token';
import { TaskSharedActions } from '../../../../root-store/meta/task-shared.actions';
import { TaskService } from '../../../tasks/task.service';
import { Task } from '../../../tasks/task.model';
import { IssueProviderService } from '../../issue-provider.service';
import { selectAllTags } from '../../../tag/store/tag.reducer';
import { GITLAB_TYPE } from '../../issue.const';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { IssueLog } from '../../../../core/log';

/**
 * Write side of GitLab label ↔ SP tag sync (issue #14).
 *
 * Listens for `TaskSharedActions.updateTask` on GitLab-linked tasks and,
 * when the config has `isSyncLabelsAsTags` on, diffs the task's current SP
 * tag titles against the last-known remote label set stored in
 * `task.issueLastSyncedValues.labels`. Any add/remove diff is pushed to
 * GitLab via `PUT /projects/:project/issues/:iid` with
 * `add_labels` / `remove_labels`, then the last-known labels are refreshed
 * on the task so the next diff is against the new baseline.
 *
 * Loop-prevention: an updateTask whose `changes` already carries
 * `issueLastSyncedValues` is our own read-side (or self-) dispatch and is
 * skipped — so a poll that just landed new remote labels doesn't
 * immediately fire a redundant PUT back to GitLab.
 */
@Injectable()
export class GitlabLabelSyncEffects {
  private readonly _actions$ = inject(LOCAL_ACTIONS);
  private readonly _store = inject(Store);
  private readonly _taskService = inject(TaskService);
  private readonly _issueProviderService = inject(IssueProviderService);
  private readonly _gitlabApiService = inject(GitlabApiService);

  syncLabelsOnTaskUpdate$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(TaskSharedActions.updateTask),
        // Only user-facing tag edits: skip synthetic updates that stamp
        // issueLastSyncedValues (those come from the read side or from a
        // previous push and would loop forever).
        filter((action) => {
          const changes = action.task.changes as Partial<Task>;
          return 'tagIds' in changes && !('issueLastSyncedValues' in changes);
        }),
        concatMap((action) =>
          from(this._syncLabelsForTask(action.task.id.toString())).pipe(
            catchError((err) => {
              // Log but don't tear down the effect — a broken push shouldn't
              // silence the rest of the session's tag edits.
              IssueLog.err('gitlab label sync failed', err);
              return EMPTY;
            }),
          ),
        ),
      ),
    { dispatch: false },
  );

  private async _syncLabelsForTask(taskId: string): Promise<void> {
    const task = await firstValueFrom(this._taskService.getByIdOnce$(taskId));
    if (task?.issueType !== GITLAB_TYPE || !task.issueId || !task.issueProviderId) {
      return;
    }

    // Pass the string literal 'GITLAB' so the generic narrows the return type
    // to `IssueProviderGitlab` — passing `GITLAB_TYPE` (typed as the union
    // `BuiltInIssueProviderKey`) leaves it as the full provider union and
    // hides `isSyncLabelsAsTags`.
    const cfg = await firstValueFrom(
      this._issueProviderService.getCfgOnce$(task.issueProviderId, 'GITLAB'),
    );
    if (!cfg?.isSyncLabelsAsTags) return;

    const allTags = await firstValueFrom(this._store.select(selectAllTags));
    const tagTitles = (task.tagIds ?? [])
      .map((id) => allTags.find((t) => t.id === id)?.title)
      .filter((t): t is string => !!t);

    const lastLabels = _extractLastLabels(task);
    const nextLabels = [...new Set(tagTitles)].sort((a, b) => a.localeCompare(b));

    const lastSet = new Set(lastLabels.map((l) => l.toLowerCase()));
    const nextSet = new Set(nextLabels.map((l) => l.toLowerCase()));
    // Diffs are by lowercase for the equality check, but we send GitLab the
    // titles as they appear on the SP tag / last-known list so casing is
    // preserved on the remote issue.
    const add = nextLabels.filter((l) => !lastSet.has(l.toLowerCase()));
    const remove = lastLabels.filter((l) => !nextSet.has(l.toLowerCase()));

    if (add.length === 0 && remove.length === 0) return;

    await firstValueFrom(
      this._gitlabApiService.updateIssueLabels$(task.issueId, add, remove, cfg),
    );
    // Refresh the last-known baseline so the next tag edit diffs against
    // what we just pushed. Marking issueLastSyncedValues in changes also
    // trips the loop-prevention filter above.
    this._taskService.update(task.id, {
      issueLastSyncedValues: {
        ...task.issueLastSyncedValues,
        labels: nextLabels,
      },
    });
  }
}

const _extractLastLabels = (task: Task): string[] => {
  const raw = task.issueLastSyncedValues?.['labels'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
};
