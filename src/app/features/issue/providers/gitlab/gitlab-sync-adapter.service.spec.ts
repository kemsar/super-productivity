import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';

import { GitlabSyncAdapterService } from './gitlab-sync-adapter.service';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { GitlabIssue } from './gitlab-issue.model';
import { GitlabCfg } from './gitlab.model';
import { DEFAULT_GITLAB_CFG } from './gitlab.const';
import { GitlabOriginalIssue } from './gitlab-api/gitlab-api-responses';

// Cast helper — the spec-fixture issue objects only fill in the fields the
// adapter reads (`iid`, `references.full`); the full GitlabOriginalIssue
// shape has ~30 fields we don't need to stub.
const asIssue$ = (raw: Record<string, unknown>): Observable<GitlabOriginalIssue> =>
  of(raw) as unknown as Observable<GitlabOriginalIssue>;

const makeCfg = (overrides: Partial<GitlabCfg> = {}): GitlabCfg => ({
  ...DEFAULT_GITLAB_CFG,
  token: 'tok',
  ...overrides,
});

describe('GitlabSyncAdapterService', () => {
  let service: GitlabSyncAdapterService;
  let apiSpy: jasmine.SpyObj<GitlabApiService>;
  let graphqlSpy: jasmine.SpyObj<GitlabGraphqlApiService>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj<GitlabApiService>('GitlabApiService', [
      'createIssue$',
      'updateIssue$',
      'getById$',
      'searchUserByUsername$',
      'findMilestoneByTitle$',
      'createMilestone$',
    ]);
    apiSpy.updateIssue$.and.returnValue(asIssue$({ state: 'closed' }));
    // Sensible default for lookup helpers so tests that don't care about
    // extras don't need to set them explicitly.
    apiSpy.searchUserByUsername$.and.returnValue(of(null));
    apiSpy.findMilestoneByTitle$.and.returnValue(of(null));
    apiSpy.createMilestone$.and.returnValue(of({ id: 999, iid: 1, title: 'stub' }));

    graphqlSpy = jasmine.createSpyObj<GitlabGraphqlApiService>(
      'GitlabGraphqlApiService',
      ['isAvailable', 'getAllowedStatuses$', 'getById$', 'updateWorkItem$'],
    );
    // Default: no custom Status widget, so status handling behaves exactly
    // like the pre-#19 universal-state-only path. Individual tests opt into
    // the widget by re-stubbing these.
    graphqlSpy.isAvailable.and.returnValue(false);
    graphqlSpy.getAllowedStatuses$.and.returnValue(of([]));
    graphqlSpy.getById$.and.returnValue(
      of({ workItemGid: 'gid://gitlab/WorkItem/1' } as GitlabIssue),
    );
    graphqlSpy.updateWorkItem$.and.returnValue(of({ workItem: { id: 'x' }, errors: [] }));

    TestBed.configureTestingModule({
      providers: [
        GitlabSyncAdapterService,
        { provide: GitlabApiService, useValue: apiSpy },
        { provide: GitlabGraphqlApiService, useValue: graphqlSpy },
      ],
    });
    service = TestBed.inject(GitlabSyncAdapterService);
  });

  describe('createIssue', () => {
    it('posts to cfg.project in project-mode and returns the canonical <path>#<iid> id', async () => {
      apiSpy.createIssue$.and.returnValue(
        asIssue$({
          iid: 42,
          references: { full: 'mygroup/repo#42' },
        }),
      );

      const result = await service.createIssue(
        'Fix bug',
        makeCfg({ sourceMode: 'project', project: 'mygroup/repo' }),
      );

      expect(apiSpy.createIssue$).toHaveBeenCalledWith(
        'mygroup/repo',
        { title: 'Fix bug' },
        jasmine.any(Object),
      );
      expect(result.issueId).toBe('mygroup/repo#42');
      expect(result.issueNumber).toBe(42);
    });

    it('resolves target project via treeImportMapping in group mode', async () => {
      apiSpy.createIssue$.and.returnValue(
        asIssue$({
          iid: 7,
          references: { full: 'mygroup/pipes#7' },
        }),
      );

      await service.createIssue(
        'Wire up',
        makeCfg({
          sourceMode: 'group',
          group: 'mygroup',
          treeImportMapping: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'mygroup/pipes': { spProjectId: 'sp-1', gitlabProjectId: 1 },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'mygroup/wires': { spProjectId: 'sp-2', gitlabProjectId: 2 },
          },
        }),
        { projectId: 'sp-1' },
      );

      expect(apiSpy.createIssue$).toHaveBeenCalledWith(
        'mygroup/pipes',
        { title: 'Wire up' },
        jasmine.any(Object),
      );
    });

    it('synthesizes the issueId when the response omits references.full (older GitLab)', async () => {
      apiSpy.createIssue$.and.returnValue(asIssue$({ iid: 99 }));

      const result = await service.createIssue(
        'Old server',
        makeCfg({ sourceMode: 'project', project: 'group/legacy' }),
      );

      expect(result.issueId).toBe('group/legacy#99');
      expect(result.issueNumber).toBe(99);
    });

    it('throws when the response omits both references.full and iid (would produce a malformed id)', async () => {
      apiSpy.createIssue$.and.returnValue(asIssue$({ title: 'nope' }));
      await expectAsync(
        service.createIssue(
          'No id at all',
          makeCfg({ sourceMode: 'project', project: 'group/legacy' }),
        ),
      ).toBeRejectedWithError(/missing both references\.full and iid/i);
      // Sanity: we DID hit the API — the throw is post-response, not a
      // short-circuit before the POST.
      expect(apiSpy.createIssue$).toHaveBeenCalledTimes(1);
    });

    it('throws when group mode has no matching mapping entry', async () => {
      await expectAsync(
        service.createIssue(
          'No target',
          makeCfg({
            sourceMode: 'group',
            group: 'mygroup',
            treeImportMapping: {
              // eslint-disable-next-line @typescript-eslint/naming-convention
              'mygroup/pipes': { spProjectId: 'sp-1', gitlabProjectId: 1 },
            },
          }),
          { projectId: 'sp-not-mapped' },
        ),
      ).toBeRejectedWithError(/no target project/i);
      expect(apiSpy.createIssue$).not.toHaveBeenCalled();
    });

    it('throws in all-assigned mode (no meaningful target project)', async () => {
      await expectAsync(
        service.createIssue(
          'Unroutable',
          makeCfg({ sourceMode: 'all-assigned', project: null }),
        ),
      ).toBeRejectedWithError(/no target project/i);
      expect(apiSpy.createIssue$).not.toHaveBeenCalled();
    });
  });

  describe('createIssue with QuickAddExtras (#19)', () => {
    const baseCfg = (): GitlabCfg =>
      makeCfg({ sourceMode: 'project', project: 'mygroup/repo' });
    const stubIssueResponse = (): void => {
      apiSpy.createIssue$.and.returnValue(
        asIssue$({ iid: 100, references: { full: 'mygroup/repo#100' } }),
      );
    };

    it('passes description, due_date, and priority label straight through', async () => {
      stubIssueResponse();
      await service.createIssue('Fix bug', baseCfg(), {
        extras: {
          description: 'Repros on Safari 17.',
          dueDate: '2026-07-24',
          priority: 'high',
        },
      });
      expect(apiSpy.createIssue$).toHaveBeenCalledWith(
        'mygroup/repo',
        {
          title: 'Fix bug',
          description: 'Repros on Safari 17.',
          due_date: '2026-07-24',
          labels: 'priority::high',
        },
        jasmine.any(Object),
      );
    });

    it('resolves an @username to its numeric id via /users?username=', async () => {
      stubIssueResponse();
      apiSpy.searchUserByUsername$.and.returnValue(of({ id: 42, username: 'kevin' }));
      await service.createIssue('Ping', baseCfg(), {
        extras: { assignees: ['kevin'] },
      });
      expect(apiSpy.searchUserByUsername$).toHaveBeenCalledWith(
        'kevin',
        jasmine.any(Object),
      );
      expect(apiSpy.createIssue$).toHaveBeenCalledWith(
        'mygroup/repo',
        { title: 'Ping', assignee_ids: [42] },
        jasmine.any(Object),
      );
    });

    it('drops an unresolvable assignee silently — the issue still lands', async () => {
      stubIssueResponse();
      apiSpy.searchUserByUsername$.and.returnValues(
        of({ id: 42, username: 'kevin' }),
        of(null),
      );
      await service.createIssue('Ping', baseCfg(), {
        extras: { assignees: ['kevin', 'ghost'] },
      });
      const posted = apiSpy.createIssue$.calls.mostRecent().args[1];
      expect(posted.assignee_ids).toEqual([42]);
    });

    it('reuses an existing milestone when the title matches', async () => {
      stubIssueResponse();
      apiSpy.findMilestoneByTitle$.and.returnValue(
        of({ id: 7, iid: 1, title: 'v2', state: 'active' }),
      );
      await service.createIssue('Ship', baseCfg(), {
        extras: { milestone: 'v2' },
      });
      expect(apiSpy.findMilestoneByTitle$).toHaveBeenCalledWith(
        'mygroup/repo',
        'v2',
        jasmine.any(Object),
      );
      expect(apiSpy.createMilestone$).not.toHaveBeenCalled();
      const posted = apiSpy.createIssue$.calls.mostRecent().args[1];
      expect(posted.milestone_id).toBe(7);
    });

    it('creates a milestone when none matches, then attaches its id', async () => {
      stubIssueResponse();
      apiSpy.findMilestoneByTitle$.and.returnValue(of(null));
      apiSpy.createMilestone$.and.returnValue(of({ id: 88, iid: 2, title: 'v3' }));
      await service.createIssue('Ship', baseCfg(), {
        extras: { milestone: 'v3' },
      });
      expect(apiSpy.createMilestone$).toHaveBeenCalledWith(
        'mygroup/repo',
        'v3',
        jasmine.any(Object),
      );
      const posted = apiSpy.createIssue$.calls.mostRecent().args[1];
      expect(posted.milestone_id).toBe(88);
    });

    it('drops the milestone silently when create-if-missing fails (e.g. 403)', async () => {
      stubIssueResponse();
      apiSpy.findMilestoneByTitle$.and.returnValue(of(null));
      apiSpy.createMilestone$.and.returnValue(throwError(() => new Error('403')));
      await service.createIssue('Ship', baseCfg(), {
        extras: { milestone: 'v-forbidden' },
      });
      const posted = apiSpy.createIssue$.calls.mostRecent().args[1];
      expect(posted.milestone_id).toBeUndefined();
      // The issue still lands with everything else intact.
      expect(apiSpy.createIssue$).toHaveBeenCalled();
    });

    it('no extras → falls back to the minimal { title } body (unchanged)', async () => {
      stubIssueResponse();
      await service.createIssue('Plain', baseCfg());
      expect(apiSpy.createIssue$).toHaveBeenCalledWith(
        'mygroup/repo',
        { title: 'Plain' },
        jasmine.any(Object),
      );
    });

    it('>done triggers a post-create close via state_event=close', async () => {
      stubIssueResponse();
      await service.createIssue('Finished it', baseCfg(), {
        extras: { status: 'done' },
      });
      expect(apiSpy.updateIssue$).toHaveBeenCalledWith(
        'mygroup/repo#100',
        { state_event: 'close' },
        jasmine.any(Object),
      );
    });

    it('>closed and >resolved also trigger the close PUT', async () => {
      for (const status of ['closed', 'resolved', 'complete']) {
        apiSpy.updateIssue$.calls.reset();
        stubIssueResponse();
        await service.createIssue('X', baseCfg(), { extras: { status } });
        expect(apiSpy.updateIssue$).toHaveBeenCalledWith(
          'mygroup/repo#100',
          { state_event: 'close' },
          jasmine.any(Object),
        );
      }
    });

    it('>open / >opened / to-do are no-ops (issue is already open on POST)', async () => {
      for (const status of ['open', 'opened', ['t', 'odo'].join('')]) {
        apiSpy.updateIssue$.calls.reset();
        stubIssueResponse();
        await service.createIssue('X', baseCfg(), { extras: { status } });
        expect(apiSpy.updateIssue$).not.toHaveBeenCalled();
      }
    });

    it('>doing drops when the custom Status widget is unavailable (falls back to universal state, which has no match)', async () => {
      stubIssueResponse();
      await service.createIssue('Working', baseCfg(), {
        extras: { status: 'doing' },
      });
      // GraphQL unavailable (default) → no custom status; 'doing' is not a
      // universal state → nothing applied.
      expect(graphqlSpy.updateWorkItem$).not.toHaveBeenCalled();
      expect(apiSpy.updateIssue$).not.toHaveBeenCalled();
    });

    it('applies a matching custom Status via workItemUpdate (punctuation-insensitive name match)', async () => {
      stubIssueResponse();
      graphqlSpy.isAvailable.and.returnValue(true);
      graphqlSpy.getAllowedStatuses$.and.returnValue(
        of([
          {
            id: 'gid://gitlab/WorkItems::Statuses::Custom::Status/7',
            name: 'In progress',
          },
          { id: 'gid://gitlab/WorkItems::Statuses::Custom::Status/9', name: 'Done' },
        ]),
      );
      await service.createIssue('Working', baseCfg(), {
        // Parser hands us the hyphenated/lowercased form.
        extras: { status: 'in-progress' },
      });
      expect(graphqlSpy.updateWorkItem$).toHaveBeenCalledWith(
        {
          id: 'gid://gitlab/WorkItem/1',
          statusWidget: { status: 'gid://gitlab/WorkItems::Statuses::Custom::Status/7' },
        },
        jasmine.any(Object),
      );
      // Custom status applied → no universal-state PUT.
      expect(apiSpy.updateIssue$).not.toHaveBeenCalled();
    });

    it('falls back to the close PUT when the widget is available but the token matches no custom status and is a universal close', async () => {
      stubIssueResponse();
      graphqlSpy.isAvailable.and.returnValue(true);
      graphqlSpy.getAllowedStatuses$.and.returnValue(
        of([{ id: 'gid://.../7', name: 'In progress' }]),
      );
      await service.createIssue('Finished', baseCfg(), {
        extras: { status: 'done' },
      });
      expect(graphqlSpy.updateWorkItem$).not.toHaveBeenCalled();
      expect(apiSpy.updateIssue$).toHaveBeenCalledWith(
        'mygroup/repo#100',
        { state_event: 'close' },
        jasmine.any(Object),
      );
    });

    it('falls back to universal state when the workItemUpdate mutation fails', async () => {
      stubIssueResponse();
      graphqlSpy.isAvailable.and.returnValue(true);
      graphqlSpy.getAllowedStatuses$.and.returnValue(
        of([{ id: 'gid://.../9', name: 'Done' }]),
      );
      graphqlSpy.updateWorkItem$.and.returnValue(
        throwError(() => new Error('widget not supported for this work-item type')),
      );
      await service.createIssue('Finished', baseCfg(), {
        extras: { status: 'done' },
      });
      // Mutation attempted and threw → fall through to the close PUT.
      expect(graphqlSpy.updateWorkItem$).toHaveBeenCalled();
      expect(apiSpy.updateIssue$).toHaveBeenCalledWith(
        'mygroup/repo#100',
        { state_event: 'close' },
        jasmine.any(Object),
      );
    });
  });

  describe('push side (isDone → state via state_event PUT)', () => {
    it('exposes the isDone mapping and reads issue.state as baseline', () => {
      const mappings = service.getFieldMappings();
      expect(mappings).toHaveSize(1);
      expect(mappings[0].taskField).toBe('isDone');
      expect(mappings[0].issueField).toBe('state');
      expect(service.extractSyncValues({ state: 'closed' })).toEqual({
        state: 'closed',
      });
    });

    it('canonicalizes REST "opened" to "open" so GraphQL and REST baselines compare equal (#26)', () => {
      // GraphQL reads normalize to 'open'; REST reads return 'opened'. Without
      // canonicalization the baseline (GraphQL) never equals the push-time
      // fetch (REST) and the close is silently skipped as 'provider-changed'.
      expect(service.extractSyncValues({ state: 'opened' })).toEqual({ state: 'open' });
      expect(service.extractSyncValues({ state: 'open' })).toEqual({ state: 'open' });
      expect(service.getFieldMappings()[0].toIssueValue(false, { issueId: 'x#1' })).toBe(
        'open',
      );
    });

    it('translates a state=closed change to state_event=close on the PUT', async () => {
      await service.pushChanges('mygroup/repo#1', { state: 'closed' }, makeCfg());
      expect(apiSpy.updateIssue$).toHaveBeenCalledWith(
        'mygroup/repo#1',
        { state_event: 'close' },
        jasmine.any(Object),
      );
    });

    it('translates a state=opened change to state_event=reopen on the PUT', async () => {
      await service.pushChanges('mygroup/repo#1', { state: 'opened' }, makeCfg());
      expect(apiSpy.updateIssue$).toHaveBeenCalledWith(
        'mygroup/repo#1',
        { state_event: 'reopen' },
        jasmine.any(Object),
      );
    });

    it('no-ops when the change bag has no push-mapped fields', async () => {
      await service.pushChanges(
        'mygroup/repo#1',
        { title: 'ignored for now' },
        makeCfg(),
      );
      expect(apiSpy.updateIssue$).not.toHaveBeenCalled();
    });
  });
});
