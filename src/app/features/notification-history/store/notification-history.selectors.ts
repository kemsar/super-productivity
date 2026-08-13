import { createFeatureSelector, createSelector } from '@ngrx/store';
import { NotificationHistoryState } from '../notification-history.model';
import { NOTIFICATION_HISTORY_FEATURE_NAME } from './notification-history.reducer';

export const selectNotificationHistoryState =
  createFeatureSelector<NotificationHistoryState>(NOTIFICATION_HISTORY_FEATURE_NAME);

export const selectNotificationHistoryEntries = createSelector(
  selectNotificationHistoryState,
  (state) => state.entries,
);

export const selectNotificationHistoryUnseenCount = createSelector(
  selectNotificationHistoryState,
  (state) => state.unseenCount,
);

export const selectNotificationHistoryLastSeenAt = createSelector(
  selectNotificationHistoryState,
  (state) => state.lastSeenAt,
);
