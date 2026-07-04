import {
  HttpClientTestingModule,
  HttpTestingController,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { SnackService } from '../../../../../core/snack/snack.service';
import { GitlabCfg } from '../gitlab.model';
import { GitlabGraphqlApiService } from './gitlab-graphql-api.service';
import { GitlabGqlIssue } from './gitlab-graphql-responses';

const GRAPHQL_URL = 'https://gitlab.com/api/graphql';

const CFG: GitlabCfg = {
  isEnabled: true,
  project: 'group/repo',
  token: 'tok',
  filterUsername: null,
  scope: 'all',
};

const makeNode = (overrides: Partial<GitlabGqlIssue> = {}): GitlabGqlIssue => ({
  id: 'gid://gitlab/Issue/1',
  iid: '42',
  title: 'Issue 42',
  description: 'body',
  state: 'opened',
  webUrl: 'https://gitlab.com/group/repo/-/issues/42',
  reference: 'group/repo#42',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  closedAt: null,
  dueDate: null,
  weight: null,
  workItemType: { id: 'gid://gitlab/WorkItems::Type/1', name: 'Issue' },
  status: null,
  author: {
    id: 'gid://gitlab/User/9',
    username: 'me',
    name: 'Me',
    webUrl: 'https://gitlab.com/me',
    avatarUrl: null,
  },
  assignees: { nodes: [] },
  labels: { nodes: [] },
  notes: { nodes: [] },
  ...overrides,
});

describe('GitlabGraphqlApiService', () => {
  let service: GitlabGraphqlApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        GitlabGraphqlApiService,
        {
          provide: SnackService,
          useValue: jasmine.createSpyObj('SnackService', ['open']),
        },
      ],
    });
    service = TestBed.inject(GitlabGraphqlApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('isAvailable', () => {
    it('is false for numeric project IDs (GraphQL requires the full path)', () => {
      expect(service.isAvailable({ ...CFG, project: '12345' })).toBe(false);
    });

    it('is false when raw REST filter querystrings are configured', () => {
      expect(service.isAvailable({ ...CFG, filter: 'labels=urgent' })).toBe(false);
    });

    it('is true for a namespaced project path with no free-form filter', () => {
      expect(service.isAvailable(CFG)).toBe(true);
    });
  });

  describe('getById$', () => {
    it('sends a workItems-style query for the requested iid and maps status', async () => {
      const promise = firstValueFrom(service.getById$('group/repo#42', CFG));

      const req = httpMock.expectOne(GRAPHQL_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.headers.get('PRIVATE-TOKEN')).toBe('tok');
      expect(req.request.body.variables.fullPath).toBe('group/repo');
      expect(req.request.body.variables.iids).toEqual(['42']);
      expect(req.request.body.query).toContain('status { id name category }');
      req.flush({
        data: {
          project: {
            id: 'gid://gitlab/Project/1',
            issues: {
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [
                makeNode({
                  status: {
                    id: 'gid://gitlab/WorkItems::Status/1',
                    name: 'In progress',
                    category: 'IN_PROGRESS',
                  },
                }),
              ],
            },
          },
        },
      });

      const issue = await promise;
      expect(issue.status?.name).toBe('In progress');
      expect(issue.status?.category).toBe('IN_PROGRESS');
      expect(issue.workItemGid).toBe('gid://gitlab/Issue/1');
      expect(issue.id).toBe('group/repo#42');
      expect(issue.number).toBe(42);
    });

    it('marks GraphQL unavailable when the server returns an errors block', async () => {
      const p = firstValueFrom(service.getById$('group/repo#42', CFG));
      const req = httpMock.expectOne(GRAPHQL_URL);
      req.flush({
        data: null,
        errors: [{ message: "Field 'status' doesn't exist on Issue" }],
      });

      await p.catch(() => undefined);
      expect(service.isAvailable(CFG)).toBe(false);
    });

    it('marks GraphQL unavailable on transport errors', async () => {
      const p = firstValueFrom(service.getById$('group/repo#42', CFG));
      const req = httpMock.expectOne(GRAPHQL_URL);
      req.error(new ProgressEvent('network'));

      await p.catch(() => undefined);
      expect(service.isAvailable(CFG)).toBe(false);
    });
  });

  describe('scope handling', () => {
    it('sends assigneeUsernames when scope is assigned-to-me (resolves current user first)', async () => {
      const cfg = { ...CFG, scope: 'assigned-to-me' };
      const p = firstValueFrom(service.getProjectIssues$(cfg));

      const currentUserReq = httpMock.expectOne(GRAPHQL_URL);
      expect(currentUserReq.request.body.query).toContain('currentUser');
      currentUserReq.flush({ data: { currentUser: { username: 'alice' } } });

      const issuesReq = httpMock.expectOne(GRAPHQL_URL);
      expect(issuesReq.request.body.variables.assigneeUsernames).toEqual(['alice']);
      expect(issuesReq.request.body.variables.authorUsername).toBeUndefined();
      issuesReq.flush({
        data: {
          project: {
            id: 'gid://gitlab/Project/1',
            issues: {
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [],
            },
          },
        },
      });

      await p;
    });

    it('caches currentUser lookups per endpoint', async () => {
      const cfg = { ...CFG, scope: 'created-by-me' };
      const p1 = firstValueFrom(service.getProjectIssues$(cfg));
      httpMock
        .expectOne(GRAPHQL_URL)
        .flush({ data: { currentUser: { username: 'alice' } } });
      httpMock.expectOne(GRAPHQL_URL).flush({
        data: {
          project: {
            id: 'gid://gitlab/Project/1',
            issues: { pageInfo: { endCursor: null, hasNextPage: false }, nodes: [] },
          },
        },
      });
      await p1;

      // Second call must skip the currentUser round-trip.
      const p2 = firstValueFrom(service.getProjectIssues$(cfg));
      const req = httpMock.expectOne(GRAPHQL_URL);
      expect(req.request.body.query).not.toContain('currentUser');
      expect(req.request.body.variables.authorUsername).toBe('alice');
      req.flush({
        data: {
          project: {
            id: 'gid://gitlab/Project/1',
            issues: { pageInfo: { endCursor: null, hasNextPage: false }, nodes: [] },
          },
        },
      });
      await p2;
    });
  });

  describe('pagination', () => {
    it('follows endCursor across pages and concatenates nodes', async () => {
      const p = firstValueFrom(service.getProjectIssues$(CFG));

      const page1 = httpMock.expectOne(GRAPHQL_URL);
      expect(page1.request.body.variables.after).toBeUndefined();
      page1.flush({
        data: {
          project: {
            id: 'gid://gitlab/Project/1',
            issues: {
              pageInfo: { endCursor: 'CURSOR-1', hasNextPage: true },
              nodes: [makeNode({ iid: '1', reference: 'group/repo#1' })],
            },
          },
        },
      });

      const page2 = httpMock.expectOne(GRAPHQL_URL);
      expect(page2.request.body.variables.after).toBe('CURSOR-1');
      page2.flush({
        data: {
          project: {
            id: 'gid://gitlab/Project/1',
            issues: {
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [makeNode({ iid: '2', reference: 'group/repo#2' })],
            },
          },
        },
      });

      const issues = await p;
      expect(issues.map((i) => i.number)).toEqual([1, 2]);
    });
  });

  describe('updateWorkItem$', () => {
    it('surfaces payload errors as thrown errors', async () => {
      const p = firstValueFrom(
        service.updateWorkItem$(
          {
            id: 'gid://gitlab/Issue/1',
            statusWidget: { status: 'gid://gitlab/WorkItems::Status/2' },
          },
          CFG,
        ),
      );
      const req = httpMock.expectOne(GRAPHQL_URL);
      expect(req.request.body.query).toContain('workItemUpdate');
      req.flush({
        data: { workItemUpdate: { workItem: null, errors: ['Status not allowed'] } },
      });

      await expectAsync(p).toBeRejectedWithError(/Status not allowed/);
    });

    it('returns the payload when the mutation succeeds', async () => {
      const p = firstValueFrom(
        service.updateWorkItem$({ id: 'gid://gitlab/Issue/1', stateEvent: 'CLOSE' }, CFG),
      );
      const req = httpMock.expectOne(GRAPHQL_URL);
      req.flush({
        data: {
          workItemUpdate: { workItem: { id: 'gid://gitlab/Issue/1' }, errors: [] },
        },
      });

      const payload = await p;
      expect(payload.workItem?.id).toBe('gid://gitlab/Issue/1');
    });
  });
});
