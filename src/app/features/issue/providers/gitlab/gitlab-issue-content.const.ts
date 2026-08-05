import { T } from '../../../../t.const';
import {
  IssueContentConfig,
  IssueFieldType,
} from '../../issue-content/issue-content.model';
import { IssueProviderKey } from '../../issue.model';
import { GitlabIssue } from './gitlab-issue.model';

export const GITLAB_ISSUE_CONTENT_CONFIG: IssueContentConfig<GitlabIssue> = {
  issueType: 'GITLAB' as IssueProviderKey,
  fields: [
    {
      label: T.F.ISSUE.ISSUE_CONTENT.SUMMARY,
      type: IssueFieldType.LINK,
      value: (issue: GitlabIssue) => `${issue.title} #${issue.number}`,
      getLink: (issue: GitlabIssue) => issue.html_url,
    },
    {
      // GitLab's issue lifecycle "State" (opened/closed) — renamed from
      // "Status" to match GitLab's current terminology, where "Status" now
      // refers to the customizable work-item status widget (see below).
      label: T.F.GITLAB.ISSUE_CONTENT.STATE,
      type: IssueFieldType.TEXT,
      // `state` is stored in REST vocabulary ('open'|'closed'); display it in
      // GitLab's UI wording ('opened'|'closed').
      value: (issue: GitlabIssue) => (issue.state === 'closed' ? 'closed' : 'opened'),
    },
    {
      // The customizable work-item "Status" (e.g. "New request", "In
      // progress"), fetched via the GraphQL status widget. Only present on
      // tiers/instances that expose it.
      label: T.F.GITLAB.ISSUE_CONTENT.STATUS,
      type: IssueFieldType.TEXT,
      value: (issue: GitlabIssue) => issue.status?.name,
      isVisible: (issue: GitlabIssue) => !!issue.status?.name,
    },
    {
      label: T.F.ISSUE.ISSUE_CONTENT.ASSIGNEE,
      type: IssueFieldType.LINK,
      value: (issue: GitlabIssue) => issue.assignee?.username,
      getLink: (issue: GitlabIssue) => issue.assignee?.web_url || '',
      isVisible: (issue: GitlabIssue) => !!issue.assignee,
    },
    {
      label: T.F.ISSUE.ISSUE_CONTENT.LABELS,
      type: IssueFieldType.CHIPS,
      value: (issue: GitlabIssue) => issue.labels?.map((l: string) => ({ name: l })),
      isVisible: (issue: GitlabIssue) => (issue.labels?.length ?? 0) > 0,
    },
    {
      label: T.F.ISSUE.ISSUE_CONTENT.DESCRIPTION,
      value: 'body',
      type: IssueFieldType.MARKDOWN,
      isVisible: (issue: GitlabIssue) => !!issue.body,
    },
  ],
  comments: {
    field: 'comments',
    authorField: 'author.username',
    bodyField: 'body',
    createdField: 'created_at',
    sortField: 'created_at',
  },
  getIssueUrl: (issue: GitlabIssue) => issue.url,
  hasCollapsingComments: true,
};
