import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EMPTY, Observable, defer, of, throwError } from 'rxjs';
import { catchError, expand, map, mergeMap, reduce, take, tap } from 'rxjs/operators';

import { HANDLED_ERROR_PROP_STR } from '../../../../../app.constants';
import { IssueLog } from '../../../../../core/log';
import { assertTruthy } from '../../../../../util/assert-truthy';
import { GITLAB_TYPE, ISSUE_PROVIDER_HUMANIZED } from '../../../issue.const';
import { SearchResultItem } from '../../../issue.model';
import { GitlabIssue } from '../gitlab-issue.model';
import { getPartsFromGitlabIssueId, mapGitlabGqlIssue } from '../gitlab-issue-map.util';
import { GITLAB_BASE_URL } from '../gitlab.const';
import { GitlabCfg } from '../gitlab.model';
import {
  GitlabGqlIssue,
  GitlabGqlIssueConnection,
  GitlabGqlProjectIssuesResponse,
  GitlabGqlResponse,
  GitlabGqlWorkItemUpdateInput,
  GitlabGqlWorkItemUpdatePayload,
} from './gitlab-graphql-responses';

const PAGE_SIZE = 100;
const SEARCH_PAGE_SIZE = 25;

const ISSUE_FIELDS = `
    id
    iid
    title
    description
    state
    webUrl
    reference(full: true)
    createdAt
    updatedAt
    closedAt
    dueDate
    weight
    workItemType { id name }
    status { id name category }
    author { id username name webUrl avatarUrl }
    assignees { nodes { id username name webUrl avatarUrl } }
    labels { nodes { id title } }
    notes(filter: ONLY_COMMENTS, first: 100) {
      nodes {
        id
        body
        bodyHtml
        system
        createdAt
        updatedAt
        author { id username name webUrl avatarUrl }
      }
    }`;

const PROJECT_ISSUES_QUERY = `
  query SpProjectIssues(
    $fullPath: ID!
    $after: String
    $first: Int!
    $state: IssuableState
    $search: String
    $authorUsername: String
    $assigneeUsernames: [String!]
    $sort: IssueSort
    $iids: [String!]
  ) {
    project(fullPath: $fullPath) {
      id
      issues(
        after: $after
        first: $first
        state: $state
        search: $search
        authorUsername: $authorUsername
        assigneeUsernames: $assigneeUsernames
        sort: $sort
        iids: $iids
      ) {
        pageInfo { endCursor hasNextPage }
        nodes {${ISSUE_FIELDS}
        }
      }
    }
  }`;

const CURRENT_USER_QUERY = `
  query SpCurrentUser {
    currentUser { username }
  }`;

const WORK_ITEM_UPDATE_MUTATION = `
  mutation SpWorkItemUpdate($input: WorkItemUpdateInput!) {
    workItemUpdate(input: $input) {
      workItem { id }
      errors
    }
  }`;

// Reads the custom Status widget's allowed values per work-item type (#19).
// This is the WorkItems "Status" widget — the configurable per-lifecycle
// status (To do / In progress / Done / ...), NOT the universal issue `state`
// (opened/closed). Gated behind Premium/Ultimate + the work_item_status
// feature; instances without it return no WorkItemWidgetDefinitionStatus
// fragment (empty list) or error the whole query (handled → REST fallback).
// Query shape mirrors GitLab's own `namespaceWorkItemTypes` frontend query:
// the statuses live on the work-item TYPE's Status widget DEFINITION, keyed by
// namespace full path (a project's full path resolves to its ProjectNamespace).
// Two things that are easy to get wrong and silently return nothing:
//   - it's `namespace(fullPath:)`, NOT `project(fullPath:)`
//   - `allowedStatuses` is a FLAT list, NOT a `{ nodes { … } }` connection
const PROJECT_STATUSES_QUERY = `
  query SpProjectStatuses($fullPath: ID!) {
    namespace(fullPath: $fullPath) {
      id
      workItemTypes {
        nodes {
          id
          name
          widgetDefinitions {
            type
            ... on WorkItemWidgetDefinitionStatus {
              allowedStatuses {
                id
                name
              }
            }
          }
        }
      }
    }
  }`;

interface CurrentUserResponse {
  readonly currentUser: { readonly username: string } | null;
}

interface ProjectStatusesResponse {
  readonly namespace: {
    readonly workItemTypes: {
      readonly nodes: ReadonlyArray<{
        readonly name: string;
        readonly widgetDefinitions?: ReadonlyArray<{
          readonly allowedStatuses?: ReadonlyArray<{
            readonly id: string;
            readonly name: string;
          }>;
        }>;
      }>;
    } | null;
  } | null;
}

// Marker on thrown errors so callers can distinguish "GraphQL declined this
// request, try REST" from a truly fatal error. Not currently checked (callers
// blanket-catchError), but cheap to tag now.
const GITLAB_GRAPHQL_UNAVAILABLE = Symbol('GITLAB_GRAPHQL_UNAVAILABLE');

const isNumericProjectId = (project: string | null | undefined): boolean =>
  !!project && /^\d+$/.test(project);

@Injectable({ providedIn: 'root' })
export class GitlabGraphqlApiService {
  private readonly _http = inject(HttpClient);

  // Session-scoped: if a query fails against a given endpoint (unknown field,
  // no permissions, network), stop calling GraphQL for that endpoint so we
  // don't waste round-trips. A page refresh resets this — the assumption is
  // that operators who upgrade GitLab or expand token scopes will restart the
  // app anyway, and this keeps the fallback path cheap when it matters.
  private readonly _disabledEndpoints = new Set<string>();
  private readonly _currentUserByEndpoint = new Map<string, string | null>();

  isAvailable(cfg: GitlabCfg): boolean {
    // GraphQL's project selector wants a namespace path; numeric project IDs
    // work in REST but not here. Numeric-ID users fall through to REST
    // transparently.
    if (!cfg.project || isNumericProjectId(cfg.project)) {
      return false;
    }
    if (cfg.filter) {
      // Raw REST querystring users get REST — we don't try to translate their
      // free-form filters into GraphQL args.
      return false;
    }
    return !this._disabledEndpoints.has(this._endpoint(cfg));
  }

  getById$(id: string, cfg: GitlabCfg): Observable<GitlabIssue> {
    const { project, projectIssueId } = getPartsFromGitlabIssueId(id);
    return this._queryProjectIssuesPage$(cfg, {
      fullPath: this._resolveFullPath(cfg, project),
      first: 1,
      iids: [projectIssueId],
    }).pipe(
      map((page) => {
        const node = page.nodes[0];
        if (!node) {
          // Preserve REST semantics — a missing issue is a hard error, not
          // silently null, so the polling code notices and surfaces it.
          throw new Error(`GitLab issue ${id} not found`);
        }
        return mapGitlabGqlIssue(node, cfg);
      }),
    );
  }

  searchIssueInProject$(
    searchText: string,
    cfg: GitlabCfg,
  ): Observable<SearchResultItem[]> {
    return this._paginateAll$(cfg, {
      fullPath: this._resolveFullPath(cfg),
      first: SEARCH_PAGE_SIZE,
      search: searchText || undefined,
      sort: 'UPDATED_DESC',
    }).pipe(
      map((nodes) =>
        nodes.map((node) => {
          const issue = mapGitlabGqlIssue(node, cfg);
          return {
            title: '#' + issue.id + ' ' + issue.title,
            issueType: 'GITLAB' as const,
            issueData: issue,
          };
        }),
      ),
    );
  }

  getProjectIssues$(cfg: GitlabCfg): Observable<GitlabIssue[]> {
    return this._resolveScopeVariables$(cfg).pipe(
      mergeMap((scopeVars) =>
        this._paginateAll$(cfg, {
          fullPath: this._resolveFullPath(cfg),
          first: PAGE_SIZE,
          state: 'opened',
          sort: 'UPDATED_DESC',
          ...scopeVars,
        }),
      ),
      map((nodes) => nodes.map((node) => mapGitlabGqlIssue(node, cfg))),
      take(1),
    );
  }

  updateWorkItem$(
    input: GitlabGqlWorkItemUpdateInput,
    cfg: GitlabCfg,
  ): Observable<GitlabGqlWorkItemUpdatePayload> {
    return this._post$<{ workItemUpdate: GitlabGqlWorkItemUpdatePayload }>(
      cfg,
      WORK_ITEM_UPDATE_MUTATION,
      { input },
      // A write failing (validation, permissions, unsupported widget) must
      // not disable GraphQL reads for the session.
      false,
    ).pipe(
      map((data) => {
        const payload = data.workItemUpdate;
        if (payload.errors && payload.errors.length > 0) {
          // Application-level errors (validation failures, missing widget,
          // permission errors) come back in payload.errors — surface them.
          throw new Error(`GitLab workItemUpdate: ${payload.errors.join('; ')}`);
        }
        return payload;
      }),
    );
  }

  /**
   * Resolves the custom Status widget's allowed values for the project's
   * Issue work-item type (#19). Returns `[]` when the instance doesn't
   * expose the widget (CE / no license / older GitLab) — callers treat an
   * empty list as "no custom statuses, fall back to state". Prefers the
   * Issue type's allowed set; falls back to the first type that populates
   * any (early lifecycles only wired the Task type).
   */
  getAllowedStatuses$(
    cfg: GitlabCfg,
    projectPath?: string,
  ): Observable<{ id: string; name: string }[]> {
    return this._post$<ProjectStatusesResponse>(
      cfg,
      PROJECT_STATUSES_QUERY,
      { fullPath: this._resolveFullPath(cfg, projectPath) },
      // Optional widget — never let its absence disable the core read path.
      false,
    ).pipe(
      map((data) => {
        const types = data.namespace?.workItemTypes?.nodes ?? [];
        const statusesForType = (
          type: (typeof types)[number] | undefined,
        ): { id: string; name: string }[] =>
          (type?.widgetDefinitions ?? []).flatMap((w) => w.allowedStatuses ?? []);
        const issueType = types.find((t) => t.name?.toLowerCase() === 'issue');
        let statuses = statusesForType(issueType);
        if (!statuses.length) {
          for (const type of types) {
            statuses = statusesForType(type);
            if (statuses.length) break;
          }
        }
        const seen = new Set<string>();
        const deduped: { id: string; name: string }[] = [];
        for (const s of statuses) {
          if (s?.id && !seen.has(s.id)) {
            seen.add(s.id);
            deduped.push({ id: s.id, name: s.name });
          }
        }
        return deduped;
      }),
    );
  }

  // --- internals ---------------------------------------------------------

  private _resolveFullPath(cfg: GitlabCfg, override?: string): string {
    const raw = override ?? assertTruthy(cfg.project);
    // GraphQL wants a decoded path — REST callers stored either `group/repo`
    // or the pre-encoded `group%2Frepo` form.
    return raw.includes('%2F') || raw.includes('%2f') ? decodeURIComponent(raw) : raw;
  }

  private _paginateAll$(
    cfg: GitlabCfg,
    initialVars: Record<string, unknown>,
  ): Observable<GitlabGqlIssue[]> {
    return this._queryProjectIssuesPage$(cfg, initialVars).pipe(
      expand((page) =>
        page.pageInfo.hasNextPage
          ? this._queryProjectIssuesPage$(cfg, {
              ...initialVars,
              after: page.pageInfo.endCursor,
            })
          : EMPTY,
      ),
      reduce<GitlabGqlIssueConnection, GitlabGqlIssue[]>(
        (acc, page) => acc.concat(page.nodes),
        [],
      ),
    );
  }

  private _queryProjectIssuesPage$(
    cfg: GitlabCfg,
    variables: Record<string, unknown>,
  ): Observable<GitlabGqlIssueConnection> {
    return this._post$<GitlabGqlProjectIssuesResponse>(
      cfg,
      PROJECT_ISSUES_QUERY,
      variables,
    ).pipe(
      map((data) => {
        if (!data.project) {
          // Either the token can't see this project OR the path is wrong. Same
          // shape as REST 404s in practice — bail out so we can fall back.
          throw new Error(
            `GitLab project "${variables.fullPath}" not found or not accessible`,
          );
        }
        return data.project.issues;
      }),
    );
  }

  private _resolveScopeVariables$(
    cfg: GitlabCfg,
  ): Observable<{ authorUsername?: string; assigneeUsernames?: string[] }> {
    const scope = cfg.scope;
    if (!scope || scope === 'all') {
      return of({});
    }
    return this._currentUsername$(cfg).pipe(
      map((username) => {
        if (!username) {
          return {};
        }
        if (scope === 'created-by-me') {
          return { authorUsername: username };
        }
        if (scope === 'assigned-to-me') {
          return { assigneeUsernames: [username] };
        }
        return {};
      }),
    );
  }

  private _currentUsername$(cfg: GitlabCfg): Observable<string | null> {
    const key = this._endpoint(cfg);
    if (this._currentUserByEndpoint.has(key)) {
      return of(this._currentUserByEndpoint.get(key) ?? null);
    }
    return this._post$<CurrentUserResponse>(cfg, CURRENT_USER_QUERY, {}).pipe(
      map((data) => data.currentUser?.username ?? null),
      // Only cache on success; a network error rejects and the next poll retries.
      tap((username) => this._currentUserByEndpoint.set(key, username)),
    );
  }

  private _post$<T>(
    cfg: GitlabCfg,
    query: string,
    variables: Record<string, unknown>,
    // Optional queries (e.g. the custom Status widget, which many instances
    // don't expose) pass `false` so their failure DOESN'T disable GraphQL
    // for the whole session — otherwise a widget the server doesn't support
    // would poison the core issue-read path down to REST. They still reject,
    // so the caller's own try/catch handles the miss.
    markUnavailableOnError = true,
  ): Observable<T> {
    return defer(() => {
      const url = this._endpoint(cfg);
      const headers = new HttpHeaders({
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Content-Type': 'application/json',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        ...(cfg.token ? { 'PRIVATE-TOKEN': cfg.token } : {}),
      });
      return this._http
        .post<
          GitlabGqlResponse<T>
        >(url, { query, variables }, { headers, observe: 'body' })
        .pipe(
          map((res) => this._unwrap<T>(res, cfg, markUnavailableOnError)),
          catchError((err) => this._onTransportError$(err, cfg, markUnavailableOnError)),
        );
    });
  }

  private _unwrap<T>(
    res: GitlabGqlResponse<T>,
    cfg: GitlabCfg,
    markUnavailableOnError = true,
  ): T {
    if (res.errors && res.errors.length > 0) {
      const messages = res.errors.map((e) => e.message).join('; ');
      IssueLog.log('GitLab GraphQL errors', { messages });
      if (markUnavailableOnError) this._markUnavailable(cfg);
      throw {
        [HANDLED_ERROR_PROP_STR]: `${ISSUE_PROVIDER_HUMANIZED[GITLAB_TYPE]}: ${messages}`,
        gitlabGraphqlUnavailable: GITLAB_GRAPHQL_UNAVAILABLE,
      };
    }
    if (!res.data) {
      if (markUnavailableOnError) this._markUnavailable(cfg);
      throw {
        [HANDLED_ERROR_PROP_STR]: `${ISSUE_PROVIDER_HUMANIZED[GITLAB_TYPE]}: empty GraphQL response`,
        gitlabGraphqlUnavailable: GITLAB_GRAPHQL_UNAVAILABLE,
      };
    }
    return res.data;
  }

  private _onTransportError$(
    err: unknown,
    cfg: GitlabCfg,
    markUnavailableOnError = true,
  ): Observable<never> {
    // Any transport-level failure disables GraphQL for this session so the
    // caller's REST fallback takes over — no snack here, since the fallback
    // will render its own errors if IT also fails. Optional queries opt out
    // (see `_post$`) so they can't drag the whole endpoint down.
    IssueLog.log('GitLab GraphQL request failed', {
      hasStatus: !!(err as { status?: number }).status,
    });
    if (markUnavailableOnError) this._markUnavailable(cfg);
    return throwError({
      [HANDLED_ERROR_PROP_STR]: `${ISSUE_PROVIDER_HUMANIZED[GITLAB_TYPE]}: GraphQL transport error`,
      gitlabGraphqlUnavailable: GITLAB_GRAPHQL_UNAVAILABLE,
      cause: err,
    });
  }

  private _markUnavailable(cfg: GitlabCfg): void {
    this._disabledEndpoints.add(this._endpoint(cfg));
  }

  private _endpoint(cfg: GitlabCfg): string {
    if (cfg.gitlabBaseUrl) {
      const withSlash = cfg.gitlabBaseUrl.endsWith('/')
        ? cfg.gitlabBaseUrl
        : cfg.gitlabBaseUrl + '/';
      return withSlash + 'api/graphql';
    }
    return GITLAB_BASE_URL + 'api/graphql';
  }
}
