import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import typia from 'typia';
import { TaskService } from '../../features/tasks/task.service';
import { Task, TaskWithSubTasks } from '../../features/tasks/task.model';
import { TaskArchiveService } from '../../features/archive/task-archive.service';
import { ProjectService } from '../../features/project/project.service';
import { TagService } from '../../features/tag/tag.service';
import { TODAY_TAG } from '../../features/tag/tag.const';
import { DateService } from '../date/date.service';
import { isTodayWithOffset } from '../../util/is-today.util';
import { isValidDBDateStr } from '../../util/get-db-date-str';

import { TaskSharedActions } from '../../root-store/meta/task-shared.actions';
import { getDeadlineAutoPlanFields } from '../../features/tasks/util/get-deadline-auto-plan-fields';
import {
  selectCurrentCycle,
  selectIsBreakTimeUp,
  selectIsInOvertime,
  selectIsLongBreak,
  selectIsRunning,
  selectIsSessionCompleted,
  selectMode,
  selectTimeRemaining,
  selectTimer,
} from '../../features/focus-mode/store/focus-mode.selectors';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';
import { parseQuickAddText } from '../../../../electron/shared-with-frontend/quick-add-parser';
import { selectEnabledIssueProviders } from '../../features/issue/store/issue-provider.selectors';
import { NavigateToTaskService } from '../../core-ui/navigate-to-task/navigate-to-task.service';
import { GitlabLocalRestApiService } from '../../features/issue/providers/gitlab/gitlab-local-rest-api.service';
import {
  createErrorResponse,
  createSuccessResponse,
  getQueryParam,
  getQueryParamAsBoolean,
} from './local-rest-api-response';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Removes only the `#<label>` tokens (whitespace-delimited) the parser
 * extracted, leaving every other overlay token (`!project`, `~date`,
 * `##milestone`, ...) untouched. Tokens are whitespace-terminated so a
 * label value never contains spaces; `##milestone` is safe because its
 * token is `##milestone`, never `#<label>`.
 */
const stripQuickAddLabelTokens = (rawTitle: string, labels: string[]): string => {
  if (!labels.length) return rawTitle;
  const tokens = new Set(labels.map((l) => '#' + l));
  return rawTitle
    .split(/\s+/)
    .filter((word) => !tokens.has(word))
    .join(' ')
    .trim();
};

/** Only these fields may be set via the REST API to prevent state corruption. */
const ALLOWED_TASK_FIELDS = new Set<string>([
  'title',
  'notes',
  'isDone',
  'timeEstimate',
  'timeSpent',
  'projectId',
  'tagIds',
  'dueDay',
  'dueWithTime',
  'plannedAt',
  'deadlineDay',
  'deadlineWithTime',
  'deadlineRemindAt',
]);

/**
 * Relational fields that callers often try to set but must be rejected:
 * mutating them as plain values corrupts invariants (parent<->child links,
 * projectId inheritance, tag-ordering lists). Subtask creation is available
 * via `POST /tasks` with `parentId` — see `_handleCreateTask`.
 */
const REJECTED_TASK_FIELDS = ['parentId', 'subTaskIds'] as const;

/**
 * Fields a subtask inherits from its parent at the reducer (`addSubTask`
 * forces `tagIds: []` and `projectId = parent.projectId`). Reject them on
 * subtask create so callers don't get a 201 with values different from what
 * they sent.
 */
const SUBTASK_INHERITED_FIELDS = ['projectId', 'tagIds'] as const;

const pickAllowedFields = (body: Record<string, unknown>): Partial<Task> => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (ALLOWED_TASK_FIELDS.has(key)) {
      result[key] = body[key];
    }
  }
  return result as Partial<Task>;
};

/**
 * Value-level types for the fields writable via the REST API. Keys mirror
 * ALLOWED_TASK_FIELDS; `pickAllowedFields` filters by key only, so this is
 * where the *values* get checked. Without it a caller could push a wrong-typed
 * value (e.g. `tagIds: 123`, `timeEstimate: 'abc'`) straight into the store and
 * the synced op-log, where it corrupts state locally and trips typia-as-corrupt
 * on other devices when the op replays.
 */
interface WritableTaskFields {
  title?: string;
  notes?: string;
  isDone?: boolean;
  timeEstimate?: number;
  timeSpent?: number;
  projectId?: string;
  tagIds?: string[];
  dueDay?: string | null;
  dueWithTime?: number | null;
  plannedAt?: number;
  deadlineDay?: string | null;
  deadlineWithTime?: number | null;
  deadlineRemindAt?: number | null;
}

type FieldTypeError = { path: string; expected: string };

/**
 * Validates the value types of already-key-filtered task fields. The create
 * path is separately guarded by `typia.assert<Task>` in the task service (a
 * bad value throws → generic 500); validating here lets both create and PATCH
 * reject bad input with a clean 400 before anything is dispatched.
 */
const validateWritableFields = (
  fields: Partial<Task>,
): { ok: true } | { ok: false; errors: FieldTypeError[] } => {
  const result = typia.validate<WritableTaskFields>(fields);
  if (result.success) {
    return { ok: true };
  }
  return {
    ok: false,
    errors: result.errors.map((e) => ({ path: e.path, expected: e.expected })),
  };
};

const DEADLINE_FIELDS = ['deadlineDay', 'deadlineWithTime', 'deadlineRemindAt'] as const;

type DeadlineChange =
  | {
      type: 'set';
      fields: {
        deadlineDay?: string;
        deadlineWithTime?: number;
        deadlineRemindAt?: number;
      };
    }
  | { type: 'clearReminder' }
  | { type: 'remove' };

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const validateDeadlineFields = (
  fields: Partial<WritableTaskFields>,
): string | undefined => {
  if (fields.deadlineDay != null && fields.deadlineWithTime != null) {
    return 'deadlineDay and deadlineWithTime cannot both be set';
  }
  if (typeof fields.deadlineDay === 'string' && !isValidDBDateStr(fields.deadlineDay)) {
    return 'deadlineDay must be a valid YYYY-MM-DD date';
  }
  if (fields.deadlineWithTime != null && fields.deadlineWithTime <= 0) {
    return 'deadlineWithTime must be a positive timestamp';
  }
  if (fields.deadlineRemindAt != null && fields.deadlineRemindAt <= 0) {
    return 'deadlineRemindAt must be a positive timestamp';
  }
  return undefined;
};

/**
 * Resolves which deadline day/time the request results in, before reminders
 * are considered. An omitted field carries the task's current value over; a
 * newly supplied deadline type replaces the other type, matching the
 * mutual-exclusivity behavior of the deadline meta-reducer.
 */
const resolveDeadlineValue = (
  fields: Partial<WritableTaskFields>,
  existingTask?: Task,
): { deadlineDay?: string; deadlineWithTime?: number } => {
  const hasDay = hasOwn(fields, 'deadlineDay');
  const hasTime = hasOwn(fields, 'deadlineWithTime');
  const requestedDay = fields.deadlineDay ?? undefined;
  const requestedTime = fields.deadlineWithTime ?? undefined;
  let deadlineDay = hasDay ? requestedDay : (existingTask?.deadlineDay ?? undefined);
  let deadlineWithTime = hasTime
    ? requestedTime
    : (existingTask?.deadlineWithTime ?? undefined);
  if (requestedDay !== undefined) deadlineWithTime = undefined;
  if (requestedTime !== undefined) deadlineDay = undefined;
  return { deadlineDay, deadlineWithTime };
};

/**
 * Resolves what happens to the reminder once the resulting deadline is known.
 * A supplied value wins; a changed deadline without one clears the old
 * reminder, just like the UI's setDeadline action; an otherwise unchanged
 * deadline keeps its reminder. An explicit null that would otherwise keep an
 * existing reminder becomes 'clear' so only the reminder is touched, without
 * re-planning the deadline.
 *
 * Takes the *normalized* existing reminder (see `resolveDeadlineChange`): a
 * stored `null` means "no reminder", so it must neither be carried over into
 * `setDeadline` nor turn a `{"deadlineRemindAt": null}` no-op into a
 * `clearDeadlineReminder` op.
 */
const resolveReminderChange = (
  fields: Partial<WritableTaskFields>,
  existingDeadlineRemindAt: number | undefined,
  isDeadlineValueChanged: boolean,
): { type: 'clear' } | { type: 'value'; remindAt: number | undefined } => {
  if (!hasOwn(fields, 'deadlineRemindAt')) {
    return {
      type: 'value',
      remindAt: isDeadlineValueChanged ? undefined : existingDeadlineRemindAt,
    };
  }
  const requested = fields.deadlineRemindAt ?? undefined;
  if (
    requested === undefined &&
    !isDeadlineValueChanged &&
    existingDeadlineRemindAt !== undefined
  ) {
    return { type: 'clear' };
  }
  return { type: 'value', remindAt: requested };
};

const resolveDeadlineChange = (
  fields: Partial<WritableTaskFields>,
  existingTask?: Task,
): { ok: true; change?: DeadlineChange } | { ok: false; message: string } => {
  const hasDay = hasOwn(fields, 'deadlineDay');
  const hasTime = hasOwn(fields, 'deadlineWithTime');
  const hasReminder = hasOwn(fields, 'deadlineRemindAt');
  if (!hasDay && !hasTime && !hasReminder) {
    return { ok: true };
  }

  const { deadlineDay, deadlineWithTime } = resolveDeadlineValue(fields, existingTask);

  if (deadlineDay === undefined && deadlineWithTime === undefined) {
    if (fields.deadlineRemindAt != null) {
      return { ok: false, message: 'deadlineRemindAt requires a deadline' };
    }
    const hasExistingDeadline = Boolean(
      existingTask?.deadlineDay ||
      existingTask?.deadlineWithTime ||
      existingTask?.deadlineRemindAt,
    );
    return {
      ok: true,
      change: hasExistingDeadline && (hasDay || hasTime) ? { type: 'remove' } : undefined,
    };
  }

  const existingDeadlineDay = existingTask?.deadlineDay ?? undefined;
  const existingDeadlineWithTime = existingTask?.deadlineWithTime ?? undefined;
  const existingDeadlineRemindAt = existingTask?.deadlineRemindAt ?? undefined;
  const isDeadlineValueChanged =
    deadlineDay !== existingDeadlineDay || deadlineWithTime !== existingDeadlineWithTime;

  const reminder = resolveReminderChange(
    fields,
    existingDeadlineRemindAt,
    isDeadlineValueChanged,
  );
  if (reminder.type === 'clear') {
    return { ok: true, change: { type: 'clearReminder' } };
  }
  const deadlineRemindAt = reminder.remindAt;

  if (
    existingTask &&
    deadlineDay === existingDeadlineDay &&
    deadlineWithTime === existingDeadlineWithTime &&
    deadlineRemindAt === existingDeadlineRemindAt
  ) {
    return { ok: true };
  }

  return {
    ok: true,
    change: {
      type: 'set',
      fields: {
        ...(deadlineDay !== undefined ? { deadlineDay } : {}),
        ...(deadlineWithTime !== undefined ? { deadlineWithTime } : {}),
        ...(deadlineRemindAt !== undefined ? { deadlineRemindAt } : {}),
      },
    },
  };
};

const firstRejectedField = (body: Record<string, unknown>): string | undefined =>
  REJECTED_TASK_FIELDS.find((field) => field in body);

type TaskSource = 'active' | 'archived' | 'all';

const isValidTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && new Date(value).getTime() > 0;

const isTaskInToday = (
  task: Task,
  todayStr: string,
  startOfNextDayDiffMs: number,
): boolean => {
  if (isValidTimestamp(task.dueWithTime)) {
    return isTodayWithOffset(task.dueWithTime, todayStr, startOfNextDayDiffMs);
  }
  return task.dueDay === todayStr;
};

/** Method type for exact-match routes. */
type SimpleRouteHandler = (
  requestId: string,
  body: unknown,
  query: Record<string, string | string[]>,
) => Promise<LocalRestApiResponsePayload>;

@Injectable({
  providedIn: 'root',
})
export class LocalRestApiHandlerService {
  private readonly _taskService = inject(TaskService);
  private readonly _navigateToTaskService = inject(NavigateToTaskService);
  private readonly _taskArchiveService = inject(TaskArchiveService);
  private readonly _projectService = inject(ProjectService);
  private readonly _tagService = inject(TagService);
  private readonly _dateService = inject(DateService);
  private readonly _store = inject(Store);
  private readonly _gitlabRestApi = inject(GitlabLocalRestApiService);

  // Exact-match route table. New endpoints add an entry here instead of
  // another `if` branch on the router — keeps _routeRequest's cognitive
  // complexity flat as we add routes.
  private readonly _simpleRoutes: ReadonlyArray<{
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    handle: SimpleRouteHandler;
  }> = [
    { method: 'GET', path: '/status', handle: (rid) => this._handleGetStatus(rid) },
    { method: 'GET', path: '/focus', handle: (rid) => this._handleGetFocus(rid) },
    {
      method: 'GET',
      path: '/task-control/current',
      handle: (rid) => this._handleGetCurrentTask(rid),
    },
    {
      method: 'POST',
      path: '/task-control/stop',
      handle: (rid) => this._handleStopTask(rid),
    },
    {
      method: 'POST',
      path: '/task-control/current',
      handle: (rid, body) => this._handleSetCurrentTask(rid, body),
    },
    {
      // Quick-add overlay: jump to an existing task in the main window
      // (used when the overlay's "similar existing tasks" hint is clicked).
      method: 'POST',
      path: '/task-control/focus',
      handle: (rid, body) => this._handleFocusTask(rid, body),
    },
    {
      method: 'GET',
      path: '/tasks',
      handle: (rid, _body, q) => this._handleListTasks(rid, q),
    },
    {
      method: 'POST',
      path: '/tasks',
      handle: (rid, body) => this._handleCreateTask(rid, body),
    },
    {
      method: 'GET',
      path: '/projects',
      handle: (rid, _body, q) => this._handleListProjects(rid, q),
    },
    {
      method: 'GET',
      path: '/tags',
      handle: (rid, _body, q) => this._handleListTags(rid, q),
    },
    // Quick-add overlay's autocomplete plumbing (#19). GitLab-specific for
    // now — only provider we support with structured lookups. The overlay
    // debounces these calls; each request goes end-to-end to GitLab
    // through the corresponding provider's token.
    {
      method: 'GET',
      path: '/gitlab/provider-for-project',
      handle: (rid, _body, q) => this._gitlabRestApi.providerForProject(rid, q),
    },
    {
      method: 'GET',
      path: '/gitlab/users',
      handle: (rid, _body, q) => this._gitlabRestApi.users(rid, q),
    },
    {
      method: 'GET',
      path: '/gitlab/milestones',
      handle: (rid, _body, q) => this._gitlabRestApi.milestones(rid, q),
    },
    {
      method: 'GET',
      path: '/gitlab/labels',
      handle: (rid, _body, q) => this._gitlabRestApi.labels(rid, q),
    },
    {
      method: 'GET',
      path: '/gitlab/statuses',
      handle: (rid, _body, q) => this._gitlabRestApi.statuses(rid, q),
    },
  ];
  private _isInitialized = false;

  private _dispatchDeadlineChange(taskId: string, change: DeadlineChange): void {
    if (change.type === 'clearReminder') {
      this._store.dispatch(TaskSharedActions.clearDeadlineReminder({ taskId }));
      return;
    }

    if (change.type === 'remove') {
      this._store.dispatch(
        TaskSharedActions.removeDeadline({ taskId, isSkipSnack: true }),
      );
      return;
    }

    this._store.dispatch(
      TaskSharedActions.setDeadline({
        taskId,
        ...change.fields,
        ...getDeadlineAutoPlanFields(
          this._dateService,
          change.fields.deadlineDay,
          change.fields.deadlineWithTime,
        ),
        isSkipSnack: true,
      }),
    );
  }

  init(): void {
    if (this._isInitialized || !window.ea?.onLocalRestApiRequest) {
      return;
    }
    this._isInitialized = true;

    window.ea.onLocalRestApiRequest((payload) => {
      void this._handleRequest(payload);
    });
  }

  private async _handleRequest(payload: LocalRestApiRequestPayload): Promise<void> {
    let response: LocalRestApiResponsePayload;

    try {
      response = await this._routeRequest(payload);
    } catch (error) {
      response = createErrorResponse(
        payload.requestId,
        500,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'Unknown internal error',
      );
    }

    window.ea.sendLocalRestApiResponse(response);
  }

  private async _routeRequest(
    payload: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload> {
    const { method, path, requestId, body, query } = payload;
    const segments = path.split('/').filter(Boolean);

    // Simple routes — exact (method, path) → handler. Kept as a table
    // instead of a big if-else chain so adding new endpoints doesn't
    // keep pushing the router's cognitive complexity up. Prefix / regex
    // routes (`/tasks/:id/...`) still need bespoke branches below.
    const simpleRoute = this._simpleRoutes.find(
      (r) => r.method === method && r.path === path,
    );
    if (simpleRoute) {
      return simpleRoute.handle(requestId, body, query);
    }

    if (segments[0] === 'tasks' && segments[1] && segments.length >= 2) {
      return this._handleTaskRoutes(method, segments, requestId, body);
    }

    return createErrorResponse(requestId, 404, 'NOT_FOUND', 'Route not found');
  }

  private async _handleGetStatus(
    requestId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const [currentTask, allTasks] = await Promise.all([
      firstValueFrom(this._taskService.currentTask$),
      firstValueFrom(this._taskService.allTasks$),
    ]);

    return createSuccessResponse(requestId, 200, {
      currentTask,
      currentTaskId: currentTask?.id ?? null,
      taskCount: allTasks.length,
    });
  }

  private async _handleGetFocus(requestId: string): Promise<LocalRestApiResponsePayload> {
    const state = await firstValueFrom(this._store);
    const timer = selectTimer(state);
    const mode = selectMode(state);
    const cycle = selectCurrentCycle(state);
    const isRunning = selectIsRunning(state);
    const isBreakTimeUp = selectIsBreakTimeUp(state);
    const isLongBreak = selectIsLongBreak(state);
    const remainingMs = selectTimeRemaining(state);
    const isSessionDone = selectIsSessionCompleted(state);
    const isOvertime = selectIsInOvertime(state);

    return createSuccessResponse(requestId, 200, {
      mode,
      cycle,
      isSessionDone,
      timer:
        timer.purpose === null
          ? null
          : {
              purpose: timer.purpose,
              status: isRunning ? 'running' : isBreakTimeUp ? 'done' : 'paused',
              isOvertime,
              isLongBreak,
              elapsedMs: timer.elapsed,
              remainingMs,
              durationMs: timer.duration,
            },
    });
  }

  private async _handleGetCurrentTask(
    requestId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const currentTask = await firstValueFrom(this._taskService.currentTask$);
    return createSuccessResponse(requestId, 200, currentTask);
  }

  private async _handleStopTask(requestId: string): Promise<LocalRestApiResponsePayload> {
    this._taskService.setCurrentId(null);
    return createSuccessResponse(requestId, 200, { currentTaskId: null });
  }

  private async _handleSetCurrentTask(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    if (!isRecord(body)) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'Request body must be a JSON object with taskId',
      );
    }

    const taskId = body.taskId;

    if (taskId === null) {
      this._taskService.setCurrentId(null);
      return createSuccessResponse(requestId, 200, { currentTaskId: null });
    }

    if (typeof taskId !== 'string') {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'taskId must be a string or null',
      );
    }

    const task = await this._getTaskById(taskId);
    if (!task) {
      return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
    }

    this._taskService.setCurrentId(taskId);
    return createSuccessResponse(requestId, 200, { currentTaskId: taskId });
  }

  private async _handleFocusTask(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    if (!isRecord(body) || typeof body.taskId !== 'string') {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'Request body must be a JSON object with a string taskId',
      );
    }

    const task = await this._getTaskById(body.taskId);
    if (!task) {
      return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
    }

    // Navigate the app to the task (switches work context + opens it), then
    // bring the main OS window to the foreground — the overlay is a separate
    // always-on-top window, so in-app navigation alone wouldn't be visible.
    await this._navigateToTaskService.navigate(body.taskId);
    window.ea.showOrFocus();

    return createSuccessResponse(requestId, 200, { focusedTaskId: body.taskId });
  }

  private async _handleListTasks(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');
    const projectId = getQueryParam(query, 'projectId');
    const tagId = getQueryParam(query, 'tagId');
    const includeDone = getQueryParamAsBoolean(query, 'includeDone', false);
    const VALID_SOURCES: TaskSource[] = ['active', 'archived', 'all'];
    const rawSource = getQueryParam(query, 'source') || 'active';
    const source: TaskSource = VALID_SOURCES.includes(rawSource as TaskSource)
      ? (rawSource as TaskSource)
      : 'active';

    let tasks: Task[];

    if (source === 'archived') {
      const archive = await this._taskArchiveService.load();
      tasks = archive.ids.map((id) => archive.entities[id]).filter((t): t is Task => !!t);
    } else if (source === 'all') {
      tasks = await this._taskService.getAllTasksEverywhere();
    } else {
      tasks = await firstValueFrom(this._taskService.allTasks$);
    }

    let filtered = tasks;

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      filtered = filtered.filter((t) => t.title.toLowerCase().includes(lowerQuery));
    }

    if (projectId) {
      filtered = filtered.filter((t) => t.projectId === projectId);
    }

    if (tagId === TODAY_TAG.id) {
      const todayStr = this._dateService.todayStr();
      const startOfNextDayDiffMs = this._dateService.getStartOfNextDayDiffMs();
      filtered = filtered.filter((t) => isTaskInToday(t, todayStr, startOfNextDayDiffMs));
    } else if (tagId) {
      filtered = filtered.filter((t) => t.tagIds.includes(tagId));
    }

    if (!includeDone) {
      filtered = filtered.filter((t) => !t.isDone);
    }

    return createSuccessResponse(requestId, 200, filtered);
  }

  private async _handleCreateTask(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    if (!isRecord(body) || typeof body.title !== 'string' || !body.title.trim()) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'Task title must be a non-empty string',
      );
    }

    if ('subTaskIds' in body) {
      return createErrorResponse(
        requestId,
        400,
        'UNSUPPORTED_FIELD',
        'subTaskIds cannot be set on task creation — create the parent first, then create each child with POST /tasks using parentId',
      );
    }

    const title = body.title.trim();
    const additionalFields = pickAllowedFields(body);

    const validation = validateWritableFields(additionalFields);
    if (!validation.ok) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'One or more task fields have an invalid type',
        validation.errors,
      );
    }

    const deadlineValidationError = validateDeadlineFields(additionalFields);
    if (deadlineValidationError) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        deadlineValidationError,
      );
    }

    const deadlineFields = Object.fromEntries(
      DEADLINE_FIELDS.filter((field) => hasOwn(additionalFields, field)).map((field) => [
        field,
        additionalFields[field],
      ]),
    ) as Partial<WritableTaskFields>;
    const deadlineResolution = resolveDeadlineChange(deadlineFields);
    if (!deadlineResolution.ok) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        deadlineResolution.message,
      );
    }
    for (const field of DEADLINE_FIELDS) {
      delete additionalFields[field];
    }

    if ('parentId' in body) {
      if (typeof body.parentId !== 'string' || !body.parentId) {
        return createErrorResponse(
          requestId,
          400,
          'INVALID_INPUT',
          'parentId must be a non-empty string',
        );
      }

      const inherited = SUBTASK_INHERITED_FIELDS.find((field) => field in body);
      if (inherited) {
        return createErrorResponse(
          requestId,
          400,
          'UNSUPPORTED_FIELD',
          `${inherited} cannot be set when creating a subtask — it's inherited from the parent`,
        );
      }

      const parent = await this._getTaskById(body.parentId);
      if (!parent) {
        return createErrorResponse(
          requestId,
          404,
          'PARENT_NOT_FOUND',
          `Parent task ${body.parentId} not found`,
        );
      }

      if (parent.parentId) {
        return createErrorResponse(
          requestId,
          400,
          'INVALID_PARENT',
          'Cannot nest subtasks: parent task is itself a subtask',
        );
      }

      const subTaskId = this._taskService.addSubTaskTo(body.parentId, {
        title,
        ...additionalFields,
      });
      if (deadlineResolution.change?.type === 'set') {
        this._dispatchDeadlineChange(subTaskId, deadlineResolution.change);
      }
      const createdSubTask = await this._getTaskById(subTaskId);
      return createSuccessResponse(requestId, 201, createdSubTask);
    }

    // The overlay (the only POST /tasks creator) has its OWN token grammar
    // (!project @user #label ##milestone ~date !!priority >status), parsed by
    // the auto-create effect / handled here. SP's short-syntax
    // (#tag/@date/+project/!deadline) overlaps and corrupts it — e.g.
    // `##milestone` spawns a stray "milestone" tag, and it double-creates
    // tags on GitLab overlay tasks. So REST creates ignore short-syntax and
    // the overlay grammar is the single source of truth. See #19.
    const parsed = parseQuickAddText(title);
    const projectId =
      typeof additionalFields.projectId === 'string'
        ? additionalFields.projectId
        : undefined;
    let finalTitle = title;
    let fields: Partial<Task> = additionalFields;
    // `#label` → SP tags, but ONLY when no GitLab auto-create provider owns
    // the project. When one does, the GitLab path turns `#label` into a
    // GitLab label (which syncs back to a tag), so we must leave the raw
    // title for its effect to re-parse. Build a NEW fields object — Task's
    // tagIds is readonly.
    if (parsed.labels.length && !(await this._isGitlabAutoCreateProject(projectId))) {
      const tagIds = this._resolveLabelsToTagIds(
        parsed.labels,
        Array.isArray(additionalFields.tagIds) ? [...additionalFields.tagIds] : [],
      );
      fields = { ...additionalFields, tagIds };
      finalTitle = stripQuickAddLabelTokens(title, parsed.labels) || title;
    }
    const taskId = this._taskService.add(finalTitle, false, fields, false, true);
    if (deadlineResolution.change?.type === 'set') {
      this._dispatchDeadlineChange(taskId, deadlineResolution.change);
    }
    const createdTask = await this._getTaskById(taskId);

    return createSuccessResponse(requestId, 201, createdTask);
  }

  /**
   * True if an enabled GitLab provider with auto-create targets `projectId`
   * (direct `defaultProjectId` or a `treeImportMapping` entry). When true,
   * the auto-create effect owns `#label` → GitLab label, so the REST handler
   * must not also resolve labels to SP tags (would double up + strip the
   * token the effect needs). Mirrors the effect's gate for GitLab.
   */
  private async _isGitlabAutoCreateProject(
    projectId: string | undefined,
  ): Promise<boolean> {
    if (!projectId) return false;
    const providers = await firstValueFrom(
      this._store.select(selectEnabledIssueProviders),
    );
    return providers.some((p) => {
      if (p.issueProviderKey !== 'GITLAB') return false;
      const g = p as unknown as {
        token?: string | null;
        isAutoCreateIssues?: boolean;
        defaultProjectId?: string | null;
        treeImportMapping?: Record<string, { spProjectId: string }>;
      };
      if (!g.token || !g.isAutoCreateIssues) return false;
      if (g.defaultProjectId === projectId) return true;
      return g.treeImportMapping
        ? Object.values(g.treeImportMapping).some((e) => e.spProjectId === projectId)
        : false;
    });
  }

  /**
   * Resolves `#label` tokens to SP tag ids for the overlay's non-GitLab
   * fallback: reuses an existing tag (case-insensitive, never the virtual
   * TODAY_TAG) or creates one, merged into any pre-existing tagIds (deduped,
   * order preserved).
   */
  private _resolveLabelsToTagIds(labels: string[], existingTagIds: string[]): string[] {
    const existing = this._tagService.tags();
    const ids = [...existingTagIds];
    for (const label of labels) {
      const trimmed = label.trim();
      if (!trimmed) continue;
      const match = existing.find(
        (t) => t.title.toLowerCase() === trimmed.toLowerCase() && t.id !== TODAY_TAG.id,
      );
      const id = match ? match.id : this._tagService.addTag({ title: trimmed });
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  private async _handleTaskRoutes(
    method: string,
    segments: string[],
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const taskId = segments[1];

    if (segments.length === 2) {
      if (method === 'GET') {
        const task = await this._getTaskById(taskId);
        if (!task) {
          return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
        }
        return createSuccessResponse(requestId, 200, task);
      }

      if (method === 'PATCH') {
        if (!isRecord(body)) {
          return createErrorResponse(
            requestId,
            400,
            'INVALID_INPUT',
            'PATCH body must be a JSON object',
          );
        }

        const rejected = firstRejectedField(body);
        if (rejected) {
          return createErrorResponse(
            requestId,
            400,
            'UNSUPPORTED_FIELD',
            `${rejected} cannot be set via PATCH — re-parenting is not supported by this API`,
          );
        }

        const changes = pickAllowedFields(body);
        const validation = validateWritableFields(changes);
        if (!validation.ok) {
          return createErrorResponse(
            requestId,
            400,
            'INVALID_INPUT',
            'One or more task fields have an invalid type',
            validation.errors,
          );
        }

        const deadlineValidationError = validateDeadlineFields(changes);
        if (deadlineValidationError) {
          return createErrorResponse(
            requestId,
            400,
            'INVALID_INPUT',
            deadlineValidationError,
          );
        }

        const task = await this._getTaskById(taskId);
        if (!task) {
          return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
        }

        const deadlineFields = Object.fromEntries(
          DEADLINE_FIELDS.filter((field) => hasOwn(changes, field)).map((field) => [
            field,
            changes[field],
          ]),
        ) as Partial<WritableTaskFields>;
        const deadlineResolution = resolveDeadlineChange(deadlineFields, task);
        if (!deadlineResolution.ok) {
          return createErrorResponse(
            requestId,
            400,
            'INVALID_INPUT',
            deadlineResolution.message,
          );
        }
        for (const field of DEADLINE_FIELDS) {
          delete changes[field];
        }

        if (hasOwn(changes, 'projectId')) {
          const targetProjectId = changes.projectId;
          if (typeof targetProjectId !== 'string' || !targetProjectId.trim()) {
            return createErrorResponse(
              requestId,
              400,
              'INVALID_INPUT',
              'projectId must be a non-empty string',
            );
          }
          const isProjectChange = targetProjectId !== task.projectId;
          // Echoing back the unchanged projectId is allowed on subtasks so
          // GET→PATCH round-trips don't fail; only actual changes are rejected.
          if (task.parentId && isProjectChange) {
            return createErrorResponse(
              requestId,
              400,
              'UNSUPPORTED_FIELD',
              'projectId cannot be changed directly on a subtask — move its parent task instead',
            );
          }

          if (isProjectChange) {
            // list() only contains unarchived projects, and matching by iteration
            // (not entity-map lookup) keeps prototype-property names like
            // 'constructor' from resolving to a truthy non-project.
            const targetProject = this._projectService
              .list()
              .find((project) => project.id === targetProjectId && !project.isArchived);
            if (!targetProject) {
              return createErrorResponse(
                requestId,
                404,
                'PROJECT_NOT_FOUND',
                'Destination project not found or archived',
              );
            }
          }
        }

        if (Object.keys(changes).length > 0) {
          this._taskService.update(taskId, changes);
        }
        if (deadlineResolution.change) {
          this._dispatchDeadlineChange(taskId, deadlineResolution.change);
        }
        return createSuccessResponse(requestId, 200, await this._getTaskById(taskId));
      }

      if (method === 'DELETE') {
        const task = await this._getTaskWithSubTasksById(taskId);
        if (!task) {
          return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
        }

        this._taskService.remove(task);
        return createSuccessResponse(requestId, 200, { deleted: true, id: taskId });
      }
    }

    if (segments.length === 3 && segments[2] === 'start' && method === 'POST') {
      const task = await this._getTaskById(taskId);
      if (!task) {
        return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
      }

      this._taskService.setCurrentId(taskId);
      return createSuccessResponse(requestId, 200, { currentTaskId: taskId });
    }

    if (segments.length === 3 && segments[2] === 'archive' && method === 'POST') {
      return this._handleArchiveTask(requestId, taskId);
    }

    if (segments.length === 3 && segments[2] === 'restore' && method === 'POST') {
      return this._handleRestoreTask(requestId, taskId);
    }

    return createErrorResponse(requestId, 404, 'NOT_FOUND', 'Route not found');
  }

  private async _handleArchiveTask(
    requestId: string,
    taskId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const task = await this._getTaskWithSubTasksById(taskId);
    if (!task) {
      return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
    }

    await this._taskService.moveToArchive(task);
    return createSuccessResponse(requestId, 200, { id: taskId, archived: true });
  }

  private async _handleRestoreTask(
    requestId: string,
    taskId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const existsInArchive = await this._taskArchiveService.hasTask(taskId);
    if (!existsInArchive) {
      return createErrorResponse(
        requestId,
        404,
        'TASK_NOT_FOUND',
        'Task not found in archive',
      );
    }

    const archivedTask = await this._taskArchiveService.getById(taskId);
    const subTasks: Task[] = [];

    if (archivedTask.subTaskIds?.length) {
      const archive = await this._taskArchiveService.load();
      for (const subTaskId of archivedTask.subTaskIds) {
        if (archive.entities[subTaskId]) {
          subTasks.push(archive.entities[subTaskId]);
        }
      }
    }

    this._taskService.restoreTask(archivedTask, subTasks);
    const restoredTask = await this._getTaskById(taskId);
    return createSuccessResponse(requestId, 200, restoredTask);
  }

  private async _handleListProjects(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');

    let projects = await firstValueFrom(this._projectService.list$);

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      projects = projects.filter((p) => p.title.toLowerCase().includes(lowerQuery));
    }

    return createSuccessResponse(requestId, 200, projects);
  }

  private async _handleListTags(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');

    let tags = await firstValueFrom(this._tagService.tags$);

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      tags = tags.filter((t) => t.title.toLowerCase().includes(lowerQuery));
    }

    return createSuccessResponse(requestId, 200, tags);
  }

  // The id equality checks reject prototype-property names ('constructor',
  // 'toString', …) that entity-map lookups resolve to truthy non-tasks.
  private async _getTaskById(taskId: string): Promise<Task | undefined> {
    const task = await firstValueFrom(this._taskService.getByIdOnce$(taskId));
    return task?.id === taskId ? task : undefined;
  }

  private async _getTaskWithSubTasksById(
    taskId: string,
  ): Promise<TaskWithSubTasks | undefined> {
    const task = await firstValueFrom(this._taskService.getByIdWithSubTaskData$(taskId));
    return task?.id === taskId ? task : undefined;
  }
}
