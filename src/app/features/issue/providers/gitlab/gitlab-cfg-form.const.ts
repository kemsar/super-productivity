import { FormlyFieldConfig } from '@ngx-formly/core';
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

// Contextual override for the shared default-project field: in group mode
// the "None" value on the parent provider triggers per-issue routing via the
// tree-import mapping (see gitlab-common-interfaces.service.getAddTaskDataForCfg),
// so relabel that option to describe the actual behavior. The label switches
// whenever the config is in group mode — even before an import has populated
// the mapping — so users can see the routing option while they're setting up
// the "Generate SP tree on save" checkbox.
const _isGroupMode = (model: unknown): boolean =>
  !!model && (model as { sourceMode?: string }).sourceMode === 'group';
const gitlabCommonFields: LimitedFormlyFieldConfig<IssueProviderGitlab>[] =
  ISSUE_PROVIDER_COMMON_FORM_FIELDS.map((field) => {
    if (field.key === 'defaultProjectId') {
      return {
        ...field,
        expressions: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'props.defaultLabel': (f: FormlyFieldConfig) =>
            _isGroupMode(f.model)
              ? T.F.GITLAB.FORM.DEFAULT_PROJECT_TREE_ROUTED
              : T.G.NONE,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'props.description': (f: FormlyFieldConfig) =>
            _isGroupMode(f.model)
              ? T.F.GITLAB.FORM.DEFAULT_PROJECT_TREE_ROUTED_HINT
              : T.F.ISSUE.DEFAULT_PROJECT_DESCRIPTION,
        },
      };
    }
    if (field.key === 'isAutoAddToBacklog') {
      // The shared rule disables auto-import unless a defaultProjectId is set.
      // Tree-import group providers deliberately have no default (routing
      // happens per-issue via treeImportMapping — see
      // gitlab-common-interfaces.service.getAddTaskDataForCfg), so allow the
      // checkbox in group mode regardless.
      return {
        ...field,
        expressions: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          'props.disabled': (f: FormlyFieldConfig) =>
            !_isGroupMode(f.model) && !f.model?.defaultProjectId,
        },
      };
    }
    return field;
  });
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
      ...gitlabCommonFields,
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
      // Bot IDs for the aging-issues view (issue #18). Stored as a CSV
      // string on cfg so the form can be a plain text input; the GitLab
      // common-interfaces service parses it at read time. Users can paste
      // the same value they'd use for the digest's BOT_IDS env.
      {
        key: 'botAuthorIds',
        type: 'input',
        templateOptions: {
          label: T.F.GITLAB.FORM.BOT_AUTHOR_IDS,
          description: T.F.GITLAB.FORM.BOT_AUTHOR_IDS_DESCRIPTION,
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
