import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  Input,
  output,
  signal,
} from '@angular/core';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';

import { IssueProviderGitlab } from '../../../issue.model';
import { SnackService } from '../../../../../core/snack/snack.service';
import { T } from '../../../../../t.const';
import { IssueLog } from '../../../../../core/log';
import { GitlabTreeImportService } from '../gitlab-tree-import.service';

/**
 * GitLab-specific additional config UI. Currently only surfaces the
 * "Generate SP tree from group" opt-in — the parent dialog checks
 * `willGenerateOnSave()` in its submit flow and calls `runImport()` after
 * dispatching the save.
 *
 * Kept as its own component (rather than a formly field) so it can inject
 * the tree-import service — formly button `onClick` runs outside the
 * injection context and can't reach services.
 *
 * Slots into `dialog-edit-issue-provider.component.html` under
 * `@case ('GITLAB')`.
 */
@Component({
  selector: 'gitlab-additional-cfg',
  standalone: true,
  imports: [MatCheckbox, MatProgressSpinner, FormsModule, TranslatePipe],
  template: `
    @if (isGroupMode()) {
      <div class="tree-import-row">
        <mat-checkbox
          [(ngModel)]="generateOnSaveModel"
          [disabled]="!canImport() || isImporting()"
        >
          @if (isImporting()) {
            <mat-progress-spinner
              diameter="16"
              mode="indeterminate"
              style="display: inline-block; margin-right: 8px; vertical-align: middle"
            ></mat-progress-spinner>
          }
          {{ T.F.GITLAB.FORM.TREE_IMPORT_CHECKBOX | translate }}
        </mat-checkbox>
        <p class="tree-import-hint">
          {{ T.F.GITLAB.FORM.TREE_IMPORT_HINT | translate }}
        </p>
        @if (lastResultMsg()) {
          <p class="tree-import-result">{{ lastResultMsg() }}</p>
        }
      </div>
    }
  `,
  styles: [
    `
      .tree-import-row {
        margin-top: 12px;
        margin-bottom: 12px;
      }
      .tree-import-hint {
        margin-top: 4px;
        color: var(--text-color-muted);
        font-size: 12px;
      }
      .tree-import-result {
        margin-top: 4px;
        color: var(--c-primary);
        font-size: 13px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitlabAdditionalCfgComponent {
  private readonly _treeImport = inject(GitlabTreeImportService);
  private readonly _snack = inject(SnackService);
  private readonly _cdr = inject(ChangeDetectorRef);

  readonly modelChange = output<IssueProviderGitlab>();
  readonly T = T;

  isImporting = signal(false);
  lastResultMsg = signal<string | null>(null);
  // Transient — never round-tripped into the persisted config. The parent
  // dialog reads it on Save, runs the import, and after the dialog closes the
  // checkbox is discarded (re-opening the dialog starts unchecked).
  generateOnSaveModel = false;

  private _cfg?: IssueProviderGitlab;

  @Input() set cfg(cfg: IssueProviderGitlab) {
    this._cfg = cfg;
  }

  isGroupMode(): boolean {
    return this._cfg?.sourceMode === 'group';
  }

  canImport(): boolean {
    return !!(this._cfg?.group && this._cfg?.token && this._cfg?.id);
  }

  willGenerateOnSave(): boolean {
    return this.isGroupMode() && this.canImport() && this.generateOnSaveModel;
  }

  /**
   * Runs the tree import against the currently-bound cfg. Called by the
   * parent dialog after the provider save is dispatched (see
   * dialog-edit-issue-provider.component.ts:submit).
   */
  async runImport(): Promise<IssueProviderGitlab | null> {
    if (!this._cfg || !this.canImport()) {
      return null;
    }
    this.isImporting.set(true);
    this.lastResultMsg.set(null);
    try {
      const result = await this._treeImport.importTree(this._cfg, this._cfg.id);
      const msg =
        `+${result.createdProjects} projects, ` +
        `+${result.createdFolders} folders ` +
        `(reused ${result.reusedProjects}/${result.reusedFolders})`;
      this.lastResultMsg.set(msg);
      this._snack.open({ type: 'SUCCESS', msg });
      // Return the freshly-mapped cfg so the parent dialog can persist the
      // mappings into its own model / next dispatch instead of relying on the
      // store round-trip. Also re-uncheck so a re-save on the same open dialog
      // doesn't blindly re-import.
      this.generateOnSaveModel = false;
      const nextCfg: IssueProviderGitlab = {
        ...this._cfg,
        treeImportMapping: result.projectMapping,
        treeImportFolderMapping: result.folderMapping,
      };
      this.modelChange.emit(nextCfg);
      return nextCfg;
    } catch (err) {
      IssueLog.err('gitlab tree-import failed', err);
      this._snack.open({
        type: 'ERROR',
        msg: T.F.GITLAB.FORM.TREE_IMPORT_ERR,
      });
      return null;
    } finally {
      this.isImporting.set(false);
      this._cdr.markForCheck();
    }
  }
}
