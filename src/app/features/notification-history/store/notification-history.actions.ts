import { createAction, props } from '@ngrx/store';
import { NotificationHistoryEntry } from '../notification-history.model';

// Intentionally plain actions (no PersistentActionMeta): the notification
// history is a synced *whole-state* pfapi model, so per-entry actions must
// stay out of op-log capture. See docs/sync-and-op-log/contributor-sync-model.md
// and CLAUDE.md sync rules #1 / #10.
export const recordNotification = createAction(
  '[NotificationHistory] Record',
  props<{ entry: NotificationHistoryEntry }>(),
);

export const markAllNotificationsSeen = createAction(
  '[NotificationHistory] Mark all seen',
  props<{ lastSeenAt: number }>(),
);

export const clearNotificationHistory = createAction('[NotificationHistory] Clear all');
