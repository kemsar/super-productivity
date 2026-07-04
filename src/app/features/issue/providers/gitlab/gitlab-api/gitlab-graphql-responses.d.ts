// GraphQL response shapes for GitLab's Work Items / Issues API.
// The field selection here matches the queries in gitlab-graphql-api.service.ts;
// changing one without the other will silently break the mapper.

export type GitlabGqlIssueState = 'opened' | 'closed' | 'locked' | 'all';

export interface GitlabGqlWorkItemStatus {
  readonly id: string;
  readonly name: string;
  // "TRIAGE" | "IN_PROGRESS" | "DONE" | "CANCELLED" (custom lifecycle categories).
  readonly category: string;
}

export interface GitlabGqlWorkItemType {
  readonly id: string;
  readonly name: string;
}

export interface GitlabGqlUser {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly webUrl: string;
  readonly avatarUrl: string | null;
}

export interface GitlabGqlLabel {
  readonly id: string;
  readonly title: string;
}

export interface GitlabGqlNote {
  readonly id: string;
  readonly body: string;
  readonly bodyHtml: string | null;
  readonly system: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly author: GitlabGqlUser | null;
}

export interface GitlabGqlPageInfo {
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

export interface GitlabGqlIssue {
  // Global ID (e.g. "gid://gitlab/Issue/12345") — the identifier workItemUpdate expects.
  readonly id: string;
  readonly iid: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: GitlabGqlIssueState;
  readonly webUrl: string;
  readonly reference: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly dueDate: string | null;
  readonly weight: number | null;
  readonly workItemType: GitlabGqlWorkItemType | null;
  // `status` is exposed only on Premium/Ultimate with the WorkItem status widget
  // enabled; queries that select it against older/CE instances will return an
  // error, which the service treats as a signal to fall back to REST for the
  // remainder of the session.
  readonly status: GitlabGqlWorkItemStatus | null;
  readonly author: GitlabGqlUser | null;
  readonly assignees: { readonly nodes: readonly GitlabGqlUser[] };
  readonly labels: { readonly nodes: readonly GitlabGqlLabel[] };
  readonly notes: { readonly nodes: readonly GitlabGqlNote[] };
}

export interface GitlabGqlIssueConnection {
  readonly pageInfo: GitlabGqlPageInfo;
  readonly nodes: readonly GitlabGqlIssue[];
}

export interface GitlabGqlProjectIssuesResponse {
  readonly project: {
    readonly id: string;
    readonly issues: GitlabGqlIssueConnection;
  } | null;
}

export interface GitlabGqlError {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface GitlabGqlResponse<T> {
  readonly data: T | null;
  readonly errors?: readonly GitlabGqlError[];
}

export interface GitlabGqlWorkItemUpdatePayload {
  readonly workItem: { readonly id: string } | null;
  readonly errors: readonly string[];
}

export interface GitlabGqlWorkItemUpdateInput {
  readonly id: string;
  readonly stateEvent?: 'CLOSE' | 'REOPEN';
  readonly title?: string;
  readonly descriptionWidget?: { description: string };
  readonly startAndDueDateWidget?: { dueDate: string | null };
  readonly labelsWidget?: {
    addLabelIds?: readonly string[];
    removeLabelIds?: readonly string[];
  };
  readonly statusWidget?: { status: string };
}
