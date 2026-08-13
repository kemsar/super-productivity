export const NOTIFICATION_HISTORY_MAX = 150;
export const NOTIFICATION_HISTORY_MSG_MAX = 500;

export type NotificationHistoryEntryKind = 'ERROR' | 'WARNING' | 'TASK_UPDATE';

export interface NotificationHistoryEntry {
  id: string;
  kind: NotificationHistoryEntryKind;
  msg: string;
  isSkipTranslate?: boolean;
  translateParams?: { [key: string]: string | number };
  timestamp: number;
  taskId?: string;
  actionId?: string;
  actionPayload?: unknown;
  ico?: string;
  svgIco?: string;
}

export interface NotificationHistoryState {
  entries: NotificationHistoryEntry[];
  unseenCount: number;
  lastSeenAt?: number;
}

export const initialNotificationHistoryState: NotificationHistoryState = {
  entries: [],
  unseenCount: 0,
};
