import {
  GitlabOriginalComment,
  GitlabOriginalIssueState,
  GitlabOriginalMilestone,
  GitlabOriginalUser,
} from './gitlab-api/gitlab-api-responses';

export type GitlabState = GitlabOriginalIssueState;
export type GitlabUser = GitlabOriginalUser;
export type GitlabComment = GitlabOriginalComment;

// Populated only when the issue was fetched via the Work Items GraphQL API on a
// GitLab tier that exposes the status widget (Premium/Ultimate). Absent for REST
// results and instances without the widget.
export interface GitlabWorkItemStatus {
  readonly name: string;
  readonly category: string;
}

export type GitlabIssue = Readonly<{
  // repository_url: string;
  // labels_url: string;
  // comments_url: string;
  // events_url: string;
  html_url: string;

  number: number;
  state: GitlabState;
  title: string;
  body: string;
  user: GitlabUser;
  labels: string[];
  assignee: GitlabUser;
  milestone: GitlabOriginalMilestone;
  // locked: boolean;
  // active_lock_reason: string;
  // pull_request: GitlabPullRequest;
  closed_at: string;
  created_at: string;
  updated_at: string;
  due_date?: string;
  // added
  wasUpdated: boolean;
  commentsNr: number;
  // apiUrl: string;
  // _id: number;
  // transformed
  comments: GitlabComment[];
  url: string;
  id: string; // global id, not compatible with the Gitlab API
  // iid: number; // project specific id, i.e. the issue number #123

  // according to the docs: "Users on GitLab Starter, Bronze, or higher will also see the weight parameter"
  weight?: number;
  links: {
    self: string;
    notes: string;
    award_emoji: string;
    project: string;
  };
  // Custom lifecycle status from the Work Items status widget.
  status?: GitlabWorkItemStatus;
  // Global ID (gid://gitlab/Issue/...) used by workItemUpdate. Present only on
  // GraphQL-sourced issues.
  workItemGid?: string;
}>;
