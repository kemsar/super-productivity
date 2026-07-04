import { GitlabIssue } from './gitlab-issue.model';
import {
  GitlabOriginalComment,
  GitlabOriginalIssue,
  GitlabOriginalIssueState,
  GitlabOriginalUser,
} from './gitlab-api/gitlab-api-responses';
import {
  GitlabGqlIssue,
  GitlabGqlIssueState,
  GitlabGqlUser,
} from './gitlab-api/gitlab-graphql-responses';
import { IssueProviderKey, SearchResultItem } from '../../issue.model';
import { GitlabCfg } from './gitlab.model';

export const mapGitlabIssue = (
  issue: GitlabOriginalIssue,
  cfg: GitlabCfg,
): GitlabIssue => {
  return {
    html_url: issue.web_url,

    number: issue.iid,
    // iid: issue.iid,
    state: issue.state,
    title: issue.title,
    body: issue.description,
    user: issue.author,
    labels: issue.labels,
    assignee: issue.assignee,
    milestone: issue.milestone as any,
    closed_at: issue.closed_at,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    due_date: issue.due_date,

    // added
    wasUpdated: false,
    commentsNr: issue.user_notes_count,
    // _id: issue.id,

    // transformed
    comments: [],
    url: issue.web_url,
    // NOTE: we use the issue number as id as well, as it there is not much to be done with the id with the api
    // when we can get issues from multiple projects we use full reference as id
    // also @see below
    // e.g.: johannesjo/test-repo#44
    id: issue.references.full,
    links: issue._links,
  };
};

/* Explanation:
 * We're doing this, since the id property is something only admins can use and more of an internal GitLab thing.
 * Since iid is just a number that is counted up, we use issue.reference.full which translates to
 * "johannesjo/test-repo#44"
 * */
export const getPartsFromGitlabIssueId = (
  issueId: string,
): { project: string; projectIssueId: string } => {
  const parts = issueId.split('#');
  const project = parts[0];
  const projectIssueId = parts[1];

  if (!project || !projectIssueId) {
    throw new Error('Cannot parse GitLab project and issueId');
  }

  return {
    project,
    projectIssueId,
  };
};

// export const getGitlabFullIssueRef = (
//   issue: string | number,
//   projectConfig: GitlabCfg,
// ): string => {
//   if (getPartsFromGitlabIssueUrl(issue).length === 2) {
//     return issue.toString();
//   } else {
//     return this.getProject(projectConfig, issue) + '#' + this._getIidFromIssue(issue);
//   }
// };

export const mapGitlabIssueToSearchResult = (issue: GitlabIssue): SearchResultItem => {
  return {
    title: '#' + issue.id + ' ' + issue.title,
    issueType: 'GITLAB' as IssueProviderKey,
    issueData: issue,
  };
};

const _gqlStateToRestState = (state: GitlabGqlIssueState): GitlabOriginalIssueState => {
  // GraphQL uses "opened"/"closed"/"locked", REST uses "open"/"closed". The
  // rest of the app treats "closed" as done and everything else as active, so
  // preserve the exact REST vocabulary here to avoid drift.
  if (state === 'closed') return 'closed';
  if (state === 'all') return 'all';
  return 'open';
};

const _gqlUserToRestUser = (user: GitlabGqlUser | null): GitlabOriginalUser => {
  if (!user) {
    return {
      id: 0,
      username: '',
      name: '',
      state: 'active',
      avatar_url: '',
      web_url: '',
    };
  }
  return {
    id: _gidToNumber(user.id),
    username: user.username,
    name: user.name,
    state: 'active',
    avatar_url: user.avatarUrl || '',
    web_url: user.webUrl,
  };
};

// Global IDs look like "gid://gitlab/User/123". The rest of the app only cares
// about equality — a numeric fallback keeps the existing REST-typed field
// happy without introducing a schema change.
const _gidToNumber = (gid: string): number => {
  const match = /\/(\d+)$/.exec(gid);
  return match ? Number(match[1]) : 0;
};

const _projectSlugFromReference = (reference: string): string => {
  // reference(full: true) → "group/repo#42"; we want "group/repo".
  const hashIdx = reference.indexOf('#');
  return hashIdx >= 0 ? reference.slice(0, hashIdx) : reference;
};

export const mapGitlabGqlIssue = (node: GitlabGqlIssue, cfg: GitlabCfg): GitlabIssue => {
  const iid = Number(node.iid);
  const project = _projectSlugFromReference(node.reference) || (cfg.project ?? '');
  const comments: GitlabOriginalComment[] = node.notes.nodes
    .filter((n) => !n.system)
    .map((n) => ({
      id: _gidToNumber(n.id),
      body: n.body,
      attachment: '',
      author: _gqlUserToRestUser(n.author),
      created_at: n.createdAt,
      updated_at: n.updatedAt,
      system: n.system,
      noteable_id: _gidToNumber(node.id),
      noteable_type: 'Issue',
      noteable_iid: iid,
      resolvable: false,
    }));

  // links.* are unused for GraphQL-sourced issues (comments come inline) but
  // the type is required; synthesize best-effort URLs so anything that logs
  // them still gets a plausible value.
  const restProjectApi = _restProjectApiBase(cfg, project);
  const restIssueApi = `${restProjectApi}/issues/${iid}`;

  return {
    html_url: node.webUrl,
    number: iid,
    state: _gqlStateToRestState(node.state),
    title: node.title,
    body: node.description ?? '',
    user: _gqlUserToRestUser(node.author),
    labels: node.labels.nodes.map((l) => l.title),
    assignee: _gqlUserToRestUser(node.assignees.nodes[0] ?? null),
    // Milestone isn't queried today; casting `null` mirrors what happens with
    // REST when the field is absent (the type says `unknown`).
    milestone: null as never,
    closed_at: node.closedAt ?? '',
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    due_date: node.dueDate ?? undefined,
    wasUpdated: false,
    commentsNr: comments.length,
    comments,
    url: node.webUrl,
    id: node.reference,
    weight: node.weight ?? undefined,
    links: {
      self: restIssueApi,
      notes: `${restIssueApi}/notes`,
      award_emoji: `${restIssueApi}/award_emoji`,
      project: restProjectApi,
    },
    status: node.status
      ? { name: node.status.name, category: node.status.category }
      : undefined,
    workItemGid: node.id,
  };
};

const _restProjectApiBase = (cfg: GitlabCfg, project: string): string => {
  const base = cfg.gitlabBaseUrl
    ? cfg.gitlabBaseUrl.endsWith('/')
      ? cfg.gitlabBaseUrl
      : cfg.gitlabBaseUrl + '/'
    : 'https://gitlab.com/';
  return `${base}api/v4/projects/${encodeURIComponent(project)}`;
};
