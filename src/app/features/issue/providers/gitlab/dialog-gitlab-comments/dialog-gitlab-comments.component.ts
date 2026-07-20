import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogActions,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatTooltip } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import { T } from '../../../../../t.const';
import { Task } from '../../../../tasks/task.model';
import { IssueProviderService } from '../../../issue-provider.service';
import { GitlabApiService } from '../gitlab-api/gitlab-api.service';
import { GitlabIssue } from '../gitlab-issue.model';
import { GitlabOriginalComment } from '../gitlab-api/gitlab-api-responses';
import { SnackService } from '../../../../../core/snack/snack.service';
import { IssueLog } from '../../../../../core/log';
import { DialogConfirmComponent } from '../../../../../ui/dialog-confirm/dialog-confirm.component';

/**
 * Read/write conversation panel for a GitLab issue linked to an SP task
 * (issue #19). Fetches the fresh issue on open — comments are already
 * hydrated by `getById$` via `getIssueWithComments$` — and offers a
 * plain-text composer that posts to `POST /issues/:iid/notes` via the
 * same `postIssueNote$` used by the bulk-comment path.
 *
 * System notes (label/state/MR-linkage events) are filtered out to keep
 * the panel focused on human discussion. Note this is only about display
 * — the raw list including system notes is still fetched and can be
 * repurposed elsewhere.
 */
@Component({
  selector: 'dialog-gitlab-comments',
  standalone: true,
  templateUrl: './dialog-gitlab-comments.component.html',
  styleUrls: ['./dialog-gitlab-comments.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDialogTitle,
    MatDialogContent,
    MatDialogActions,
    MatButton,
    MatIconButton,
    MatIcon,
    MatCheckbox,
    MatFormField,
    MatLabel,
    MatInput,
    MatTooltip,
    FormsModule,
    DatePipe,
  ],
})
export class DialogGitlabCommentsComponent implements OnInit {
  private readonly _matDialogRef =
    inject<MatDialogRef<DialogGitlabCommentsComponent>>(MatDialogRef);
  private readonly _matDialog = inject(MatDialog);
  private readonly _issueProviderService = inject(IssueProviderService);
  private readonly _gitlabApiService = inject(GitlabApiService);
  private readonly _snackService = inject(SnackService);
  private readonly _destroyRef = inject(DestroyRef);

  readonly data = inject<{ task: Task }>(MAT_DIALOG_DATA);
  readonly T = T;

  readonly issue = signal<GitlabIssue | null>(null);
  readonly isLoading = signal(true);
  readonly errorMsg = signal<string | null>(null);
  readonly draft = signal('');
  /** When true, the composed comment is posted as a GitLab "internal" note
   *  (visible to project members only). Off by default so a stray Enter
   *  never leaks a public comment as internal or vice-versa. */
  readonly isInternal = signal(false);
  readonly isPosting = signal(false);
  /** ID of the note the user is currently editing inline, or null if none. */
  readonly editingNoteId = signal<number | null>(null);
  readonly editDraft = signal('');
  readonly isSavingEdit = signal(false);
  /** Ids of notes with an in-flight delete so the row can render disabled
   *  while the DELETE request is pending. */
  readonly deletingNoteIds = signal<Set<number>>(new Set());

  /** User-authored notes only — GitLab tags system-generated notes
   *  (label toggles, MR references, state changes) with `system: true`;
   *  filtering them keeps the panel focused on human conversation. */
  readonly visibleComments = computed<GitlabOriginalComment[]>(() => {
    const i = this.issue();
    if (!i) return [];
    return (i.comments ?? []).filter((c) => !c.system);
  });

  constructor() {
    this._matDialogRef
      .keydownEvents()
      .pipe(takeUntilDestroyed(this._destroyRef))
      .subscribe((ev) => {
        // Ctrl/Cmd+Enter posts. Matches the compose-then-send affordance
        // GitLab's own web UI uses.
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
          ev.preventDefault();
          this.postComment().catch(() => {});
        }
      });
  }

  ngOnInit(): void {
    // Kick off the initial fetch outside the constructor per the async-in-
    // constructor guideline. The dialog stays in its loading state until
    // _loadIssue toggles isLoading off.
    this._loadIssue().catch((err) => {
      IssueLog.err('DialogGitlabComments load failed', err);
    });
  }

  close(): void {
    this._matDialogRef.close();
  }

  async refresh(): Promise<void> {
    await this._loadIssue();
  }

  async postComment(): Promise<void> {
    const body = this.draft().trim();
    if (!body || this.isPosting()) return;
    const task = this.data.task;
    if (!task.issueProviderId || !task.issueId) return;

    this.isPosting.set(true);
    try {
      const cfg = await firstValueFrom(
        this._issueProviderService.getCfgOnce$(task.issueProviderId, 'GITLAB'),
      );
      await firstValueFrom(
        this._gitlabApiService.postIssueNote$(task.issueId, body, cfg, this.isInternal()),
      );
      this.draft.set('');
      // Reset the internal flag after a successful post — the checkbox is a
      // per-message affordance, not a sticky mode. Users who want a whole
      // thread of internal notes can toggle it back on for each.
      this.isInternal.set(false);
      // Refresh so the new note appears without a manual reload.
      await this._loadIssue();
    } catch (err) {
      IssueLog.err('post comment failed', err);
      this._snackService.open({
        type: 'ERROR',
        msg: 'Failed to post comment',
      });
    } finally {
      this.isPosting.set(false);
    }
  }

  isNoteInternal(c: GitlabOriginalComment): boolean {
    // Older GitLab versions still emit `confidential`; recent ones use
    // `internal`. Treat either as "internal" so the badge is consistent
    // across instances.
    return !!(c.internal || c.confidential);
  }

  startEdit(comment: GitlabOriginalComment): void {
    // Cancel any prior edit — only one inline editor at a time keeps the
    // save/cancel semantics simple and prevents interleaved PUTs.
    this.editingNoteId.set(comment.id);
    this.editDraft.set(comment.body);
  }

  cancelEdit(): void {
    this.editingNoteId.set(null);
    this.editDraft.set('');
  }

  async saveEdit(): Promise<void> {
    const noteId = this.editingNoteId();
    const body = this.editDraft().trim();
    if (noteId == null || !body || this.isSavingEdit()) return;
    const task = this.data.task;
    if (!task.issueProviderId || !task.issueId) return;

    this.isSavingEdit.set(true);
    try {
      const cfg = await firstValueFrom(
        this._issueProviderService.getCfgOnce$(task.issueProviderId, 'GITLAB'),
      );
      await firstValueFrom(
        this._gitlabApiService.updateIssueNote$(task.issueId, noteId, body, cfg),
      );
      this.cancelEdit();
      await this._loadIssue();
    } catch (err) {
      IssueLog.err('edit comment failed', err);
      this._snackService.open({
        type: 'ERROR',
        msg: 'Failed to edit comment (author/maintainer only)',
      });
    } finally {
      this.isSavingEdit.set(false);
    }
  }

  async deleteComment(comment: GitlabOriginalComment): Promise<void> {
    if (this.deletingNoteIds().has(comment.id)) return;
    const confirmed = await firstValueFrom(
      this._matDialog
        .open(DialogConfirmComponent, {
          restoreFocus: true,
          data: { message: 'Delete this comment from GitLab? This cannot be undone.' },
        })
        .afterClosed(),
    );
    if (!confirmed) return;

    const task = this.data.task;
    if (!task.issueProviderId || !task.issueId) return;

    this.deletingNoteIds.update((prev) => new Set(prev).add(comment.id));
    try {
      const cfg = await firstValueFrom(
        this._issueProviderService.getCfgOnce$(task.issueProviderId, 'GITLAB'),
      );
      await firstValueFrom(
        this._gitlabApiService.deleteIssueNote$(task.issueId, comment.id, cfg),
      );
      await this._loadIssue();
    } catch (err) {
      IssueLog.err('delete comment failed', err);
      this._snackService.open({
        type: 'ERROR',
        msg: 'Failed to delete comment (author/maintainer only)',
      });
    } finally {
      this.deletingNoteIds.update((prev) => {
        const next = new Set(prev);
        next.delete(comment.id);
        return next;
      });
    }
  }

  private async _loadIssue(): Promise<void> {
    const task = this.data.task;
    if (!task.issueProviderId || !task.issueId) {
      this.errorMsg.set('Task is not linked to a GitLab issue.');
      this.isLoading.set(false);
      return;
    }
    this.isLoading.set(true);
    this.errorMsg.set(null);
    try {
      const cfg = await firstValueFrom(
        this._issueProviderService.getCfgOnce$(task.issueProviderId, 'GITLAB'),
      );
      const issue = await firstValueFrom(
        this._gitlabApiService.getById$(task.issueId, cfg),
      );
      this.issue.set(issue ?? null);
    } catch (err) {
      IssueLog.err('DialogGitlabComments getById failed', err);
      this.errorMsg.set('Could not load comments from GitLab.');
    } finally {
      this.isLoading.set(false);
    }
  }
}
