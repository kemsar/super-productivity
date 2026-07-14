import { Injectable, inject } from '@angular/core';
import {
  HttpClient,
  HttpEvent,
  HttpHeaders,
  HttpParams,
  HttpRequest,
} from '@angular/common/http';
import { parseUrl, stringifyUrl } from 'query-string';
import { EMPTY, forkJoin, Observable, of } from 'rxjs';
import { SnackService } from 'src/app/core/snack/snack.service';

import { GitlabCfg, GitlabSourceMode } from '../gitlab.model';
import {
  GitlabOriginalComment,
  GitlabOriginalGroupProject,
  GitlabOriginalIssue,
  GitlabOriginalSubgroup,
} from './gitlab-api-responses';
import { GITLAB_API_BASE_URL } from '../gitlab.const';
import { T } from 'src/app/t.const';
import {
  catchError,
  expand,
  filter,
  map,
  mergeAll,
  mergeMap,
  reduce,
  take,
} from 'rxjs/operators';
import { GitlabIssue } from '../gitlab-issue.model';
import {
  getPartsFromGitlabIssueId,
  mapGitlabIssue,
  mapGitlabIssueToSearchResult,
} from '../gitlab-issue-map.util';
import { SearchResultItem } from '../../../issue.model';
import { GITLAB_TYPE, ISSUE_PROVIDER_HUMANIZED } from '../../../issue.const';
import { assertTruthy } from '../../../../../util/assert-truthy';
import { handleIssueProviderHttpError$ } from '../../../handle-issue-provider-http-error';
import { IssueLog } from '../../../../../core/log';

@Injectable({
  providedIn: 'root',
})
export class GitlabApiService {
  private _snackService = inject(SnackService);
  private _http = inject(HttpClient);

  getById$(id: string, cfg: GitlabCfg): Observable<GitlabIssue> {
    IssueLog.log(this._issueApiLink(cfg, id));

    return this._sendIssuePaginatedRequest$(
      {
        url: this._issueApiLink(cfg, id),
      },
      cfg,
    ).pipe(
      mergeAll(),
      mergeMap((issue: GitlabIssue) => {
        return this.getIssueWithComments$(issue, cfg);
      }),
    );
  }

  private _getSourceMode(cfg: GitlabCfg): GitlabSourceMode {
    return cfg.sourceMode || 'project';
  }

  private getScopeParam(cfg: GitlabCfg): string {
    // The top-level /issues endpoint always defaults scope to created_by_me
    // for authenticated users, which is the wrong default for "all issues
    // assigned to me across the instance" — force assigned_to_me instead.
    if (this._getSourceMode(cfg) === 'all-assigned') {
      return '&scope=assigned_to_me';
    }
    if (cfg.scope) {
      return `&scope=${cfg.scope}`;
    }
    return '';
  }

  private getCustomFilterParam(cfg: GitlabCfg): string {
    if (cfg.filter) {
      return `&${cfg.filter}`;
    } else {
      return '';
    }
  }

  // TODO more efficient to do it like this
  // getByIds$(ids: string[] | number[], cfg: GitlabCfg): Observable<GitlabIssue[]> {
  //   const queryParams = 'iids[]=' + ids.join('&iids[]=');
  //   // const PARAMS_COUNT = 59; // Can't send more than 59 issue id For some reason it returns 502 bad gateway
  //   return this._sendIssuePaginatedRequest$(
  //     {
  //       url: `${this._apiLink(cfg)}/issues?${queryParams}${this.getScopeParam(
  //         cfg,
  //       )}${this.getCustomFilterParam(cfg)}`,
  //     },
  //     cfg,
  //   ).pipe(
  //     mergeMap((issues: GitlabIssue[]) => {
  //       if (issues && issues.length) {
  //         return forkJoin([
  //           ...issues.map((issue) => this.getIssueWithComments$(issue, cfg)),
  //         ]);
  //       } else {
  //         return of([]);
  //       }
  //     }),
  //   );
  // }

  getIssueWithComments$(issue: GitlabIssue, cfg: GitlabCfg): Observable<GitlabIssue> {
    return this._getIssueComments$(issue, cfg).pipe(
      map((comments) => {
        return {
          ...issue,
          comments,
          commentsNr: comments.length,
        };
      }),
    );
  }

  searchIssueInProject$(
    searchText: string,
    cfg: GitlabCfg,
  ): Observable<SearchResultItem[]> {
    if (!this._isValidSettings(cfg)) {
      return EMPTY;
    }
    return this._sendIssuePaginatedRequest$(
      {
        url: `${this._listIssuesApiLink(cfg)}?search=${searchText}${this.getScopeParam(
          cfg,
        )}&order_by=updated_at${this.getExtraListParams(
          cfg,
        )}${this.getCustomFilterParam(cfg)}`,
      },
      cfg,
    ).pipe(
      mergeMap((issues: GitlabIssue[]) => {
        if (issues && issues.length) {
          return forkJoin([
            ...issues.map((issue) => this.getIssueWithComments$(issue, cfg)),
          ]);
        } else {
          return of([]);
        }
      }),
      map((issues: GitlabIssue[]) => {
        return issues ? issues.map(mapGitlabIssueToSearchResult) : [];
      }),
    );
  }

  getProjectIssues$(cfg: GitlabCfg): Observable<GitlabIssue[]> {
    return this._sendIssuePaginatedRequest$(
      {
        url: `${this._listIssuesApiLink(
          cfg,
        )}?state=opened&order_by=updated_at${this.getScopeParam(
          cfg,
        )}${this.getExtraListParams(cfg)}${this.getCustomFilterParam(cfg)}`,
      },
      cfg,
    ).pipe(take(1));
  }

  /**
   * Lists direct subgroups of the configured group. Callers recurse manually
   * to build the full tree (per-level enables partial-failure tolerance —
   * we can still create SP folders for the levels that loaded successfully).
   */
  getGroupSubgroups$(
    groupIdOrPath: string,
    cfg: GitlabCfg,
  ): Observable<GitlabOriginalSubgroup[]> {
    const groupURL = assertTruthy(groupIdOrPath).toString().replace(/\//gi, '%2F');
    return this._sendPaginatedRequest$(
      {
        url: `${this._baseApiLink(cfg)}/groups/${groupURL}/subgroups?order_by=path&sort=asc`,
      },
      cfg,
    ).pipe(
      take(1),
      map((groups: GitlabOriginalSubgroup[]) => groups || []),
    );
  }

  /**
   * Lists projects directly under the given group. `include_subgroups=false`
   * because the recursive walk is driven by getGroupSubgroups$ — this keeps
   * the "which project belongs to which subgroup" information intact for the
   * SP folder-tree build (which the flat subgroup-inclusive endpoint loses).
   */
  getGroupProjects$(
    groupIdOrPath: string,
    cfg: GitlabCfg,
  ): Observable<GitlabOriginalGroupProject[]> {
    const groupURL = assertTruthy(groupIdOrPath).toString().replace(/\//gi, '%2F');
    return this._sendPaginatedRequest$(
      {
        url: `${this._baseApiLink(cfg)}/groups/${groupURL}/projects?archived=false&order_by=path&sort=asc&include_subgroups=false`,
      },
      cfg,
    ).pipe(
      take(1),
      map((projects: GitlabOriginalGroupProject[]) => projects || []),
    );
  }

  addTimeSpentToIssue$(
    issueId: string,
    // NOTE: duration format is without space, e.g.: 1h23m
    duration: string,
    cfg: GitlabCfg,
  ): Observable<unknown> {
    /* {
    human_time_estimate: null | string;
    human_total_time_spent: null | string;
    time_estimate: null | number;
    total_time_spent: null | number;
  }*/

    return this._sendRawRequest$(
      {
        url: `${this._issueApiLink(cfg, issueId)}/add_spent_time`,
        method: 'POST',
        data: {
          duration: duration,
          summary: 'Submitted via Super Productivity on ' + new Date(),
        },
      },
      cfg,
    );
  }

  /**
   * PUT /projects/:project/issues/:iid — updates labels via GitLab's
   * `add_labels` and `remove_labels` comma-separated params. Using these
   * partial params (rather than a full `labels` replace) is safer when the
   * remote issue has labels we don't know about: we only touch the delta
   * the user made in SP. Empty arrays are omitted.
   */
  updateIssueLabels$(
    issueId: string,
    add: string[],
    remove: string[],
    cfg: GitlabCfg,
  ): Observable<unknown> {
    const data: Record<string, string> = {};
    if (add.length > 0) {
      data.add_labels = add.join(',');
    }
    if (remove.length > 0) {
      data.remove_labels = remove.join(',');
    }
    return this._sendRawRequest$(
      {
        url: this._issueApiLink(cfg, issueId),
        method: 'PUT',
        data,
      },
      cfg,
    );
  }

  getTimeTrackingStats$(
    issueId: string,
    cfg: GitlabCfg,
  ): Observable<{
    human_time_estimate: null | string;
    human_total_time_spent: null | string;
    time_estimate: null | number;
    total_time_spent: null | number;
  }> {
    return this._sendRawRequest$(
      {
        url: `${this._issueApiLink(cfg, issueId)}/time_stats`,
      },
      cfg,
    ).pipe(map((res) => (res as any).body));
  }

  private _getIssueComments$(
    issue: GitlabIssue,
    cfg: GitlabCfg,
  ): Observable<GitlabOriginalComment[]> {
    if (!this._isValidSettings(cfg)) {
      return EMPTY;
    }
    return this._sendPaginatedRequest$(
      {
        url: `${issue.links.self}/notes?sort=asc&order_by=updated_at`,
      },
      cfg,
    ).pipe(
      map((comments: GitlabOriginalComment[]) => {
        return comments ? comments : [];
      }),
    );
  }

  private _isValidSettings(cfg: GitlabCfg): boolean {
    if (cfg) {
      const mode = this._getSourceMode(cfg);
      if (mode === 'project' && cfg.project && cfg.project.length > 0) {
        return true;
      }
      if (mode === 'group' && cfg.group && cfg.group.length > 0) {
        return true;
      }
      if (mode === 'all-assigned') {
        return true;
      }
    }
    this._snackService.open({
      type: 'ERROR',
      msg: T.F.ISSUE.S.ERR_NOT_CONFIGURED,
      translateParams: {
        issueProviderName: ISSUE_PROVIDER_HUMANIZED[GITLAB_TYPE],
      },
    });
    return false;
  }

  private _sendIssuePaginatedRequest$(
    params: HttpRequest<string> | any,
    cfg: GitlabCfg,
  ): Observable<GitlabIssue[]> {
    return this._sendPaginatedRequest$(params, cfg).pipe(
      map((issues: GitlabOriginalIssue[]) =>
        issues ? issues.map((issue) => mapGitlabIssue(issue, cfg)) : [],
      ),
    );
  }

  private _sendPaginatedRequest$(
    params: HttpRequest<string> | any,
    cfg: GitlabCfg,
  ): Observable<any> {
    return this._sendPaginatedRequestImpl$(params, cfg, 1).pipe(
      expand((res: any) => {
        if (res && res.body && res.headers) {
          const headers: HttpHeaders = res.headers;
          const next_page = headers.get('x-next-page');
          if (next_page) {
            return this._sendPaginatedRequestImpl$(params, cfg, Number(next_page));
          }
        }
        return EMPTY;
      }),
      reduce((acc, res) => acc.concat(res.body), []),
    );
  }

  private _sendPaginatedRequestImpl$(
    params: HttpRequest<string> | any,
    cfg: GitlabCfg,
    page: number,
  ): Observable<any> {
    const parsedUrl = parseUrl(params.url);
    params.url = stringifyUrl({
      url: parsedUrl.url,
      query: {
        ...parsedUrl.query,
        per_page: 100,
        page: page,
      },
    });
    return this._sendRawRequest$(params, cfg);
  }

  private _sendRawRequest$(
    params: HttpRequest<string> | any,
    cfg: GitlabCfg,
  ): Observable<HttpEvent<unknown>> {
    this._isValidSettings(cfg);

    const p: HttpRequest<any> | any = {
      ...params,
      method: params.method || 'GET',
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        ...(cfg.token ? { 'PRIVATE-TOKEN': cfg.token } : {}),
        ...(params.headers ? params.headers : {}),
      },
    };

    const bodyArg = params.data ? [params.data] : [];

    const allArgs = [
      ...bodyArg,
      {
        headers: new HttpHeaders(p.headers),
        params: new HttpParams({ fromObject: p.params }),
        reportProgress: false,
        observe: 'response',
        responseType: params.responseType,
      },
    ];
    // NOTE: DO NOT LOG allArgs - contains PRIVATE-TOKEN in headers
    // IssueLog.log(allArgs);

    const req = new HttpRequest(p.method, p.url, ...allArgs);

    return this._http.request(req).pipe(
      // Filter out HttpEventType.Sent (type: 0) events to only process actual responses
      filter((res) => !(res === Object(res) && res.type === 0)),
      catchError((err) =>
        handleIssueProviderHttpError$<HttpEvent<unknown>>(
          GITLAB_TYPE,
          this._snackService,
          err,
        ),
      ),
    );
  }

  private _issueApiLink(cfg: GitlabCfg, issueId: string): string {
    IssueLog.log(issueId);
    const { project, projectIssueId } = getPartsFromGitlabIssueId(issueId);
    return `${this._projectApiLink(cfg, project)}/issues/${projectIssueId}`;
  }

  private _projectApiLink(cfg: GitlabCfg, project: string): string {
    const projectURL = assertTruthy(project).toString().replace(/\//gi, '%2F');
    return `${this._baseApiLink(cfg)}/projects/${projectURL}`;
  }

  /**
   * Endpoint (without query string) that lists issues for the configured
   * source mode:
   *   project      → /projects/:id/issues
   *   group        → /groups/:id/issues  (include_subgroups added by callers via getExtraListParams)
   *   all-assigned → /issues             (scope forced to assigned_to_me via getScopeParam)
   */
  private _listIssuesApiLink(cfg: GitlabCfg): string {
    const mode = this._getSourceMode(cfg);
    const base = this._baseApiLink(cfg);
    if (mode === 'group') {
      const groupURL = assertTruthy(cfg.group).toString().replace(/\//gi, '%2F');
      return `${base}/groups/${groupURL}/issues`;
    }
    if (mode === 'all-assigned') {
      return `${base}/issues`;
    }
    const projectURL = assertTruthy(cfg.project).toString().replace(/\//gi, '%2F');
    return `${base}/projects/${projectURL}/issues`;
  }

  private getExtraListParams(cfg: GitlabCfg): string {
    // include_subgroups so a group config surfaces issues nested arbitrarily
    // deep — the primary use case for group scans is an org with many
    // subgroups (see issue #2). The param is a no-op for other endpoints.
    return this._getSourceMode(cfg) === 'group' ? '&include_subgroups=true' : '';
  }

  private _baseApiLink(cfg: GitlabCfg): string {
    if (cfg.gitlabBaseUrl) {
      const fixedUrl = cfg.gitlabBaseUrl.match(/.*\/$/)
        ? cfg.gitlabBaseUrl
        : `${cfg.gitlabBaseUrl}/`;
      return `${fixedUrl}api/v4`;
    }
    return GITLAB_API_BASE_URL;
  }
}
