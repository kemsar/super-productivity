import { inject, Injectable } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { Task } from 'src/app/features/tasks/task.model';
import { BaseIssueProviderService } from '../../base/base-issue-provider.service';
import { IssueData, SearchResultItem } from '../../issue.model';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabGraphqlApiService } from './gitlab-api/gitlab-graphql-api.service';
import { GitlabCfg } from './gitlab.model';
import { GitlabIssue } from './gitlab-issue.model';
import { truncate } from '../../../../util/truncate';
import { GITLAB_BASE_URL, GITLAB_POLL_INTERVAL } from './gitlab.const';

@Injectable({
  providedIn: 'root',
})
export class GitlabCommonInterfacesService extends BaseIssueProviderService<GitlabCfg> {
  private readonly _gitlabApiService = inject(GitlabApiService);
  private readonly _gitlabGraphqlApiService = inject(GitlabGraphqlApiService);
  private _cachedCfg?: GitlabCfg;

  readonly providerKey = 'GITLAB' as const;

  get pollInterval(): number {
    return this._cachedCfg?.pollIntervalMinutes
      ? this._cachedCfg.pollIntervalMinutes * 60 * 1000
      : GITLAB_POLL_INTERVAL;
  }

  isEnabled(cfg: GitlabCfg): boolean {
    if (!cfg || !cfg.isEnabled) {
      return false;
    }
    const mode = cfg.sourceMode || 'project';
    if (mode === 'group') {
      return !!cfg.group;
    }
    if (mode === 'all-assigned') {
      return !!cfg.token;
    }
    return !!cfg.project;
  }

  testConnection(cfg: GitlabCfg): Promise<boolean> {
    return firstValueFrom(
      this._searchIssuesWithFallback$('', cfg).pipe(map((res) => Array.isArray(res))),
    ).then((result) => result ?? false);
  }

  issueLink(issueId: string, issueProviderId: string): Promise<string> {
    return firstValueFrom(
      this._getCfgOnce$(issueProviderId).pipe(
        map((cfg) => {
          // In group / all-assigned modes there is no single project on the
          // config — each issue can live in a different project. The issue
          // id itself carries that: mapGitlabIssue writes `references.full`
          // (e.g. `group/project#42`) into it, so parse the project out of
          // the id and only fall back to cfg.project for legacy ids that
          // are missing the namespace prefix.
          const idStr = issueId.toString();
          const hashIdx = idStr.indexOf('#');
          const projectFromId = hashIdx > 0 ? idStr.slice(0, hashIdx) : '';
          const project: string | null = projectFromId || cfg.project;

          if (!project) {
            return '';
          }

          const cleanIssueId = idStr.replace(/^.*#/, '');

          if (cfg.gitlabBaseUrl) {
            const fixedUrl = cfg.gitlabBaseUrl.match(/.*\/$/)
              ? cfg.gitlabBaseUrl
              : `${cfg.gitlabBaseUrl}/`;
            return `${fixedUrl}${project}/-/issues/${cleanIssueId}`;
          } else {
            return `${GITLAB_BASE_URL}${project}/-/issues/${cleanIssueId}`;
          }
        }),
      ),
    ).then((result) => result ?? '');
  }

  getAddTaskData(issue: GitlabIssue): Partial<Task> & { title: string } {
    return {
      title: this._formatIssueTitle(issue),
      issuePoints: issue.weight,
      issueWasUpdated: false,
      issueLastUpdated: new Date(issue.updated_at).getTime(),
      issueId: issue.id,
      isDone: issue.state === 'closed',
      dueDay: issue.due_date || undefined,
    };
  }

  /**
   * Cfg-aware variant consumed by `IssueService._getAddTaskData`. Routes each
   * incoming issue to the SP project mapped to its GitLab full path when a
   * tree-import mapping exists on the group provider (issue #10). Falls back
   * to the plain `getAddTaskData` shape when unmapped so single-project and
   * all-assigned providers behave exactly as before.
   */
  getAddTaskDataForCfg(
    issue: GitlabIssue,
    cfg: GitlabCfg,
  ): Partial<Task> & { title: string } {
    const base = this.getAddTaskData(issue);
    const mapping = cfg.treeImportMapping;
    if (!mapping) {
      return base;
    }
    const projectPath = issue.id.split('#')[0];
    const entry = mapping[projectPath];
    if (!entry) {
      return base;
    }
    return { ...base, projectId: entry.spProjectId };
  }

  async getNewIssuesToAddToBacklog(
    issueProviderId: string,
    _allExistingIssueIds: number[] | string[],
  ): Promise<IssueData[]> {
    const cfg = await firstValueFrom(this._getCfgOnce$(issueProviderId));
    if (this._gitlabGraphqlApiService.isAvailable(cfg)) {
      try {
        return await firstValueFrom(this._gitlabGraphqlApiService.getProjectIssues$(cfg));
      } catch {
        // Fall through to REST — GraphQL is now marked unavailable for the session.
      }
    }
    return await firstValueFrom(this._gitlabApiService.getProjectIssues$(cfg));
  }

  protected _apiGetById$(
    id: string | number,
    cfg: GitlabCfg,
  ): Observable<IssueData | null> {
    const idStr = id.toString();
    if (this._gitlabGraphqlApiService.isAvailable(cfg)) {
      return this._gitlabGraphqlApiService
        .getById$(idStr, cfg)
        .pipe(catchError(() => this._gitlabApiService.getById$(idStr, cfg)));
    }
    return this._gitlabApiService.getById$(idStr, cfg);
  }

  protected _apiSearchIssues$(
    searchTerm: string,
    cfg: GitlabCfg,
  ): Observable<SearchResultItem[]> {
    return this._searchIssuesWithFallback$(searchTerm, cfg);
  }

  private _searchIssuesWithFallback$(
    searchTerm: string,
    cfg: GitlabCfg,
  ): Observable<SearchResultItem[]> {
    if (this._gitlabGraphqlApiService.isAvailable(cfg)) {
      return this._gitlabGraphqlApiService
        .searchIssueInProject$(searchTerm, cfg)
        .pipe(
          catchError(() => this._gitlabApiService.searchIssueInProject$(searchTerm, cfg)),
        );
    }
    return this._gitlabApiService.searchIssueInProject$(searchTerm, cfg);
  }

  protected _formatIssueTitleForSnack(issue: IssueData): string {
    return truncate(this._formatIssueTitle(issue as GitlabIssue));
  }

  protected _getIssueLastUpdated(issue: IssueData): number {
    return new Date((issue as GitlabIssue).updated_at).getTime();
  }

  // Caches config for the pollInterval getter (mirrors CalDAV / NextcloudDeck).
  protected override _getCfgOnce$(issueProviderId: string): Observable<GitlabCfg> {
    return super._getCfgOnce$(issueProviderId).pipe(
      tap((cfg) => {
        this._cachedCfg = cfg;
      }),
    );
  }

  private _formatIssueTitle(issue: GitlabIssue): string {
    return `#${issue.number} ${issue.title}`;
  }
}
