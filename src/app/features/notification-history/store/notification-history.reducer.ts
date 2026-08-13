import { createReducer, on } from '@ngrx/store';
import { loadAllData } from '../../../root-store/meta/load-all-data.action';
import {
  clearNotificationHistory,
  markAllNotificationsSeen,
  recordNotification,
} from './notification-history.actions';
import {
  initialNotificationHistoryState,
  NOTIFICATION_HISTORY_MAX,
  NotificationHistoryEntry,
  NotificationHistoryState,
} from '../notification-history.model';

export const NOTIFICATION_HISTORY_FEATURE_NAME = 'notificationHistory';

const entryKey = (e: NotificationHistoryEntry): string =>
  e.id || `${e.kind}|${e.timestamp}|${e.msg}`;

const dedupeAndCap = (
  entries: NotificationHistoryEntry[],
): NotificationHistoryEntry[] => {
  const seen = new Set<string>();
  const out: NotificationHistoryEntry[] = [];
  for (const e of entries) {
    const k = entryKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out.length > NOTIFICATION_HISTORY_MAX
    ? out.slice(0, NOTIFICATION_HISTORY_MAX)
    : out;
};

const unseenAfter = (
  entries: NotificationHistoryEntry[],
  lastSeenAt: number | undefined,
): number => {
  if (!lastSeenAt) return entries.length;
  let count = 0;
  for (const e of entries) {
    if (e.timestamp > lastSeenAt) count++;
  }
  return count;
};

export const notificationHistoryReducer = createReducer<NotificationHistoryState>(
  initialNotificationHistoryState,

  on(loadAllData, (state, { appDataComplete }) => {
    // Legacy imports and pre-feature installs won't have the slice — keep the
    // in-memory ring buffer as the fallback rather than resetting it.
    const remote = (appDataComplete as { notificationHistory?: NotificationHistoryState })
      .notificationHistory;
    if (!remote || !remote.entries) {
      return state;
    }
    // Remote first so a stable id on the remote side wins the dedupe key when
    // a local pre-hydration entry happens to collide (rare with uuidv7).
    const merged = dedupeAndCap([...remote.entries, ...state.entries]);
    const lastSeenAtMax = Math.max(state.lastSeenAt ?? 0, remote.lastSeenAt ?? 0);
    const lastSeenAt = lastSeenAtMax > 0 ? lastSeenAtMax : undefined;
    return {
      entries: merged,
      lastSeenAt,
      unseenCount: unseenAfter(merged, lastSeenAt),
    };
  }),

  on(recordNotification, (state, { entry }) => {
    const entries = dedupeAndCap([entry, ...state.entries]);
    return {
      ...state,
      entries,
      unseenCount: unseenAfter(entries, state.lastSeenAt),
    };
  }),

  on(markAllNotificationsSeen, (state, { lastSeenAt }) => {
    const nextLastSeenAt = Math.max(state.lastSeenAt ?? 0, lastSeenAt);
    return {
      ...state,
      lastSeenAt: nextLastSeenAt,
      unseenCount: unseenAfter(state.entries, nextLastSeenAt),
    };
  }),

  on(clearNotificationHistory, (state) => ({
    entries: [],
    unseenCount: 0,
    // Keep lastSeenAt to prevent old-but-still-synced entries from a peer
    // resurrecting the unseen badge immediately after a manual clear.
    lastSeenAt: state.lastSeenAt,
  })),
);
