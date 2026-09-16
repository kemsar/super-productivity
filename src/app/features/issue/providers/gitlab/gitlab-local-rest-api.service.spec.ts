import { TestBed } from '@angular/core/testing';
import { provideMockStore } from '@ngrx/store/testing';
import { of } from 'rxjs';
import { IssueProviderService } from '../../issue-provider.service';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { GitlabLocalRestApiService } from './gitlab-local-rest-api.service';

describe('GitlabLocalRestApiService', () => {
  let service: GitlabLocalRestApiService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        GitlabLocalRestApiService,
        provideMockStore(),
        {
          provide: GitlabApiService,
          useValue: jasmine.createSpyObj('GitlabApiService', ['searchUsers$']),
        },
        {
          provide: GitlabGraphqlApiService,
          useValue: jasmine.createSpyObj('GitlabGraphqlApiService', [
            'getAllowedStatuses$',
          ]),
        },
        {
          provide: IssueProviderService,
          useValue: jasmine.createSpyObj('IssueProviderService', {
            getCfgOnce$: of({}),
          }),
        },
      ],
    });
    service = TestBed.inject(GitlabLocalRestApiService);
  });

  it('rejects user searches without a provider id', async () => {
    const response = await service.users('request-1', { search: 'sam' });
    expect(response.status).toBe(400);
    expect(response.body.ok).toBeFalse();
  });

  it('returns an empty user list without calling GitLab for a blank search', async () => {
    const response = await service.users('request-1', {
      providerId: 'provider-1',
      search: ' ',
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, data: [] });
  });
});
