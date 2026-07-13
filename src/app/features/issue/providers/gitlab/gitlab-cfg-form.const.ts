import { T } from '../../../../t.const';
import {
  ConfigFormSection,
  LimitedFormlyFieldConfig,
} from '../../../config/global-config.model';
import { IssueProviderGitlab } from '../../issue.model';
import {
  CROSS_ORIGIN_WARNING,
  ISSUE_PROVIDER_COMMON_FORM_FIELDS,
} from '../../common-issue-form-stuff.const';
// A GitLab project reference is EITHER a numeric project ID OR a namespace-qualified
// path (`group/project`, subgroups, or the `%2F`-encoded form) — the REST API has no
// way to resolve a project by a bare slug, so a single-segment name like `test_config`
// always 404s at poll time (#8665). Require a path separator (`/` or `%2F`) for the
// non-numeric branch so that mistake gets inline feedback instead. Still permissive
// about the segment chars (e.g. consecutive hyphens, which GitLab paths allow) to
// avoid false-rejecting valid paths; the separator lookahead keeps the char class a
// single unnested quantifier (no catastrophic backtracking).
export const GITLAB_PROJECT_REGEX = /^(?:[1-9][0-9]*|(?=.*(?:\/|%2F))[\w.%/-]+)$/i;

// A GitLab group reference is a numeric ID OR a path segment. Unlike projects,
// a top-level group like `my-org` is a valid reference (that's the whole point
// of group-scan mode for enterprise users with one root namespace), so we do
// NOT require a slash separator here.
export const GITLAB_GROUP_REGEX = /^(?:[1-9][0-9]*|[\w.%/-]+)$/i;

// Source-mode helpers referenced by hide/require expressions.
const isProjectMode = (model: { sourceMode?: string }): boolean =>
  !model.sourceMode || model.sourceMode === 'project';
const isGroupMode = (model: { sourceMode?: string }): boolean =>
  model.sourceMode === 'group';

export const GITLAB_CONFIG_FORM: LimitedFormlyFieldConfig<IssueProviderGitlab>[] = [
  ...CROSS_ORIGIN_WARNING,
  {
    key: 'sourceMode',
    type: 'select',
    defaultValue: 'project',
    templateOptions: {
      required: true,
      label: T.F.GITLAB.FORM.SOURCE_MODE,
      description: T.F.GITLAB.FORM.SOURCE_MODE_HINT,
      options: [
        { value: 'project', label: T.F.GITLAB.FORM.SOURCE_MODE_PROJECT },
        { value: 'group', label: T.F.GITLAB.FORM.SOURCE_MODE_GROUP },
        { value: 'all-assigned', label: T.F.GITLAB.FORM.SOURCE_MODE_ALL_ASSIGNED },
      ],
    },
  },
  {
    key: 'project',
    type: 'input',
    hideExpression: (model: any) => !isProjectMode(model),
    templateOptions: {
      label: T.F.GITLAB.FORM.PROJECT,
      type: 'text',
      pattern: GITLAB_PROJECT_REGEX,
      description: T.F.GITLAB.FORM.PROJECT_HINT,
    },
    expressionProperties: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'templateOptions.required': (model: any) => isProjectMode(model),
    },
  },
  {
    key: 'group',
    type: 'input',
    hideExpression: (model: any) => !isGroupMode(model),
    templateOptions: {
      label: T.F.GITLAB.FORM.GROUP,
      type: 'text',
      pattern: GITLAB_GROUP_REGEX,
      description: T.F.GITLAB.FORM.GROUP_HINT,
    },
    expressionProperties: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'templateOptions.required': (model: any) => isGroupMode(model),
    },
  },
  {
    key: 'token',
    type: 'input',
    templateOptions: {
      label: T.F.GITLAB.FORM.TOKEN,
      type: 'password',
    },
    validation: {
      show: true,
    },
    expressionProperties: {
      // Token required whenever the config has enough source info to actually
      // poll — mirrors the old `!!model.project` behavior across all three
      // source modes. Empty config keeps the field optional so the initial
      // paint doesn't show a red "required" error.
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'templateOptions.required': (model: any) =>
        !!model.project || !!model.group || model.sourceMode === 'all-assigned',
    },
  },
  {
    type: 'link',
    templateOptions: {
      url: 'https://github.com/super-productivity/super-productivity/blob/master/docs/gitlab-access-token-instructions.md',
      txt: T.F.ISSUE.HOW_TO_GET_A_TOKEN,
    },
  },
  {
    type: 'collapsible',
    // todo translate
    props: { label: 'Advanced Config' },
    fieldGroup: [
      {
        key: 'scope',
        type: 'select',
        defaultValue: 'created-by-me',
        // Only project/group listings honour the scope param — in all-assigned
        // mode the API service forces scope=assigned_to_me, so the field is
        // meaningless.
        hideExpression: (model: any) => model.sourceMode === 'all-assigned',
        templateOptions: {
          required: true,
          label: T.F.GITLAB.FORM.SCOPE,
          options: [
            { value: 'all', label: T.F.GITLAB.FORM.SCOPE_ALL },
            { value: 'created-by-me', label: T.F.GITLAB.FORM.SCOPE_CREATED },
            { value: 'assigned-to-me', label: T.F.GITLAB.FORM.SCOPE_ASSIGNED },
          ],
        },
      },
      {
        key: 'gitlabBaseUrl',
        type: 'input',
        templateOptions: {
          label: T.F.GITLAB.FORM.GITLAB_BASE_URL,
          type: 'url',
          pattern:
            /^(http(s)?:\/\/)?(localhost|[\w.\-]+(?:\.[\w\.\-]+)+)(:\d+)?(\/[^\s]*)?$/i,
        },
      },
      ...ISSUE_PROVIDER_COMMON_FORM_FIELDS,
      {
        key: 'filterUsername',
        type: 'input',
        templateOptions: {
          label: T.F.GITLAB.FORM.FILTER_USER,
          description:
            'To filter out comments and other changes by yourself when polling for issue updates',
        },
      },
      {
        key: 'filter',
        type: 'input',
        templateOptions: {
          type: 'text',
          label: T.F.GITLAB.FORM.FILTER,
          description: T.F.GITLAB.FORM.FILTER_DESCRIPTION,
        },
      },
      {
        key: 'isEnableTimeTracking',
        type: 'checkbox',
        templateOptions: {
          label: T.F.GITLAB.FORM.SUBMIT_TIMELOGS,
          description: T.F.GITLAB.FORM.SUBMIT_TIMELOGS_DESCRIPTION,
        },
      },
      {
        key: 'isSyncLabelsAsTags',
        type: 'checkbox',
        templateOptions: {
          label: T.F.GITLAB.FORM.SYNC_LABELS_AS_TAGS,
          description: T.F.GITLAB.FORM.SYNC_LABELS_AS_TAGS_DESCRIPTION,
        },
      },
      {
        key: 'pollIntervalMinutes',
        type: 'input',
        templateOptions: {
          label: T.F.GITLAB.FORM.POLL_INTERVAL_MINUTES,
          type: 'number',
          min: 1,
        },
      },
    ],
  },
];

export const GITLAB_CONFIG_FORM_SECTION: ConfigFormSection<IssueProviderGitlab> = {
  title: 'GitLab',
  key: 'GITLAB',
  items: GITLAB_CONFIG_FORM,
  help: T.F.GITLAB.FORM_SECTION.HELP,
};
