import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { nanoid } from 'nanoid';

import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { GitlabCfg, GitlabTreeImportEntry } from './gitlab.model';
import {
  GitlabDiscoveredGroup,
  GitlabDiscoveredProject,
  GitlabTreeImportResult,
} from './gitlab-group-tree.model';
import { ProjectService } from '../../../project/project.service';
import { MenuTreeService } from '../../../menu-tree/menu-tree.service';
import {
  MenuTreeFolderNode,
  MenuTreeKind,
  MenuTreeProjectNode,
  MenuTreeTreeNode,
} from '../../../menu-tree/store/menu-tree.model';
import { IssueProviderActions } from '../../store/issue-provider.actions';
import { IssueProviderGitlab } from '../../issue.model';

/**
 * One-shot importer that mirrors a GitLab group's subgroup/project structure
 * into SP as a folder tree with one SP project per GitLab project. Idempotent
 * on re-run via mappings on the parent group provider's config
 * (`treeImportMapping`, `treeImportFolderMapping`).
 *
 * Deliberately does NOT create a per-project GitLab provider — the parent
 * group provider stays the single source of polling + credentials, and each
 * imported issue is routed to the mapped SP project at add-task time via
 * `GitlabCommonInterfacesService.getAddTaskDataForCfg`. One token to rotate,
 * one polling loop, N SP projects. See issue #10 discussion.
 *
 * Non-goals (v1, see issue #10): rename/move detection, deletion propagation,
 * two-way tree sync. If a GitLab path changes, a re-run leaves the old SP
 * project orphaned and creates a new one at the new path.
 */
@Injectable({ providedIn: 'root' })
export class GitlabTreeImportService {
  private readonly _gitlabApi = inject(GitlabApiService);
  private readonly _projectService = inject(ProjectService);
  private readonly _menuTree = inject(MenuTreeService);
  private readonly _store = inject(Store);

  async importTree(
    cfg: GitlabCfg,
    parentProviderId: string,
  ): Promise<GitlabTreeImportResult> {
    if (cfg.sourceMode !== 'group' || !cfg.group) {
      throw new Error('GitLab tree import requires sourceMode=group and a group path.');
    }

    const tree = await this._discoverTree(cfg.group, cfg);

    const projectMapping: Record<string, GitlabTreeImportEntry> = {
      ...cfg.treeImportMapping,
    };
    const folderMapping: Record<string, string> = {
      ...cfg.treeImportFolderMapping,
    };
    const result: GitlabTreeImportResult = {
      createdProjects: 0,
      reusedProjects: 0,
      createdFolders: 0,
      reusedFolders: 0,
      skippedArchived: 0,
      projectMapping,
      folderMapping,
    };

    // Pass 1: create SP projects for any discovered GitLab project not already
    // in the mapping. No new GitLab providers — the parent group provider
    // remains the single polling source; routing happens per-issue via
    // getAddTaskDataForCfg. Bulk-dispatch shape from CLAUDE.md rule #6: many
    // rapid `addProject` dispatches are followed by `setTimeout(0)` before the
    // menu-tree write reads the settled store.
    const walkProjects = (node: GitlabDiscoveredGroup): void => {
      for (const project of node.projects) {
        if (projectMapping[project.fullPath]) {
          result.reusedProjects++;
          continue;
        }
        const entry = this._createProject(project);
        projectMapping[project.fullPath] = entry;
        result.createdProjects++;
      }
      node.subgroups.forEach(walkProjects);
    };
    walkProjects(tree);

    // Settle the reducer before we compute the new menu-tree — the tree build
    // below only reads what's already been dispatched, but we still want the
    // op-log to record adds in this order to avoid a later-op reading a project
    // that hadn't been persisted yet.
    await new Promise((r) => setTimeout(r, 0));

    // Pass 2: build the fresh nested folder subtree from discovery. Folder ids
    // are stable across runs via folderMapping so users' manual expansion/
    // collapse and drag ordering on OUR folders survive.
    const gitlabSubtree = this._buildGitlabSubtree(
      tree,
      projectMapping,
      folderMapping,
      result,
    );

    // Merge into the existing project tree: strip previous placements of any
    // project we own (so we don't leave duplicates) and any folder we own that
    // no longer appears in the discovery (so pruning eventually works even if
    // rename detection doesn't). Root-append our subtree if we don't already
    // have a root folder for this group.
    const currentTree = this._menuTree.projectTree();
    const ownedProjectIds = new Set(
      Object.values(projectMapping).map((e) => e.spProjectId),
    );
    const activeFolderIds = new Set<string>();
    collectFolderIds(gitlabSubtree, activeFolderIds);
    const previouslyOwnedFolderIds = new Set(Object.values(folderMapping));
    const stalePreviouslyOwnedFolderIds = new Set<string>();
    previouslyOwnedFolderIds.forEach((id) => {
      if (!activeFolderIds.has(id)) {
        stalePreviouslyOwnedFolderIds.add(id);
      }
    });

    const strippedTree = stripOwnedItems(
      currentTree,
      ownedProjectIds,
      activeFolderIds,
      stalePreviouslyOwnedFolderIds,
    );
    const nextTree: MenuTreeTreeNode[] = [gitlabSubtree, ...strippedTree];
    this._menuTree.setProjectTree(nextTree);

    // Persist mappings back onto the parent provider config so future runs can
    // dedup + reuse folder ids.
    this._store.dispatch(
      IssueProviderActions.updateIssueProvider({
        issueProvider: {
          id: parentProviderId,
          changes: {
            treeImportMapping: projectMapping,
            treeImportFolderMapping: folderMapping,
          } as Partial<IssueProviderGitlab>,
        },
      }),
    );

    return result;
  }

  private async _discoverTree(
    groupPath: string,
    cfg: GitlabCfg,
  ): Promise<GitlabDiscoveredGroup> {
    const [subgroups, projects] = await Promise.all([
      firstValueFrom(this._gitlabApi.getGroupSubgroups$(groupPath, cfg)),
      firstValueFrom(this._gitlabApi.getGroupProjects$(groupPath, cfg)),
    ]);

    const childGroups = await Promise.all(
      subgroups.map(async (sg) => {
        const child = await this._discoverTree(sg.full_path, cfg);
        return { ...child, name: sg.name };
      }),
    );

    const discoveredProjects: GitlabDiscoveredProject[] = projects
      .filter((p) => !p.archived)
      .map((p) => ({
        id: p.id,
        fullPath: p.path_with_namespace,
        name: p.name,
      }));

    return {
      fullPath: groupPath,
      name: groupPath.split('/').pop() ?? groupPath,
      subgroups: childGroups,
      projects: discoveredProjects,
    };
  }

  private _createProject(project: GitlabDiscoveredProject): GitlabTreeImportEntry {
    const spProjectId = this._projectService.add({ title: project.name });
    return {
      spProjectId,
      gitlabProjectId: project.id,
    };
  }

  private _buildGitlabSubtree(
    node: GitlabDiscoveredGroup,
    projectMapping: Record<string, GitlabTreeImportEntry>,
    folderMapping: Record<string, string>,
    result: GitlabTreeImportResult,
  ): MenuTreeFolderNode {
    const children: MenuTreeTreeNode[] = [];

    for (const subgroup of node.subgroups) {
      children.push(
        this._buildGitlabSubtree(subgroup, projectMapping, folderMapping, result),
      );
    }

    for (const project of node.projects) {
      const entry = projectMapping[project.fullPath];
      if (!entry) {
        // Shouldn't happen (pass 1 populated the mapping), but skip defensively
        // rather than throw — partial trees are more useful than none.
        continue;
      }
      const projectNode: MenuTreeProjectNode = {
        k: MenuTreeKind.PROJECT,
        id: entry.spProjectId,
      };
      children.push(projectNode);
    }

    let folderId = folderMapping[node.fullPath];
    if (folderId) {
      result.reusedFolders++;
    } else {
      folderId = createFolderId();
      folderMapping[node.fullPath] = folderId;
      result.createdFolders++;
    }

    return {
      k: MenuTreeKind.FOLDER,
      id: folderId,
      name: node.name,
      isExpanded: true,
      children,
    };
  }
}

// -- helpers ---------------------------------------------------------------

const createFolderId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `folder-${nanoid()}`;
};

const collectFolderIds = (node: MenuTreeTreeNode, acc: Set<string>): void => {
  if (node.k === MenuTreeKind.FOLDER) {
    acc.add(node.id);
    node.children.forEach((c) => collectFolderIds(c, acc));
  }
};

/**
 * Removes every project node whose id is in `ownedProjectIds` and every folder
 * whose id is in `stalePreviouslyOwnedFolderIds`. Folders in `activeFolderIds`
 * are also stripped (they will be re-added by the fresh subtree) so the tree
 * never contains a folder id in two places. Empty folders left behind by
 * pruning are preserved — they may be user-created ones that happened to hold
 * only our projects.
 */
const stripOwnedItems = (
  tree: MenuTreeTreeNode[],
  ownedProjectIds: Set<string>,
  activeFolderIds: Set<string>,
  stalePreviouslyOwnedFolderIds: Set<string>,
): MenuTreeTreeNode[] => {
  const walk = (nodes: MenuTreeTreeNode[]): MenuTreeTreeNode[] => {
    const out: MenuTreeTreeNode[] = [];
    for (const node of nodes) {
      if (node.k === MenuTreeKind.PROJECT) {
        if (ownedProjectIds.has(node.id)) {
          continue;
        }
        out.push(node);
        continue;
      }
      if (node.k === MenuTreeKind.FOLDER) {
        if (activeFolderIds.has(node.id) || stalePreviouslyOwnedFolderIds.has(node.id)) {
          continue;
        }
        out.push({ ...node, children: walk(node.children) });
        continue;
      }
      out.push(node);
    }
    return out;
  };
  return walk(tree);
};
