import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { uuidv7 } from '../../util/uuid-v7';
import { Log } from '../../core/log';
import {
  NOTIFICATION_HISTORY_MSG_MAX,
  NotificationHistoryEntry,
  NotificationHistoryEntryKind,
} from './notification-history.model';
import {
  clearNotificationHistory,
  markAllNotificationsSeen,
  recordNotification,
} from './store/notification-history.actions';

interface RecordInput {
  kind: NotificationHistoryEntryKind;
  msg: string;
  isSkipTranslate?: boolean;
  translateParams?: { [key: string]: string | number };
  taskId?: string;
  actionId?: string;
  actionPayload?: unknown;
  ico?: string;
  svgIco?: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationHistoryService {
  private _store = inject(Store);

  record(input: RecordInput): void {
    try {
      const entry: NotificationHistoryEntry = {
        id: uuidv7(),
        kind: input.kind,
        msg: this._truncate(input.msg),
        isSkipTranslate: input.isSkipTranslate,
        translateParams: input.translateParams,
        timestamp: Date.now(),
        taskId: input.taskId,
        actionId: input.actionId,
        actionPayload: input.actionPayload,
        ico: input.ico,
        svgIco: input.svgIco,
      };
      this._store.dispatch(recordNotification({ entry }));
    } catch (err) {
      // Never let a history-recorder bug break the snack render path.
      Log.err('NotificationHistoryService.record failed', err);
    }
  }

  markAllSeen(): void {
    this._store.dispatch(markAllNotificationsSeen({ lastSeenAt: Date.now() }));
  }

  clear(): void {
    this._store.dispatch(clearNotificationHistory());
  }

  private _truncate(msg: string): string {
    if (typeof msg !== 'string') return String(msg ?? '');
    return msg.length > NOTIFICATION_HISTORY_MSG_MAX
      ? msg.slice(0, NOTIFICATION_HISTORY_MSG_MAX)
      : msg;
  }
}
