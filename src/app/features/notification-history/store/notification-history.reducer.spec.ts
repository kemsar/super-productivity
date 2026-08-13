import {
  notificationHistoryReducer,
  NOTIFICATION_HISTORY_FEATURE_NAME,
} from './notification-history.reducer';
import {
  clearNotificationHistory,
  markAllNotificationsSeen,
  recordNotification,
} from './notification-history.actions';
import { loadAllData } from '../../../root-store/meta/load-all-data.action';
import {
  initialNotificationHistoryState,
  NOTIFICATION_HISTORY_MAX,
  NotificationHistoryEntry,
  NotificationHistoryState,
} from '../notification-history.model';
import { AppDataComplete } from '../../../op-log/model/model-config';

const entry = (
  id: string,
  timestamp: number,
  extras: Partial<NotificationHistoryEntry> = {},
): NotificationHistoryEntry => ({
  id,
  kind: 'ERROR',
  msg: `msg-${id}`,
  timestamp,
  ...extras,
});

const appData = (notificationHistory?: NotificationHistoryState): AppDataComplete =>
  ({ notificationHistory }) as unknown as AppDataComplete;

describe('notificationHistoryReducer', () => {
  it('registers its feature name', () => {
    expect(NOTIFICATION_HISTORY_FEATURE_NAME).toBe('notificationHistory');
  });

  describe('recordNotification', () => {
    it('prepends new entries and increments unseenCount', () => {
      const s1 = notificationHistoryReducer(
        initialNotificationHistoryState,
        recordNotification({ entry: entry('a', 100) }),
      );
      const s2 = notificationHistoryReducer(
        s1,
        recordNotification({ entry: entry('b', 200) }),
      );
      expect(s2.entries.map((e) => e.id)).toEqual(['b', 'a']);
      expect(s2.unseenCount).toBe(2);
    });

    it('caps the ring buffer at NOTIFICATION_HISTORY_MAX', () => {
      let state = initialNotificationHistoryState;
      const overflow = NOTIFICATION_HISTORY_MAX + 25;
      for (let i = 0; i < overflow; i++) {
        // Ascending timestamps so the newest entries land at the head.
        state = notificationHistoryReducer(
          state,
          recordNotification({ entry: entry(`e${i}`, i) }),
        );
      }
      expect(state.entries.length).toBe(NOTIFICATION_HISTORY_MAX);
      // Newest first
      expect(state.entries[0].id).toBe(`e${overflow - 1}`);
      // Oldest kept is at boundary
      expect(state.entries[state.entries.length - 1].id).toBe(
        `e${overflow - NOTIFICATION_HISTORY_MAX}`,
      );
    });

    it('does not bump unseenCount for entries older than lastSeenAt', () => {
      const state: NotificationHistoryState = {
        ...initialNotificationHistoryState,
        lastSeenAt: 500,
      };
      const result = notificationHistoryReducer(
        state,
        recordNotification({ entry: entry('old', 200) }),
      );
      expect(result.unseenCount).toBe(0);
      expect(result.entries.length).toBe(1);
    });
  });

  describe('markAllNotificationsSeen', () => {
    it('advances lastSeenAt to the max and clears unseenCount for older entries', () => {
      const state: NotificationHistoryState = {
        entries: [entry('a', 400), entry('b', 300), entry('c', 100)],
        unseenCount: 3,
        lastSeenAt: 200,
      };
      const result = notificationHistoryReducer(
        state,
        markAllNotificationsSeen({ lastSeenAt: 500 }),
      );
      expect(result.lastSeenAt).toBe(500);
      expect(result.unseenCount).toBe(0);
    });

    it('never regresses lastSeenAt if an older value is passed in', () => {
      const state: NotificationHistoryState = {
        entries: [],
        unseenCount: 0,
        lastSeenAt: 900,
      };
      const result = notificationHistoryReducer(
        state,
        markAllNotificationsSeen({ lastSeenAt: 100 }),
      );
      expect(result.lastSeenAt).toBe(900);
    });
  });

  describe('clearNotificationHistory', () => {
    it('drops entries but preserves lastSeenAt to keep the badge quiet after sync', () => {
      const state: NotificationHistoryState = {
        entries: [entry('a', 100)],
        unseenCount: 1,
        lastSeenAt: 90,
      };
      const result = notificationHistoryReducer(state, clearNotificationHistory());
      expect(result.entries).toEqual([]);
      expect(result.unseenCount).toBe(0);
      expect(result.lastSeenAt).toBe(90);
    });
  });

  describe('loadAllData merge', () => {
    it('returns the current state when the remote slice is absent (legacy install)', () => {
      const state: NotificationHistoryState = {
        entries: [entry('local', 100)],
        unseenCount: 1,
      };
      const result = notificationHistoryReducer(
        state,
        loadAllData({ appDataComplete: appData(undefined) }),
      );
      expect(result).toBe(state);
    });

    it('unions local + remote entries, sorts newest-first, dedupes by id, and caps', () => {
      const local: NotificationHistoryState = {
        entries: [entry('a', 100), entry('shared', 300)],
        unseenCount: 2,
      };
      const remote: NotificationHistoryState = {
        entries: [entry('shared', 300), entry('b', 200), entry('c', 400)],
        unseenCount: 3,
      };
      const result = notificationHistoryReducer(
        local,
        loadAllData({ appDataComplete: appData(remote) }),
      );
      expect(result.entries.map((e) => e.id)).toEqual(['c', 'shared', 'b', 'a']);
      expect(result.entries.length).toBe(4);
    });

    it('takes the MAX of local and remote lastSeenAt so seen state propagates', () => {
      const local: NotificationHistoryState = {
        entries: [entry('a', 100)],
        unseenCount: 1,
        lastSeenAt: 50,
      };
      const remote: NotificationHistoryState = {
        entries: [entry('a', 100)],
        unseenCount: 0,
        lastSeenAt: 500,
      };
      const result = notificationHistoryReducer(
        local,
        loadAllData({ appDataComplete: appData(remote) }),
      );
      expect(result.lastSeenAt).toBe(500);
      // entry 'a' has timestamp 100 which is < lastSeenAt=500 → considered seen
      expect(result.unseenCount).toBe(0);
    });

    it('counts only entries strictly after lastSeenAt as unseen', () => {
      const local: NotificationHistoryState = {
        entries: [],
        unseenCount: 0,
      };
      const remote: NotificationHistoryState = {
        entries: [entry('old', 100), entry('new', 700)],
        unseenCount: 2,
        lastSeenAt: 500,
      };
      const result = notificationHistoryReducer(
        local,
        loadAllData({ appDataComplete: appData(remote) }),
      );
      expect(result.unseenCount).toBe(1);
      expect(result.entries.map((e) => e.id)).toEqual(['new', 'old']);
    });

    it('honors the ring-buffer cap when merging large disjoint histories', () => {
      const local: NotificationHistoryState = {
        entries: Array.from({ length: NOTIFICATION_HISTORY_MAX }, (_, i) =>
          entry(`l${i}`, i * 2),
        ).reverse(),
        unseenCount: NOTIFICATION_HISTORY_MAX,
      };
      const remote: NotificationHistoryState = {
        entries: Array.from({ length: NOTIFICATION_HISTORY_MAX }, (_, i) =>
          entry(`r${i}`, i + i + 1),
        ).reverse(),
        unseenCount: NOTIFICATION_HISTORY_MAX,
      };
      const result = notificationHistoryReducer(
        local,
        loadAllData({ appDataComplete: appData(remote) }),
      );
      expect(result.entries.length).toBe(NOTIFICATION_HISTORY_MAX);
      // Merged entries are strictly monotonically decreasing by timestamp.
      for (let i = 1; i < result.entries.length; i++) {
        expect(result.entries[i - 1].timestamp).toBeGreaterThan(
          result.entries[i].timestamp,
        );
      }
    });
  });
});
