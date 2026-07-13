/**
 * Result of walking a GitLab group's subgroup/project structure. The tree
 * builder in gitlab-tree-import.service.ts consumes this and materialises SP
 * folders and projects that mirror it.
 */
export interface GitlabDiscoveredGroup {
  /** Full GitLab path, e.g. `mygroup/subgroup`. Used as the mapping key so a
   *  rename in GitLab surfaces as a new entry rather than a silent rewrite. */
  fullPath: string;
  /** Display name (last path segment, or GitLab-provided name when available). */
  name: string;
  subgroups: GitlabDiscoveredGroup[];
  projects: GitlabDiscoveredProject[];
}

export interface GitlabDiscoveredProject {
  id: number;
  fullPath: string;
  name: string;
}

import { GitlabTreeImportEntry } from './gitlab.model';

/** Summary returned by the importer for the snack / UI callback. */
export interface GitlabTreeImportResult {
  createdProjects: number;
  reusedProjects: number;
  createdFolders: number;
  reusedFolders: number;
  skippedArchived: number;
  /** Fresh mappings after the run — the caller emits these back through
   *  `modelChange` so the dialog's working model stays aligned with the store. */
  projectMapping: Record<string, GitlabTreeImportEntry>;
  folderMapping: Record<string, string>;
}
