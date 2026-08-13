import { MatSnackBarConfig } from '@angular/material/snack-bar';
import { Observable } from 'rxjs';

export type SnackType = 'ERROR' | 'SUCCESS' | 'WARNING' | 'CUSTOM' | 'JIRA_UNBLOCK';

export interface SnackParams {
  msg: string;
  isSkipTranslate?: boolean;
  translateParams?: { [key: string]: string | number };
  type?: SnackType;
  ico?: string;
  svgIco?: string;
  actionStr?: string;
  actionId?: string;
  // eslint-disable-next-line
  actionFn?: Function;
  dismissFn?: () => void | Promise<void>;
  actionPayload?: unknown;
  config?: MatSnackBarConfig;
  isSpinner?: boolean;
  promise?: Promise<unknown>;
  showWhile$?: Observable<unknown>;
  // Optional link to a task — recorded into NotificationHistoryService so the
  // history entry can navigate to the task when clicked. See snack.service.ts
  // (_recordIfEligible) and features/notification-history/*.
  taskId?: string;
  // Opt out of notification-history recording for retry-storm sticky snacks
  // (e.g. SYNC.S.PERSIST_FAILED) that would otherwise flood the history.
  isSkipHistory?: boolean;
}
