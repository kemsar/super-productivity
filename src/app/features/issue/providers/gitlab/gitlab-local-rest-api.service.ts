import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { LocalRestApiResponsePayload } from '../../../../../../electron/shared-with-frontend/local-rest-api.model';
import {
  createErrorResponse,
  createSuccessResponse,
  getQueryParam,
  LocalRestApiQuery,
} from '../../../../core/electron/local-rest-api-response';
import { IssueProviderService } from '../../issue-provider.service';
import { IssueProvider } from '../../issue.model';
import { selectEnabledIssueProviders } from '../../store/issue-provider.selectors';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { GitlabCfg } from './gitlab.model';

@Injectable({ providedIn: 'root' })
export class GitlabLocalRestApiService {
  private readonly _store = inject(Store);
  private readonly _gitlabApi = inject(GitlabApiService);
  private readonly _gitlabGraphqlApi = inject(GitlabGraphqlApiService);
  private readonly _issueProviderService = inject(IssueProviderService);

  async providerForProject(
    requestId: string,
    query: LocalRestApiQuery,
  ): Promise<LocalRestApiResponsePayload> {
    const spProjectId = getQueryParam(query, 'spProjectId');
    if (!spProjectId) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'spProjectId query parameter is required',
      );
    }
    const providers = await firstValueFrom(
      this._store.select(selectEnabledIssueProviders),
    );
    const gitlabProvider = providers.find(
      (provider) =>
        provider.issueProviderKey === 'GITLAB' &&
        this._providerMatchesSpProject(provider, spProjectId),
    );
    if (!gitlabProvider) {
      return createSuccessResponse(requestId, 200, { provider: null });
    }
    const cfg = await firstValueFrom(
      this._issueProviderService.getCfgOnce$(gitlabProvider.id, 'GITLAB'),
    );
    const gitlabPath = this._resolveGitlabPath(gitlabProvider, cfg, spProjectId);
    return createSuccessResponse(requestId, 200, {
      provider: { id: gitlabProvider.id, gitlabPath },
    });
  }

  async users(
    requestId: string,
    query: LocalRestApiQuery,
  ): Promise<LocalRestApiResponsePayload> {
    const providerId = getQueryParam(query, 'providerId');
    const search = getQueryParam(query, 'search')?.trim() ?? '';
    if (!providerId) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'providerId query parameter is required',
      );
    }
    if (!search) {
      return createSuccessResponse(requestId, 200, []);
    }
    const cfg = await firstValueFrom(
      this._issueProviderService.getCfgOnce$(providerId, 'GITLAB'),
    );
    const users = await firstValueFrom(this._gitlabApi.searchUsers$(search, cfg));
    return createSuccessResponse(requestId, 200, users);
  }

  async milestones(
    requestId: string,
    query: LocalRestApiQuery,
  ): Promise<LocalRestApiResponsePayload> {
    const route = await this._resolveProjectRoute(requestId, query);
    if ('response' in route) return route.response;
    if (!route.gitlabPath) return createSuccessResponse(requestId, 200, []);
    const list = await firstValueFrom(
      this._gitlabApi.listMilestones$(route.gitlabPath, route.cfg),
    );
    return createSuccessResponse(requestId, 200, list);
  }

  async labels(
    requestId: string,
    query: LocalRestApiQuery,
  ): Promise<LocalRestApiResponsePayload> {
    const route = await this._resolveProjectRoute(requestId, query);
    if ('response' in route) return route.response;
    if (!route.gitlabPath) return createSuccessResponse(requestId, 200, []);
    const list = await firstValueFrom(
      this._gitlabApi.listLabels$(route.gitlabPath, route.cfg),
    );
    return createSuccessResponse(requestId, 200, list);
  }

  async statuses(
    requestId: string,
    query: LocalRestApiQuery,
  ): Promise<LocalRestApiResponsePayload> {
    const route = await this._resolveProjectRoute(requestId, query);
    if ('response' in route) return route.response;
    if (!route.gitlabPath) return createSuccessResponse(requestId, 200, []);
    try {
      const statuses = await firstValueFrom(
        this._gitlabGraphqlApi.getAllowedStatuses$(route.cfg, route.gitlabPath),
      );
      return createSuccessResponse(requestId, 200, statuses);
    } catch {
      return createSuccessResponse(requestId, 200, []);
    }
  }

  private async _resolveProjectRoute(
    requestId: string,
    query: LocalRestApiQuery,
  ): Promise<
    | { response: LocalRestApiResponsePayload }
    | { cfg: GitlabCfg; gitlabPath: string | null }
  > {
    const providerId = getQueryParam(query, 'providerId');
    const spProjectId = getQueryParam(query, 'spProjectId');
    if (!providerId || !spProjectId) {
      return {
        response: createErrorResponse(
          requestId,
          400,
          'INVALID_INPUT',
          'providerId and spProjectId query parameters are required',
        ),
      };
    }
    const providers = await firstValueFrom(
      this._store.select(selectEnabledIssueProviders),
    );
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider || provider.issueProviderKey !== 'GITLAB') {
      return {
        response: createErrorResponse(
          requestId,
          404,
          'PROVIDER_NOT_FOUND',
          `No GitLab provider with id ${providerId}`,
        ),
      };
    }
    const cfg = await firstValueFrom(
      this._issueProviderService.getCfgOnce$(providerId, 'GITLAB'),
    );
    return {
      cfg,
      gitlabPath: this._resolveGitlabPath(provider, cfg, spProjectId),
    };
  }

  private _providerMatchesSpProject(
    provider: IssueProvider,
    spProjectId: string,
  ): boolean {
    if (provider.defaultProjectId === spProjectId) return true;
    const mapping = (
      provider as unknown as {
        treeImportMapping?: Record<string, { spProjectId: string }>;
      }
    ).treeImportMapping;
    return mapping
      ? Object.values(mapping).some((entry) => entry.spProjectId === spProjectId)
      : false;
  }

  private _resolveGitlabPath(
    provider: IssueProvider,
    cfg: GitlabCfg,
    spProjectId: string,
  ): string | null {
    if (provider.defaultProjectId === spProjectId && cfg.project) return cfg.project;
    const entry = Object.entries(cfg.treeImportMapping ?? {}).find(
      ([, mapping]) => mapping.spProjectId === spProjectId,
    );
    return entry?.[0] ?? null;
  }
}
