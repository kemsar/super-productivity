import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { GitlabCommonInterfacesService } from './gitlab-common-interfaces.service';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { IssueProviderService } from '../../issue-provider.service';
import { DEFAULT_GITLAB_CFG, GITLAB_POLL_INTERVAL } from './gitlab.const';
import { GitlabCfg } from './gitlab.model';
import { GitlabIssue } from './gitlab-issue.model';
import {
  GitlabOriginalComment,
  GitlabOriginalUser,
} from './gitlab-api/gitlab-api-responses';
import { createTask } from '../../../tasks/task.test-helper';
import { Task } from '../../../tasks/task.model';
import { IssueProviderGitlab } from '../../issue.model';
import { TagService } from '../../../tag/tag.service';
import { signal, WritableSignal } from '@angular/core';
import { Tag } from '../../../tag/tag.model';
import { MenuTreeService } from '../../../menu-tree/menu-tree.service';
import { MenuTreeKind, MenuTreeTreeNode } from '../../../menu-tree/store/menu-tree.model';

const ISSUE_PROVIDER_ID = 'gitlab-provider-1';
const ISSUE_ID = 'project/repo#42';
const ISSUE_BODY = 'body';
const BASE_UPDATED_AT = '2026-01-08T03:29:14.653Z';
const LATER_COMMENT_AT = '2026-01-08T03:29:14.717Z';
const NEWER_UPDATED_AT = '2026-01-08T03:30:00.000Z';

const BASE_CFG: IssueProviderGitlab = {
  ...DEFAULT_GITLAB_CFG,
  id: ISSUE_PROVIDER_ID,
  issueProviderKey: 'GITLAB',
  isEnabled: true,
  project: 'project/repo',
  token: 'token',
  filterUsername: 'current-user',
};

const USER: GitlabOriginalUser = {
  id: 1,
  username: 'another-user',
  name: 'Another User',
  state: 'active',
  avatar_url: '',
  web_url: '',
};

const makeComment = (createdAt: string, body = 'comment'): GitlabOriginalComment => ({
  id: 1,
  body,
  attachment: '',
  author: USER,
  created_at: createdAt,
  updated_at: createdAt,
  system: false,
  noteable_id: 42,
  noteable_type: 'Issue',
  noteable_iid: 42,
  resolvable: false,
});

const makeIssue = (
  updatedAt: string,
  comments: GitlabOriginalComment[] = [],
  body = ISSUE_BODY,
): GitlabIssue => ({
  html_url: 'https://gitlab.example.com/project/repo/-/issues/42',
  number: 42,
  state: 'open',
  title: 'GitLab issue',
  body,
  user: USER,
  labels: [],
  assignee: USER,
  milestone: {
    id: 1,
    iid: 1,
    project_id: 1,
    title: 'milestone',
    description: '',
    start_date: '',
    due_date: '',
    state: 'active',
    created_at: updatedAt,
    updated_at: updatedAt,
  },
  closed_at: '',
  created_at: '2026-01-08T03:00:00.000Z',
  updated_at: updatedAt,
  wasUpdated: false,
  commentsNr: comments.length,
  comments,
  url: 'https://gitlab.example.com/project/repo/-/issues/42',
  id: ISSUE_ID,
  links: {
    self: 'https://gitlab.example.com/api/v4/projects/1/issues/42',
    notes: 'https://gitlab.example.com/api/v4/projects/1/issues/42/notes',
    award_emoji: 'https://gitlab.example.com/api/v4/projects/1/issues/42/award_emoji',
    project: 'https://gitlab.example.com/api/v4/projects/1',
  },
});

const makeTask = (issueLastUpdated: number): Task =>
  createTask({
    id: 'task-1',
    title: '#42 GitLab issue',
    issueId: ISSUE_ID,
    issueProviderId: ISSUE_PROVIDER_ID,
    issueType: 'GITLAB',
    issueLastUpdated,
    issueWasUpdated: false,
    // Already-backfilled snapshot + two-way-sync baseline (both match
    // makeIssue's 'open' state) so neither the board snapshot backfill (#19)
    // nor the state-baseline backfill (#26) fires in the general refresh specs.
    issueState: 'open',
    issueLastSyncedValues: { state: 'open' },
  });

describe('GitlabCommonInterfacesService', () => {
  let service: GitlabCommonInterfacesService;
  let gitlabApiService: jasmine.SpyObj<GitlabApiService>;
  let gitlabGraphqlApiService: jasmine.SpyObj<GitlabGraphqlApiService>;
  let issueProviderService: jasmine.SpyObj<IssueProviderService>;
  let tagServiceStub: {
    tags: ReturnType<typeof signal<Tag[]>>;
    addTag: jasmine.Spy<(tag: Partial<Tag>) => string>;
  };
  let menuTreeStub: {
    tagTree: WritableSignal<MenuTreeTreeNode[]>;
    setTagTree: jasmine.Spy<(next: MenuTreeTreeNode[]) => void>;
  };
  let tagIdCounter: number;

  beforeEach(() => {
    gitlabApiService = jasmine.createSpyObj('GitlabApiService', [
      'getById$',
      'searchIssueInProject$',
      'getProjectIssues$',
    ]);
    gitlabGraphqlApiService = jasmine.createSpyObj('GitlabGraphqlApiService', [
      'isAvailable',
      'getById$',
      'searchIssueInProject$',
      'getProjectIssues$',
    ]);
    // Default: GraphQL disabled so existing behavior specs exercise REST unchanged.
    gitlabGraphqlApiService.isAvailable.and.returnValue(false);
    issueProviderService = jasmine.createSpyObj('IssueProviderService', ['getCfgOnce$']);
    issueProviderService.getCfgOnce$.and.returnValue(of(BASE_CFG));
    tagIdCounter = 0;
    // TagService.tags is a computed signal on the real service, so a plain
    // spy method won't satisfy the Signal<> shape. A writable signal-backed
    // stub is enough for the label→tag helpers used by the read side.
    const tagTreeState = signal<MenuTreeTreeNode[]>([]);
    tagServiceStub = {
      tags: signal<Tag[]>([]),
      addTag: jasmine
        .createSpy<(tag: Partial<Tag>) => string>('addTag')
        .and.callFake((tag) => {
          const id = `tag-${++tagIdCounter}`;
          tagServiceStub.tags.update((prev) => [
            ...prev,
            { id, title: tag.title ?? '', taskIds: [] } as unknown as Tag,
          ]);
          // Mirror the real addTag reducer: newly-added tag lands at the
          // root of the tag tree. The GitLab folder placement then strips
          // it from root and moves it into the folder.
          tagTreeState.update((prev) => [...prev, { k: MenuTreeKind.TAG, id }]);
          return id;
        }),
    };
    menuTreeStub = {
      tagTree: tagTreeState,
      setTagTree: jasmine
        .createSpy<(next: MenuTreeTreeNode[]) => void>('setTagTree')
        .and.callFake((next) => tagTreeState.set(next)),
    };

    TestBed.configureTestingModule({
      providers: [
        GitlabCommonInterfacesService,
        { provide: GitlabApiService, useValue: gitlabApiService },
        { provide: GitlabGraphqlApiService, useValue: gitlabGraphqlApiService },
        { provide: IssueProviderService, useValue: issueProviderService },
        { provide: TagService, useValue: tagServiceStub },
        { provide: MenuTreeService, useValue: menuTreeStub },
      ],
    });
    service = TestBed.inject(GitlabCommonInterfacesService);
  });

  describe('pollInterval', () => {
    it('falls back to GITLAB_POLL_INTERVAL when pollIntervalMinutes is unset', () => {
      expect(service.pollInterval).toBe(GITLAB_POLL_INTERVAL);
    });

    it('derives from cfg.pollIntervalMinutes when set', () => {
      (service as unknown as { _cachedCfg?: GitlabCfg })._cachedCfg = {
        ...BASE_CFG,
        pollIntervalMinutes: 2,
      };
      expect(service.pollInterval).toBe(2 * 60 * 1000);
    });

    it('caches cfg via _getCfgOnce$ so poll timer reads the effective interval', async () => {
      issueProviderService.getCfgOnce$.and.returnValue(
        of({ ...BASE_CFG, pollIntervalMinutes: 1 }),
      );
      gitlabApiService.getProjectIssues$.and.returnValue(of([]));

      await service.getNewIssuesToAddToBacklog(ISSUE_PROVIDER_ID, []);

      expect(service.pollInterval).toBe(60 * 1000);
    });
  });

  describe('isEnabled', () => {
    // Every source mode has its own "the minimum config required to actually
    // poll" — miswiring this would either enable a provider that will 401 on
    // every poll (all-assigned without a token) or silently disable a valid
    // group config that lacks a legacy `project` value.
    it('requires project when sourceMode is undefined (legacy back-compat)', () => {
      expect(service.isEnabled({ ...BASE_CFG, sourceMode: undefined })).toBe(true);
      expect(
        service.isEnabled({ ...BASE_CFG, sourceMode: undefined, project: null }),
      ).toBe(false);
    });

    it('requires group when sourceMode is group', () => {
      expect(
        service.isEnabled({
          ...BASE_CFG,
          sourceMode: 'group',
          project: null,
          group: 'my-org',
        }),
      ).toBe(true);
      expect(
        service.isEnabled({
          ...BASE_CFG,
          sourceMode: 'group',
          project: null,
          group: null,
        }),
      ).toBe(false);
    });

    it('requires a token when sourceMode is all-assigned', () => {
      expect(
        service.isEnabled({
          ...BASE_CFG,
          sourceMode: 'all-assigned',
          project: null,
          token: 'token',
        }),
      ).toBe(true);
      expect(
        service.isEnabled({
          ...BASE_CFG,
          sourceMode: 'all-assigned',
          project: null,
          token: null,
        }),
      ).toBe(false);
    });

    it('is disabled when the provider itself is turned off', () => {
      expect(service.isEnabled({ ...BASE_CFG, isEnabled: false })).toBe(false);
    });
  });

  describe('issueLink', () => {
    it('derives the project from the issue id in group / all-assigned mode', async () => {
      // In multi-project modes cfg.project is empty; without deriving it from
      // the issue id, every generated link would be broken.
      issueProviderService.getCfgOnce$.and.returnValue(
        of({
          ...BASE_CFG,
          sourceMode: 'group',
          project: null,
          group: 'universityofcolorado/uis',
          gitlabBaseUrl: 'https://gitlab.example.com',
        }),
      );

      const link = await service.issueLink(
        'universityofcolorado/uis/foo#42',
        ISSUE_PROVIDER_ID,
      );
      expect(link).toBe(
        'https://gitlab.example.com/universityofcolorado/uis/foo/-/issues/42',
      );
    });
  });

  describe('getAddTaskData (issue state/status snapshots)', () => {
    it('persists issue state and custom work-item status onto the task', () => {
      const issue: GitlabIssue = {
        ...makeIssue(BASE_UPDATED_AT),
        state: 'closed',
        status: { name: 'In progress', category: 'IN_PROGRESS' },
      };
      const out = service.getAddTaskData(issue);
      expect(out.issueState).toBe('closed');
      expect(out.issueStatus).toBe('In progress');
      expect(out.isDone).toBe(true);
    });

    it('leaves issueStatus undefined when the status widget is absent', () => {
      const out = service.getAddTaskData(makeIssue(BASE_UPDATED_AT));
      expect(out.issueState).toBe('open');
      expect(out.issueStatus).toBeUndefined();
    });
  });

  describe('getFreshDataForIssueTask', () => {
    it('does not flag an update when only a GitLab comment timestamp is later than issue.updated_at', async () => {
      const issueLastUpdated = new Date(BASE_UPDATED_AT).getTime();
      gitlabApiService.getById$.and.returnValue(
        of(makeIssue(BASE_UPDATED_AT, [makeComment(LATER_COMMENT_AT)])),
      );

      const result = await service.getFreshDataForIssueTask(makeTask(issueLastUpdated));

      expect(result).toBeNull();
    });

    it('does not flag an update from a later comment after the user marked updates as read', async () => {
      const issueLastUpdated = new Date(LATER_COMMENT_AT).getTime();
      gitlabApiService.getById$.and.returnValue(
        of(makeIssue(BASE_UPDATED_AT, [makeComment(LATER_COMMENT_AT)])),
      );

      const result = await service.getFreshDataForIssueTask(makeTask(issueLastUpdated));

      expect(result).toBeNull();
    });

    it('backfills the state/status snapshot for a pre-existing task without flagging an update', async () => {
      const issueLastUpdated = new Date(BASE_UPDATED_AT).getTime();
      // Simulate a task imported before the snapshot existed.
      const task = {
        ...makeTask(issueLastUpdated),
        issueState: undefined,
        issueStatus: undefined,
      } as Task;
      gitlabApiService.getById$.and.returnValue(
        of({
          ...makeIssue(BASE_UPDATED_AT),
          state: 'closed',
          status: { name: 'In progress', category: 'IN_PROGRESS' },
        } as GitlabIssue),
      );

      const result = await service.getFreshDataForIssueTask(task);

      expect(result?.taskChanges.issueState).toBe('closed');
      expect(result?.taskChanges.issueStatus).toBe('In progress');
      // A backfill must not masquerade as a remote content update.
      expect(result?.taskChanges.issueWasUpdated).toBeUndefined();
    });

    it('backfills the two-way-sync state baseline for a task missing it (#26)', async () => {
      const issueLastUpdated = new Date(BASE_UPDATED_AT).getTime();
      // Pre-existing task: has the board snapshot but no `state` baseline, so
      // completing it would never push a close until the baseline is stamped.
      const task = {
        ...makeTask(issueLastUpdated),
        issueLastSyncedValues: undefined,
      } as unknown as Task;
      gitlabApiService.getById$.and.returnValue(of(makeIssue(BASE_UPDATED_AT)));

      const result = await service.getFreshDataForIssueTask(task);

      expect(
        (result?.taskChanges.issueLastSyncedValues as { state?: string })?.state,
      ).toBe('open');
      // Baseline backfill is bookkeeping, not a user-facing remote change.
      expect(result?.taskChanges.issueWasUpdated).toBeUndefined();
    });

    it('does not re-fetch to backfill once the snapshot is present and unchanged', async () => {
      const issueLastUpdated = new Date(BASE_UPDATED_AT).getTime();
      gitlabApiService.getById$.and.returnValue(of(makeIssue(BASE_UPDATED_AT)));

      // makeTask already carries issueState: 'open', matching the issue.
      const result = await service.getFreshDataForIssueTask(makeTask(issueLastUpdated));

      expect(result).toBeNull();
      // Only the base fetch — no extra backfill round-trip.
      expect(gitlabApiService.getById$).toHaveBeenCalledTimes(1);
    });

    it('flags a new GitLab comment as an update when issue.updated_at is bumped', async () => {
      const issueLastUpdated = new Date(BASE_UPDATED_AT).getTime();
      gitlabApiService.getById$.and.returnValue(
        of(makeIssue(NEWER_UPDATED_AT, [makeComment(NEWER_UPDATED_AT, 'new comment')])),
      );

      const result = await service.getFreshDataForIssueTask(makeTask(issueLastUpdated));

      expect(result?.taskChanges.issueWasUpdated).toBe(true);
      expect(result?.taskChanges.issueLastUpdated).toBe(
        new Date(NEWER_UPDATED_AT).getTime(),
      );
      const issue = result?.issue as GitlabIssue;
      expect(issue.body).toBe(ISSUE_BODY);
      expect(issue.commentsNr).toBe(1);
      expect(result?.issueTitle).toBe('#42 GitLab issue');
    });
  });

  describe('GraphQL fallback', () => {
    it('prefers GraphQL when available for getById', async () => {
      gitlabGraphqlApiService.isAvailable.and.returnValue(true);
      const gqlIssue = makeIssue(NEWER_UPDATED_AT);
      gitlabGraphqlApiService.getById$.and.returnValue(of(gqlIssue));

      const result = await service.getFreshDataForIssueTask(
        makeTask(new Date(BASE_UPDATED_AT).getTime()),
      );

      expect(gitlabGraphqlApiService.getById$).toHaveBeenCalled();
      expect(gitlabApiService.getById$).not.toHaveBeenCalled();
      expect(result?.taskChanges.issueWasUpdated).toBe(true);
    });

    it('falls back to REST when GraphQL errors', async () => {
      gitlabGraphqlApiService.isAvailable.and.returnValue(true);
      gitlabGraphqlApiService.getById$.and.returnValue(
        throwError(() => new Error('nope')),
      );
      const restIssue = makeIssue(NEWER_UPDATED_AT);
      gitlabApiService.getById$.and.returnValue(of(restIssue));

      const result = await service.getFreshDataForIssueTask(
        makeTask(new Date(BASE_UPDATED_AT).getTime()),
      );

      expect(gitlabGraphqlApiService.getById$).toHaveBeenCalled();
      expect(gitlabApiService.getById$).toHaveBeenCalled();
      expect(result?.taskChanges.issueWasUpdated).toBe(true);
    });

    it('prefers GraphQL for a group/all-assigned provider even when isAvailable is false', async () => {
      // A group/all-assigned provider has isAvailable=false (null cfg.project),
      // but single-issue GraphQL resolves the project from the issue id's own
      // path — and it's the only path that returns the custom Status widget.
      gitlabGraphqlApiService.isAvailable.and.returnValue(false);
      issueProviderService.getCfgOnce$.and.returnValue(
        of({ ...BASE_CFG, project: null, group: 'grp/sub', sourceMode: 'group' } as any),
      );
      gitlabGraphqlApiService.getById$.and.returnValue(of(makeIssue(NEWER_UPDATED_AT)));

      const result = await service.getFreshDataForIssueTask(
        makeTask(new Date(BASE_UPDATED_AT).getTime()),
      );

      expect(gitlabGraphqlApiService.getById$).toHaveBeenCalled();
      expect(gitlabApiService.getById$).not.toHaveBeenCalled();
      expect(result?.taskChanges.issueWasUpdated).toBe(true);
    });

    it('keeps project-mode providers on REST when isAvailable is false', async () => {
      // BASE_CFG has cfg.project set — the group-mode extension must NOT apply,
      // so a disabled GraphQL endpoint still degrades to REST as before.
      gitlabGraphqlApiService.isAvailable.and.returnValue(false);
      gitlabApiService.getById$.and.returnValue(of(makeIssue(NEWER_UPDATED_AT)));

      await service.getFreshDataForIssueTask(
        makeTask(new Date(BASE_UPDATED_AT).getTime()),
      );

      expect(gitlabGraphqlApiService.getById$).not.toHaveBeenCalled();
      expect(gitlabApiService.getById$).toHaveBeenCalled();
    });

    it('uses REST for a group provider when the issue id project is numeric', async () => {
      gitlabGraphqlApiService.isAvailable.and.returnValue(false);
      issueProviderService.getCfgOnce$.and.returnValue(
        of({ ...BASE_CFG, project: null, sourceMode: 'group' } as any),
      );
      gitlabApiService.getById$.and.returnValue(of(makeIssue(NEWER_UPDATED_AT)));
      const task = {
        ...makeTask(new Date(BASE_UPDATED_AT).getTime()),
        issueId: '12345#42',
      } as Task;

      await service.getFreshDataForIssueTask(task);

      expect(gitlabGraphqlApiService.getById$).not.toHaveBeenCalled();
      expect(gitlabApiService.getById$).toHaveBeenCalled();
    });

    it('uses REST for a group provider that has a raw filter', async () => {
      gitlabGraphqlApiService.isAvailable.and.returnValue(false);
      issueProviderService.getCfgOnce$.and.returnValue(
        of({ ...BASE_CFG, project: null, filter: 'labels=bug' } as any),
      );
      gitlabApiService.getById$.and.returnValue(of(makeIssue(NEWER_UPDATED_AT)));

      await service.getFreshDataForIssueTask(
        makeTask(new Date(BASE_UPDATED_AT).getTime()),
      );

      expect(gitlabGraphqlApiService.getById$).not.toHaveBeenCalled();
      expect(gitlabApiService.getById$).toHaveBeenCalled();
    });
  });

  describe('label sync (issue #14)', () => {
    const cfgWithLabelSync: IssueProviderGitlab = {
      ...BASE_CFG,
      isSyncLabelsAsTags: true,
    };
    const makeIssueWithLabels = (updatedAt: string, labels: string[]): GitlabIssue => ({
      ...makeIssue(updatedAt),
      labels,
    });

    describe('getAddTaskDataForCfg', () => {
      it('stamps the state baseline (no labels) when isSyncLabelsAsTags is off', () => {
        const result = service.getAddTaskDataForCfg(
          makeIssueWithLabels(BASE_UPDATED_AT, ['bug', 'ready']),
          { ...BASE_CFG, isSyncLabelsAsTags: false },
        );
        expect(result.tagIds).toBeUndefined();
        // The two-way-sync `state` baseline is stamped regardless of label sync
        // so "complete task → close issue" has a baseline to push (issue #26).
        expect(result.issueLastSyncedValues).toEqual({ state: 'open' });
      });

      it('creates SP tags for issue labels and stamps issueLastSyncedValues', () => {
        const result = service.getAddTaskDataForCfg(
          makeIssueWithLabels(BASE_UPDATED_AT, ['bug', 'ready']),
          cfgWithLabelSync,
        );
        expect(result.tagIds).toHaveSize(2);
        expect(tagServiceStub.addTag).toHaveBeenCalledWith({ title: 'bug' });
        expect(tagServiceStub.addTag).toHaveBeenCalledWith({ title: 'ready' });
        expect((result.issueLastSyncedValues as { labels: string[] }).labels).toEqual([
          'bug',
          'ready',
        ]);
      });

      it('reuses existing SP tags with matching titles (case-insensitive)', () => {
        tagServiceStub.tags.set([
          { id: 'preexisting', title: 'Bug', taskIds: [] } as unknown as Tag,
        ]);
        const result = service.getAddTaskDataForCfg(
          makeIssueWithLabels(BASE_UPDATED_AT, ['bug']),
          cfgWithLabelSync,
        );
        expect(result.tagIds).toEqual(['preexisting']);
        expect(tagServiceStub.addTag).not.toHaveBeenCalled();
      });
    });

    describe('getFreshDataForIssueTask', () => {
      it('projects remote labels onto tagIds and stamps last-synced labels', async () => {
        issueProviderService.getCfgOnce$.and.returnValue(of(cfgWithLabelSync));
        gitlabApiService.getById$.and.returnValue(
          of(makeIssueWithLabels(NEWER_UPDATED_AT, ['bug'])),
        );

        const result = await service.getFreshDataForIssueTask(
          makeTask(new Date(BASE_UPDATED_AT).getTime()),
        );

        expect(result?.taskChanges.tagIds).toHaveSize(1);
        expect(
          (result?.taskChanges.issueLastSyncedValues as { labels: string[] })?.labels,
        ).toEqual(['bug']);
      });

      it('is a no-op when labels are unchanged and updated_at is unchanged', async () => {
        issueProviderService.getCfgOnce$.and.returnValue(of(cfgWithLabelSync));
        gitlabApiService.getById$.and.returnValue(
          of(makeIssueWithLabels(BASE_UPDATED_AT, ['bug'])),
        );
        const task: Task = {
          ...makeTask(new Date(BASE_UPDATED_AT).getTime()),
          issueLastSyncedValues: { labels: ['bug'], state: 'open' },
        };

        const result = await service.getFreshDataForIssueTask(task);

        expect(result).toBeNull();
      });

      it('detects label-only changes even when updated_at has not advanced', async () => {
        issueProviderService.getCfgOnce$.and.returnValue(of(cfgWithLabelSync));
        gitlabApiService.getById$.and.returnValue(
          of(makeIssueWithLabels(BASE_UPDATED_AT, ['bug', 'ready'])),
        );
        const task: Task = {
          ...makeTask(new Date(BASE_UPDATED_AT).getTime()),
          issueLastSyncedValues: { labels: ['bug'] },
        };

        const result = await service.getFreshDataForIssueTask(task);

        expect(result).not.toBeNull();
        expect(
          (result?.taskChanges.issueLastSyncedValues as { labels: string[] })?.labels,
        ).toEqual(['bug', 'ready']);
      });

      it('preserves user-added tags that do not correspond to any label', async () => {
        tagServiceStub.tags.set([
          { id: 'user-tag', title: 'personal', taskIds: [] } as unknown as Tag,
          { id: 'bug-tag', title: 'bug', taskIds: [] } as unknown as Tag,
        ]);
        issueProviderService.getCfgOnce$.and.returnValue(of(cfgWithLabelSync));
        gitlabApiService.getById$.and.returnValue(
          of(makeIssueWithLabels(NEWER_UPDATED_AT, ['bug'])),
        );
        const task: Task = {
          ...makeTask(new Date(BASE_UPDATED_AT).getTime()),
          tagIds: ['user-tag'],
          issueLastSyncedValues: { labels: [] },
        };

        const result = await service.getFreshDataForIssueTask(task);

        expect(result?.taskChanges.tagIds).toContain('user-tag');
        expect(result?.taskChanges.tagIds).toContain('bug-tag');
      });

      it('drops tag ids that came from labels no longer on the remote issue', async () => {
        tagServiceStub.tags.set([
          { id: 'old-label-tag', title: 'in-progress', taskIds: [] } as unknown as Tag,
          { id: 'kept-user-tag', title: 'personal', taskIds: [] } as unknown as Tag,
          { id: 'new-label-tag', title: 'done', taskIds: [] } as unknown as Tag,
        ]);
        issueProviderService.getCfgOnce$.and.returnValue(of(cfgWithLabelSync));
        gitlabApiService.getById$.and.returnValue(
          of(makeIssueWithLabels(NEWER_UPDATED_AT, ['done'])),
        );
        const task: Task = {
          ...makeTask(new Date(BASE_UPDATED_AT).getTime()),
          tagIds: ['old-label-tag', 'kept-user-tag'],
          issueLastSyncedValues: { labels: ['in-progress'] },
        };

        const result = await service.getFreshDataForIssueTask(task);

        expect(result?.taskChanges.tagIds).toEqual(['kept-user-tag', 'new-label-tag']);
      });

      it('leaves the base behaviour untouched when the flag is off', async () => {
        issueProviderService.getCfgOnce$.and.returnValue(of(BASE_CFG));
        gitlabApiService.getById$.and.returnValue(
          of(makeIssueWithLabels(NEWER_UPDATED_AT, ['bug'])),
        );

        const result = await service.getFreshDataForIssueTask(
          makeTask(new Date(BASE_UPDATED_AT).getTime()),
        );

        // Base did update (updated_at advanced), but no tagIds mutations.
        expect(result?.taskChanges.tagIds).toBeUndefined();
        expect(result?.taskChanges.issueLastSyncedValues).toBeUndefined();
      });
    });

    describe('GitLab tag folder placement (issue #15)', () => {
      const findFolder = (
        tree: MenuTreeTreeNode[],
        name: string,
      ): MenuTreeTreeNode | null =>
        tree.find((n) => n.k === MenuTreeKind.FOLDER && n.name === name) ?? null;

      it('creates a "GitLab" folder and moves new label-tags into it', () => {
        service.getAddTaskDataForCfg(
          makeIssueWithLabels(BASE_UPDATED_AT, ['bug', 'ready']),
          cfgWithLabelSync,
        );

        const finalTree = menuTreeStub.tagTree();
        const folder = findFolder(finalTree, 'GitLab');
        expect(folder).not.toBeNull();
        expect((folder as { children: unknown[] }).children).toHaveSize(2);
        // No stray tag nodes at the root — they should all be inside the folder.
        expect(finalTree.some((n) => n.k === MenuTreeKind.TAG)).toBe(false);
      });

      it('reuses an existing GitLab folder rather than creating a duplicate', () => {
        menuTreeStub.tagTree.set([
          {
            k: MenuTreeKind.FOLDER,
            id: 'existing-folder-id',
            name: 'GitLab',
            isExpanded: true,
            children: [],
          },
        ]);
        service.getAddTaskDataForCfg(
          makeIssueWithLabels(BASE_UPDATED_AT, ['bug']),
          cfgWithLabelSync,
        );

        const finalTree = menuTreeStub.tagTree();
        const folders = finalTree.filter(
          (n) => n.k === MenuTreeKind.FOLDER && n.name === 'GitLab',
        );
        expect(folders).toHaveSize(1);
        expect(folders[0].id).toBe('existing-folder-id');
      });

      it('does not move pre-existing SP tags that happened to match a label', () => {
        // User's "personal" tag lives at root — a label of the same name
        // shouldn't yank it into the GitLab folder.
        tagServiceStub.tags.set([
          { id: 'user-bug', title: 'bug', taskIds: [] } as unknown as Tag,
        ]);
        menuTreeStub.tagTree.set([{ k: MenuTreeKind.TAG, id: 'user-bug' }]);

        service.getAddTaskDataForCfg(
          makeIssueWithLabels(BASE_UPDATED_AT, ['bug']),
          cfgWithLabelSync,
        );

        // No GitLab folder was created because no new tag was needed.
        expect(findFolder(menuTreeStub.tagTree(), 'GitLab')).toBeNull();
        // User's tag stayed at root.
        expect(menuTreeStub.tagTree()).toEqual([{ k: MenuTreeKind.TAG, id: 'user-bug' }]);
      });
    });
  });

  describe('getAddTaskDataForCfg (tree-import routing, #10)', () => {
    it('leaves projectId unset when the cfg has no tree-import mapping', () => {
      const result = service.getAddTaskDataForCfg(makeIssue(BASE_UPDATED_AT), BASE_CFG);
      expect(result.projectId).toBeUndefined();
    });

    it('routes issues to the mapped SP project when the mapping matches', () => {
      const cfgWithMapping: GitlabCfg = {
        ...BASE_CFG,
        sourceMode: 'group',
        group: 'project',
        treeImportMapping: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'project/repo': { spProjectId: 'sp-project-x', gitlabProjectId: 1 },
        },
      };
      const result = service.getAddTaskDataForCfg(
        makeIssue(BASE_UPDATED_AT),
        cfgWithMapping,
      );
      expect(result.projectId).toBe('sp-project-x');
    });

    it('leaves projectId unset when the mapping has no entry for the issue path', () => {
      const cfgWithMapping: GitlabCfg = {
        ...BASE_CFG,
        sourceMode: 'group',
        group: 'project',
        treeImportMapping: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'other/repo': { spProjectId: 'sp-project-y', gitlabProjectId: 2 },
        },
      };
      const result = service.getAddTaskDataForCfg(
        makeIssue(BASE_UPDATED_AT),
        cfgWithMapping,
      );
      expect(result.projectId).toBeUndefined();
    });

    it('carries the base title and issue fields through', () => {
      const cfgWithMapping: GitlabCfg = {
        ...BASE_CFG,
        sourceMode: 'group',
        group: 'project',
        treeImportMapping: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'project/repo': { spProjectId: 'sp-project-x', gitlabProjectId: 1 },
        },
      };
      const result = service.getAddTaskDataForCfg(
        makeIssue(BASE_UPDATED_AT),
        cfgWithMapping,
      );
      expect(result.title).toBe('#42 GitLab issue');
      expect(result.issueId).toBe(ISSUE_ID);
    });
  });
});
