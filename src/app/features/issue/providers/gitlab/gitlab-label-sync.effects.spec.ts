import { TestBed } from '@angular/core/testing';
import { provideMockStore, MockStore } from '@ngrx/store/testing';
import { Subject, of } from 'rxjs';

import { GitlabLabelSyncEffects } from './gitlab-label-sync.effects';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { TaskService } from '../../../tasks/task.service';
import { IssueProviderService } from '../../issue-provider.service';
import { LOCAL_ACTIONS } from '../../../../util/local-actions.token';
import { TaskSharedActions } from '../../../../root-store/meta/task-shared.actions';
import { GITLAB_TYPE } from '../../issue.const';
import { DEFAULT_GITLAB_CFG } from './gitlab.const';
import { IssueProviderGitlab } from '../../issue.model';
import { Task } from '../../../tasks/task.model';
import { createTask } from '../../../tasks/task.test-helper';
import { selectAllTags } from '../../../tag/store/tag.reducer';
import { Tag } from '../../../tag/tag.model';

const PROVIDER_ID = 'gitlab-provider-1';
const TASK_ID = 'task-1';
const ISSUE_ID = 'group/repo#42';

const CFG_ON: IssueProviderGitlab = {
  ...DEFAULT_GITLAB_CFG,
  id: PROVIDER_ID,
  issueProviderKey: 'GITLAB',
  isEnabled: true,
  project: 'group/repo',
  token: 'tok',
  filterUsername: null,
  isSyncLabelsAsTags: true,
};

const makeTaskWithLabels = (
  tagIds: string[],
  lastLabels: string[] | undefined = undefined,
): Task =>
  createTask({
    id: TASK_ID,
    title: '#42',
    issueId: ISSUE_ID,
    issueProviderId: PROVIDER_ID,
    issueType: GITLAB_TYPE,
    tagIds,
    issueLastSyncedValues: lastLabels === undefined ? undefined : { labels: lastLabels },
  });

const dispatchUpdate = (actions$: Subject<unknown>, changes: Partial<Task>): void => {
  actions$.next(TaskSharedActions.updateTask({ task: { id: TASK_ID, changes } }));
};

describe('GitlabLabelSyncEffects', () => {
  let actions$: Subject<unknown>;
  let taskService: jasmine.SpyObj<Pick<TaskService, 'getByIdOnce$' | 'update'>>;
  let issueProviderService: jasmine.SpyObj<IssueProviderService>;
  let gitlabApiService: jasmine.SpyObj<GitlabApiService>;
  let store: MockStore;

  const setupTags = (tags: Tag[]): void => {
    store.overrideSelector(selectAllTags, tags);
    store.refreshState();
  };

  beforeEach(() => {
    actions$ = new Subject();
    taskService = jasmine.createSpyObj<Pick<TaskService, 'getByIdOnce$' | 'update'>>(
      'TaskService',
      ['getByIdOnce$', 'update'],
    );
    issueProviderService = jasmine.createSpyObj<IssueProviderService>(
      'IssueProviderService',
      ['getCfgOnce$'],
    );
    gitlabApiService = jasmine.createSpyObj<GitlabApiService>('GitlabApiService', [
      'updateIssueLabels$',
    ]);
    gitlabApiService.updateIssueLabels$.and.returnValue(of(null));

    TestBed.configureTestingModule({
      providers: [
        GitlabLabelSyncEffects,
        { provide: LOCAL_ACTIONS, useValue: actions$ },
        { provide: TaskService, useValue: taskService },
        { provide: IssueProviderService, useValue: issueProviderService },
        { provide: GitlabApiService, useValue: gitlabApiService },
        provideMockStore({ initialState: {} }),
      ],
    });

    store = TestBed.inject(MockStore);
    setupTags([]);
    // Subscribe to activate the effect stream.
    TestBed.inject(GitlabLabelSyncEffects).syncLabelsOnTaskUpdate$.subscribe();
  });

  it('pushes an add_labels PUT when a new tag is added', async () => {
    setupTags([
      { id: 'tag-bug', title: 'bug', taskIds: [] } as unknown as Tag,
      { id: 'tag-ready', title: 'ready', taskIds: [] } as unknown as Tag,
    ]);
    taskService.getByIdOnce$.and.returnValue(
      of(makeTaskWithLabels(['tag-bug', 'tag-ready'], ['bug'])),
    );
    issueProviderService.getCfgOnce$.and.returnValue(of(CFG_ON));

    dispatchUpdate(actions$, { tagIds: ['tag-bug', 'tag-ready'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(gitlabApiService.updateIssueLabels$).toHaveBeenCalledOnceWith(
      ISSUE_ID,
      ['ready'],
      [],
      CFG_ON,
    );
    expect(taskService.update).toHaveBeenCalledWith(TASK_ID, {
      issueLastSyncedValues: { labels: ['bug', 'ready'] },
    });
  });

  it('pushes a remove_labels PUT when a synced tag is removed', async () => {
    setupTags([{ id: 'tag-bug', title: 'bug', taskIds: [] } as unknown as Tag]);
    taskService.getByIdOnce$.and.returnValue(
      of(makeTaskWithLabels([], ['bug', 'ready'])),
    );
    issueProviderService.getCfgOnce$.and.returnValue(of(CFG_ON));

    dispatchUpdate(actions$, { tagIds: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(gitlabApiService.updateIssueLabels$).toHaveBeenCalledOnceWith(
      ISSUE_ID,
      [],
      ['bug', 'ready'],
      CFG_ON,
    );
  });

  it('does nothing when tagIds is not in the update changes', async () => {
    taskService.getByIdOnce$.and.returnValue(of(makeTaskWithLabels([], ['bug'])));
    issueProviderService.getCfgOnce$.and.returnValue(of(CFG_ON));

    dispatchUpdate(actions$, { title: 'renamed' });
    await new Promise((r) => setTimeout(r, 0));

    expect(gitlabApiService.updateIssueLabels$).not.toHaveBeenCalled();
  });

  it('does nothing when the changes carry issueLastSyncedValues (loop guard)', async () => {
    // Simulates a read-side write bouncing back through updateTask.
    taskService.getByIdOnce$.and.returnValue(of(makeTaskWithLabels([], ['bug'])));
    issueProviderService.getCfgOnce$.and.returnValue(of(CFG_ON));

    dispatchUpdate(actions$, {
      tagIds: [],
      issueLastSyncedValues: { labels: [] },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(gitlabApiService.updateIssueLabels$).not.toHaveBeenCalled();
  });

  it('is a no-op when isSyncLabelsAsTags is off', async () => {
    setupTags([{ id: 'tag-bug', title: 'bug', taskIds: [] } as unknown as Tag]);
    taskService.getByIdOnce$.and.returnValue(of(makeTaskWithLabels(['tag-bug'], [])));
    issueProviderService.getCfgOnce$.and.returnValue(
      of({ ...CFG_ON, isSyncLabelsAsTags: false }),
    );

    dispatchUpdate(actions$, { tagIds: ['tag-bug'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(gitlabApiService.updateIssueLabels$).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing actually differs from the last known labels', async () => {
    setupTags([{ id: 'tag-bug', title: 'bug', taskIds: [] } as unknown as Tag]);
    taskService.getByIdOnce$.and.returnValue(
      of(makeTaskWithLabels(['tag-bug'], ['bug'])),
    );
    issueProviderService.getCfgOnce$.and.returnValue(of(CFG_ON));

    dispatchUpdate(actions$, { tagIds: ['tag-bug'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(gitlabApiService.updateIssueLabels$).not.toHaveBeenCalled();
    expect(taskService.update).not.toHaveBeenCalled();
  });

  it('does not push for non-GitLab tasks', async () => {
    setupTags([{ id: 'tag-bug', title: 'bug', taskIds: [] } as unknown as Tag]);
    taskService.getByIdOnce$.and.returnValue(
      of({
        ...makeTaskWithLabels(['tag-bug'], []),
        issueType: 'CALDAV',
      } as unknown as Task),
    );
    issueProviderService.getCfgOnce$.and.returnValue(of(CFG_ON));

    dispatchUpdate(actions$, { tagIds: ['tag-bug'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(gitlabApiService.updateIssueLabels$).not.toHaveBeenCalled();
  });
});
