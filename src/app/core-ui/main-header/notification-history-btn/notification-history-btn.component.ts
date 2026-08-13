import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { Store } from '@ngrx/store';
import { MatIconButton, MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { MatBadge } from '@angular/material/badge';
import { MatMenu, MatMenuContent, MatMenuTrigger } from '@angular/material/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { T } from '../../../t.const';
import {
  selectNotificationHistoryEntries,
  selectNotificationHistoryLastSeenAt,
  selectNotificationHistoryUnseenCount,
} from '../../../features/notification-history/store/notification-history.selectors';
import { NotificationHistoryService } from '../../../features/notification-history/notification-history.service';
import { NotificationHistoryEntry } from '../../../features/notification-history/notification-history.model';
import { NavigateToTaskService } from '../../navigate-to-task/navigate-to-task.service';

// Distinct Material Icons per entry kind — a quick visual cue in the dropdown.
const KIND_ICON: Record<NotificationHistoryEntry['kind'], string> = {
  ERROR: 'error_outline',
  WARNING: 'warning_amber',
  TASK_UPDATE: 'sync_alt',
};

@Component({
  selector: 'notification-history-btn',
  standalone: true,
  imports: [
    MatIconButton,
    MatButton,
    MatIcon,
    MatTooltip,
    MatBadge,
    MatMenu,
    MatMenuContent,
    MatMenuTrigger,
    TranslatePipe,
  ],
  templateUrl: './notification-history-btn.component.html',
  styleUrls: ['./notification-history-btn.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationHistoryBtnComponent {
  readonly T = T;
  private _store = inject(Store);
  private _translate = inject(TranslateService);
  private _history = inject(NotificationHistoryService);
  private _navigateToTask = inject(NavigateToTaskService);

  readonly menuTrigger = viewChild(MatMenuTrigger);

  readonly entries = this._store.selectSignal(selectNotificationHistoryEntries);
  readonly unseenCount = this._store.selectSignal(selectNotificationHistoryUnseenCount);
  readonly lastSeenAt = this._store.selectSignal(selectNotificationHistoryLastSeenAt);
  readonly hasEntries = computed(() => this.entries().length > 0);

  translateEntry(entry: NotificationHistoryEntry): string {
    if (entry.isSkipTranslate) {
      return entry.msg;
    }
    return this._translate.instant(entry.msg, entry.translateParams ?? {});
  }

  iconFor(entry: NotificationHistoryEntry): string {
    if (entry.ico) return entry.ico;
    return KIND_ICON[entry.kind] ?? 'notifications';
  }

  // Compact "just now / 3 m / 2 h / 1 d" so the dropdown stays scannable
  // without pulling in a heavier date-fns/humanize dependency.
  relativeTime(entry: NotificationHistoryEntry, now: number = Date.now()): string {
    const deltaMs = Math.max(0, now - entry.timestamp);
    const mins = Math.floor(deltaMs / 60_000);
    if (mins < 1) return '<1m';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w`;
    const months = Math.floor(days / 30);
    return `${months}mo`;
  }

  isUnseen(entry: NotificationHistoryEntry): boolean {
    const seenAt = this.lastSeenAt();
    return !seenAt || entry.timestamp > seenAt;
  }

  onMenuOpened(): void {
    if (this.unseenCount() > 0) {
      this._history.markAllSeen();
    }
  }

  onEntryClick(entry: NotificationHistoryEntry): void {
    if (entry.taskId) {
      // fire-and-forget: navigation handles its own errors + snacks
      void this._navigateToTask.navigate(entry.taskId);
      this.menuTrigger()?.closeMenu();
      return;
    }
    if (entry.actionId) {
      this._store.dispatch({
        type: entry.actionId,
        payload: entry.actionPayload,
      } as { type: string; payload?: unknown });
      this.menuTrigger()?.closeMenu();
    }
  }

  onClearAll(): void {
    this._history.clear();
  }

  onMarkAllSeen(): void {
    this._history.markAllSeen();
  }

  trackById(_: number, entry: NotificationHistoryEntry): string {
    return entry.id;
  }
}
