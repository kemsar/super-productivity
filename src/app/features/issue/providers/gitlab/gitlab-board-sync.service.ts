import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { T } from '../../../../t.const';
import { SnackService } from '../../../../core/snack/snack.service';
import { IssueLog } from '../../../../core/log';
import { TaskService } from '../../../tasks/task.service';
import { Task, TaskCopy } from '../../../tasks/task.model';
import { IssueProviderService } from '../../issue-provider.service';
import { IssueService } from '../../issue.service';
import { GITLAB_TYPE } from '../../issue.const';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { getPartsFromGitlabIssueId } from './gitlab-issue-map.util';

/** What a board column wants applied to the dropped task's GitLab issue. */
export interface GitlabBoardTargets {
  /** 'open' → reopen, 'closed' → close. Absent = leave state untouched. */
  state?: 'open' | 'closed';
  /** A single custom work-item status name to set. Absent = leave untouched. */
  statusName?: string;
}

type ApplyOutcome = 'applied' | 'unavailable' | 'failed';

/**
 * Applies a board column's issue targets (open/closed state and/or a single
 * custom work-item status) to the GitLab issue behind a dropped task, then
 * mirrors the result onto the task's persisted snapshot so it stays in the
 * destination column.
 *
 * Called imperatively from the board drop gesture (not from an effect) so the
 * remote write only ever fires on an explicit user action — a poll that
 * refreshes `issueState`/`issueStatus` can never feed back into a write.
 */
@Injectable({ providedIn: 'root' })
export class GitlabBoardSyncService {
  private readonly _issueProviderService = inject(IssueProviderService);
  private readonly _apiService = inject(GitlabApiService);
  private readonly _graphqlApiService = inject(GitlabGraphqlApiService);
  private readonly _taskService = inject(TaskService);
  private readonly _snackService = inject(SnackService);
  private readonly _issueService = inject(IssueService);

  async applyPanelTargets(task: Task, targets: GitlabBoardTargets): Promise<void> {
    if (
      task.issueType !== GITLAB_TYPE ||
      !task.issueId ||
      !task.issueProviderId ||
      (!targets.state && !targets.statusName)
    ) {
      return;
    }

    // 'GITLAB' literal narrows the cfg type to IssueProviderGitlab.
    const cfg = await firstValueFrom(
      this._issueProviderService.getCfgOnce$(task.issueProviderId, 'GITLAB'),
    );

    const changes: Partial<TaskCopy> = {};
    let statusOutcome: ApplyOutcome | null = null;
    let stateOutcome: ApplyOutcome | null = null;

    if (targets.statusName) {
      statusOutcome = await this._applyStatus(
        task.issueId,
        targets.statusName,
        cfg,
        changes,
      );
    }
    if (targets.state) {
      stateOutcome = await this._applyState(task.issueId, targets.state, cfg, changes);
    }

    if (Object.keys(changes).length > 0) {
      this._taskService.update(task.id, changes);
      // Push the fresh issue to an open detail panel so its Status/State row
      // reflects the change without reopening (no-op if none is open).
      void this._issueService.reloadIssueDataForOpenViews(task);
    }

    // One consolidated snackbar per drop — two racing snacks would collapse
    // through the service's debounce and flash by too fast to read.
    this._notifyOutcome(targets, statusOutcome, stateOutcome);
  }

  private async _applyStatus(
    issueId: string,
    statusName: string,
    cfg: Parameters<GitlabGraphqlApiService['applyStatusByName']>[3],
    changes: Partial<TaskCopy>,
  ): Promise<ApplyOutcome> {
    // NOTE: no `isAvailable(cfg)` gate — that checks `cfg.project`, which is
    // null for group/all-assigned providers, and can be disabled by an earlier
    // transient error. `applyStatusByName` resolves the project from the
    // issue's own path, so it works regardless of the provider's scope mode.
    let projectPath: string;
    try {
      projectPath = getPartsFromGitlabIssueId(issueId).project;
    } catch (err) {
      IssueLog.err('[GitlabBoardSync] could not parse GitLab issue id', err);
      return 'failed';
    }
    try {
      const applied = await this._graphqlApiService.applyStatusByName(
        issueId,
        projectPath,
        statusName,
        cfg,
      );
      if (applied) {
        changes.issueStatus = statusName;
        return 'applied';
      }
      // No status widget on the project, or no status matched by name.
      return 'unavailable';
    } catch (err) {
      IssueLog.err('[GitlabBoardSync] custom status update failed', err);
      return 'failed';
    }
  }

  private async _applyState(
    issueId: string,
    state: 'open' | 'closed',
    cfg: Parameters<GitlabApiService['updateIssue$']>[2],
    changes: Partial<TaskCopy>,
  ): Promise<ApplyOutcome> {
    try {
      await firstValueFrom(
        this._apiService.updateIssue$(
          issueId,
          { state_event: state === 'closed' ? 'close' : 'reopen' },
          cfg,
        ),
      );
      changes.issueState = state;
      // Mirror the import mapping (isDone = state === 'closed') so Done/Undone
      // columns stay consistent with the issue's lifecycle.
      changes.isDone = state === 'closed';
      return 'applied';
    } catch (err) {
      IssueLog.err('[GitlabBoardSync] issue state update failed', err);
      return 'failed';
    }
  }

  private _notifyOutcome(
    targets: GitlabBoardTargets,
    statusOutcome: ApplyOutcome | null,
    stateOutcome: ApplyOutcome | null,
  ): void {
    // Most actionable message wins: unavailable > failed > success.
    if (statusOutcome === 'unavailable') {
      this._snackService.open({
        type: 'ERROR',
        msg: T.F.GITLAB.S.ISSUE_STATUS_NOT_AVAILABLE,
      });
      return;
    }
    if (statusOutcome === 'failed' || stateOutcome === 'failed') {
      this._snackService.open({ type: 'ERROR', msg: T.F.GITLAB.S.ISSUE_UPDATE_FAILED });
      return;
    }
    if (statusOutcome === 'applied' && targets.statusName) {
      this._snackService.open({
        type: 'SUCCESS',
        msg: T.F.GITLAB.S.ISSUE_STATUS_UPDATED,
        translateParams: { status: targets.statusName },
      });
      return;
    }
    if (stateOutcome === 'applied' && targets.state) {
      this._snackService.open({
        type: 'SUCCESS',
        msg: T.F.GITLAB.S.ISSUE_STATE_UPDATED,
        translateParams: { state: targets.state },
      });
    }
  }
}
