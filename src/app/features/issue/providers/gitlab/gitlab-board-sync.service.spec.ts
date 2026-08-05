import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { GitlabBoardSyncService } from './gitlab-board-sync.service';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { IssueProviderService } from '../../issue-provider.service';
import { IssueService } from '../../issue.service';
import { TaskService } from '../../../tasks/task.service';
import { SnackService } from '../../../../core/snack/snack.service';
import { Task } from '../../../tasks/task.model';
import { GITLAB_TYPE, GITHUB_TYPE } from '../../issue.const';

const mkTask = (partial: Partial<Task> = {}): Task =>
  ({
    id: 't1',
    issueType: GITLAB_TYPE,
    issueId: 'group/project#42',
    issueProviderId: 'ip1',
    ...partial,
  }) as Task;

describe('GitlabBoardSyncService', () => {
  let service: GitlabBoardSyncService;
  let apiService: jasmine.SpyObj<GitlabApiService>;
  let graphqlApiService: jasmine.SpyObj<GitlabGraphqlApiService>;
  let issueProviderService: jasmine.SpyObj<IssueProviderService>;
  let issueService: jasmine.SpyObj<IssueService>;
  let taskService: jasmine.SpyObj<TaskService>;
  let snackService: jasmine.SpyObj<SnackService>;

  beforeEach(() => {
    apiService = jasmine.createSpyObj('GitlabApiService', ['updateIssue$']);
    graphqlApiService = jasmine.createSpyObj('GitlabGraphqlApiService', [
      'isAvailable',
      'applyStatusByName',
    ]);
    issueProviderService = jasmine.createSpyObj('IssueProviderService', ['getCfgOnce$']);
    issueService = jasmine.createSpyObj('IssueService', ['reloadIssueDataForOpenViews']);
    taskService = jasmine.createSpyObj('TaskService', ['update']);
    snackService = jasmine.createSpyObj('SnackService', ['open']);

    issueService.reloadIssueDataForOpenViews.and.resolveTo(undefined);
    issueProviderService.getCfgOnce$.and.returnValue(of({} as any));
    apiService.updateIssue$.and.returnValue(of({} as any));
    graphqlApiService.isAvailable.and.returnValue(true);
    graphqlApiService.applyStatusByName.and.resolveTo(true);

    TestBed.configureTestingModule({
      providers: [
        GitlabBoardSyncService,
        { provide: GitlabApiService, useValue: apiService },
        { provide: GitlabGraphqlApiService, useValue: graphqlApiService },
        { provide: IssueProviderService, useValue: issueProviderService },
        { provide: IssueService, useValue: issueService },
        { provide: TaskService, useValue: taskService },
        { provide: SnackService, useValue: snackService },
      ],
    });
    service = TestBed.inject(GitlabBoardSyncService);
  });

  it('no-ops for a non-GitLab task', async () => {
    await service.applyPanelTargets(mkTask({ issueType: GITHUB_TYPE }), {
      state: 'closed',
    });
    expect(apiService.updateIssue$).not.toHaveBeenCalled();
    expect(taskService.update).not.toHaveBeenCalled();
  });

  it('no-ops when there is nothing to apply', async () => {
    await service.applyPanelTargets(mkTask(), {});
    expect(apiService.updateIssue$).not.toHaveBeenCalled();
    expect(taskService.update).not.toHaveBeenCalled();
  });

  it('closes the issue and mirrors state + isDone onto the task', async () => {
    await service.applyPanelTargets(mkTask(), { state: 'closed' });
    expect(apiService.updateIssue$).toHaveBeenCalledWith(
      'group/project#42',
      { state_event: 'close' },
      jasmine.anything(),
    );
    expect(taskService.update).toHaveBeenCalledWith('t1', {
      issueState: 'closed',
      isDone: true,
    });
  });

  it('reopens the issue (state "open" -> reopen, isDone false)', async () => {
    await service.applyPanelTargets(mkTask(), { state: 'open' });
    expect(apiService.updateIssue$).toHaveBeenCalledWith(
      'group/project#42',
      { state_event: 'reopen' },
      jasmine.anything(),
    );
    expect(taskService.update).toHaveBeenCalledWith('t1', {
      issueState: 'open',
      isDone: false,
    });
  });

  it('applies a custom status via GraphQL and mirrors it onto the task', async () => {
    await service.applyPanelTargets(mkTask(), { statusName: 'In progress' });
    expect(graphqlApiService.applyStatusByName).toHaveBeenCalledWith(
      'group/project#42',
      'group/project',
      'In progress',
      jasmine.anything(),
    );
    expect(taskService.update).toHaveBeenCalledWith('t1', { issueStatus: 'In progress' });
  });

  it('applies status even when isAvailable(cfg) is false (group/all-assigned scope)', async () => {
    // Regression: the board-sync must NOT gate on isAvailable(cfg) — that
    // checks cfg.project, which is null for group/all-assigned providers, even
    // though applyStatusByName resolves the project from the issue's own path.
    graphqlApiService.isAvailable.and.returnValue(false);
    await service.applyPanelTargets(mkTask(), { statusName: 'In progress' });
    expect(graphqlApiService.applyStatusByName).toHaveBeenCalledWith(
      'group/project#42',
      'group/project',
      'In progress',
      jasmine.anything(),
    );
    expect(taskService.update).toHaveBeenCalledWith('t1', { issueStatus: 'In progress' });
  });

  it('does not mirror status when no allowed status matched', async () => {
    graphqlApiService.applyStatusByName.and.resolveTo(false);
    await service.applyPanelTargets(mkTask(), { statusName: 'Nonexistent' });
    expect(taskService.update).not.toHaveBeenCalled();
  });

  it('applies both status and state in one drop', async () => {
    await service.applyPanelTargets(mkTask(), {
      statusName: 'In progress',
      state: 'closed',
    });
    expect(taskService.update).toHaveBeenCalledWith('t1', {
      issueStatus: 'In progress',
      issueState: 'closed',
      isDone: true,
    });
  });

  it('surfaces a snackbar and leaves the task unchanged when the state write throws', async () => {
    apiService.updateIssue$.and.throwError('boom');
    await service.applyPanelTargets(mkTask(), { state: 'closed' });
    expect(snackService.open).toHaveBeenCalled();
    expect(taskService.update).not.toHaveBeenCalled();
  });

  it('refreshes an open issue panel after a successful apply', async () => {
    await service.applyPanelTargets(mkTask(), { state: 'closed' });
    expect(issueService.reloadIssueDataForOpenViews).toHaveBeenCalled();
  });

  it('does not refresh the panel when nothing was applied', async () => {
    apiService.updateIssue$.and.throwError('boom');
    await service.applyPanelTargets(mkTask(), { state: 'closed' });
    expect(issueService.reloadIssueDataForOpenViews).not.toHaveBeenCalled();
  });
});
