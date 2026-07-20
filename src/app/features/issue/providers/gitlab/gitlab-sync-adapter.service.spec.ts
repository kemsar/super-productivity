import { TestBed } from '@angular/core/testing';
import { Observable, of } from 'rxjs';

import { GitlabSyncAdapterService } from './gitlab-sync-adapter.service';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
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

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj<GitlabApiService>('GitlabApiService', [
      'createIssue$',
      'getById$',
    ]);

    TestBed.configureTestingModule({
      providers: [
        GitlabSyncAdapterService,
        { provide: GitlabApiService, useValue: apiSpy },
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

  describe('push side (Phase B leaves this disabled)', () => {
    it('reports empty field mappings so pushFieldsOnTaskUpdate short-circuits', () => {
      expect(service.getFieldMappings()).toEqual([]);
      expect(service.getSyncConfig(makeCfg())).toEqual({});
      expect(service.extractSyncValues({})).toEqual({});
    });

    it('pushChanges is a no-op — resolves without calling the API', async () => {
      const result = await service.pushChanges(
        'mygroup/repo#1',
        { title: 'x' },
        makeCfg(),
      );
      expect(result).toBeUndefined();
      expect(apiSpy.createIssue$).not.toHaveBeenCalled();
    });
  });
});
