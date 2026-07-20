import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabCfg } from './gitlab.model';
import { IssueSyncAdapter } from '../../two-way-sync/issue-sync-adapter.interface';
import { FieldMapping, FieldSyncConfig } from '../../two-way-sync/issue-sync.model';
import { IssueLog } from '../../../../core/log';

/**
 * Two-way sync adapter for GitLab (issue #26). Phase B scope: the
 * `createIssue` path only — auto-creating a GitLab issue when a task is
 * added to a GitLab-mapped SP project. Push-side field sync (title, isDone,
 * dueDay → GitLab on every task edit) is intentionally still off; that
 * would flip GitLab from "SP mirrors what you see in GitLab" into "SP is
 * the source of truth", which is a bigger UX commitment than Phase B
 * wants to make.
 *
 * Push disabled via `getFieldMappings() = []` — the two-way-sync push
 * effect (`pushFieldsOnTaskUpdate$`) reads mappings to decide what to
 * push; an empty list is a clean short-circuit. Poll-side pulls continue
 * to work through `getFreshDataForIssueTask` on GitlabCommonInterfaces,
 * so tasks stay in step with GitLab as they always have.
 *
 * Later phases layer on:
 *   - Phase C: post-create `workItemUpdate` for GitLab Work Item status.
 *   - Phase D: milestone + assignee resolution before createIssue.
 *   - Future: enable push-side field sync per-field via getFieldMappings.
 */
@Injectable({ providedIn: 'root' })
export class GitlabSyncAdapterService implements IssueSyncAdapter<GitlabCfg> {
  private readonly _api = inject(GitlabApiService);

  getFieldMappings(): FieldMapping[] {
    // Push-side sync is intentionally off in Phase B — see class doc.
    return [];
  }

  getSyncConfig(_cfg: GitlabCfg): FieldSyncConfig {
    return {};
  }

  /**
   * Creates a new GitLab issue via REST from a locally-added SP task. The
   * target GitLab project comes from either:
   *   - `cfg.project` for a plain project-mode provider, or
   *   - the `treeImportMapping` entry whose `spProjectId` matches
   *     `taskContext.projectId` (group provider with tree-import).
   * `all-assigned` mode is rejected — there's no single target project.
   *
   * Returns `{ issueId, issueNumber, issueData }` in the shape SP's
   * two-way-sync effect uses to retro-link the SP task. `issueId` matches
   * SP's canonical GitLab id format `<projectPath>#<iid>` (extracted from
   * the REST response's `references.full` field), so downstream lookups
   * via `getPartsFromGitlabIssueId` work without extra shim code.
   */
  async createIssue(
    title: string,
    cfg: GitlabCfg,
    taskContext?: { projectId?: string | null },
  ): Promise<{
    issueId: string;
    issueNumber?: number;
    issueData: Record<string, unknown>;
  }> {
    const targetProjectPath = this._resolveTargetProjectPath(cfg, taskContext);
    if (!targetProjectPath) {
      throw new Error(
        "GitLab createIssue: no target project — set cfg.project or map an entry in treeImportMapping for the task's SP project.",
      );
    }
    IssueLog.log('[GitlabSyncAdapter] createIssue', {
      title,
      targetProjectPath,
    });
    const issue = await firstValueFrom(
      this._api.createIssue$(targetProjectPath, { title }, cfg),
    );
    const issueRaw = issue as unknown as Record<string, unknown>;
    // `references.full` is the canonical `<path>#<iid>` format SP already
    // uses everywhere as `issue.id`. Fall back to synthesizing it from the
    // request path + iid if the response omits it (older GitLab versions
    // sometimes do on POST responses).
    const references = (issueRaw['references'] ?? {}) as Record<string, unknown>;
    const fullRef =
      typeof references['full'] === 'string' ? (references['full'] as string) : null;
    const iid =
      typeof issueRaw['iid'] === 'number' ? (issueRaw['iid'] as number) : undefined;
    const issueId = fullRef ?? `${targetProjectPath}#${iid ?? ''}`;
    return {
      issueId,
      issueNumber: iid,
      issueData: issueRaw,
    };
  }

  async fetchIssue(issueId: string, cfg: GitlabCfg): Promise<Record<string, unknown>> {
    const issue = await firstValueFrom(this._api.getById$(issueId, cfg));
    return (issue ?? {}) as unknown as Record<string, unknown>;
  }

  async pushChanges(
    _issueId: string,
    _changes: Record<string, unknown>,
    _cfg: GitlabCfg,
  ): Promise<void> {
    // No push-side field sync in Phase B (see class doc). getFieldMappings
    // returns [] so this method never gets called with actual changes, but
    // we implement it for interface conformance and to make the intent
    // explicit if a future caller invokes it directly.
    return;
  }

  extractSyncValues(_issue: Record<string, unknown>): Record<string, unknown> {
    // No push-side fields → no baseline needed.
    return {};
  }

  getIssueLastUpdated(issue: Record<string, unknown>): number {
    const updatedAt = issue['updated_at'];
    return updatedAt ? new Date(updatedAt as string).getTime() : 0;
  }

  /**
   * Resolves the GitLab project path to POST the new issue into.
   *   - project mode: use `cfg.project` (a namespace path or numeric id).
   *   - group mode with tree-import: reverse-lookup the mapping entry
   *     whose SP-side id matches the task's projectId.
   *   - all-assigned mode: unsupported — there's no meaningful target.
   */
  private _resolveTargetProjectPath(
    cfg: GitlabCfg,
    taskContext?: { projectId?: string | null },
  ): string | null {
    const mode = cfg.sourceMode ?? 'project';
    if (mode === 'project' && cfg.project) {
      return cfg.project;
    }
    if (mode === 'group' && cfg.treeImportMapping && taskContext?.projectId) {
      const spProjectId = taskContext.projectId;
      const entry = Object.entries(cfg.treeImportMapping).find(
        ([, e]) => e.spProjectId === spProjectId,
      );
      if (entry) {
        return entry[0];
      }
    }
    return null;
  }
}
