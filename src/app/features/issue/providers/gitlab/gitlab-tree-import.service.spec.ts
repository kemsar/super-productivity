import { TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { Action, Store } from '@ngrx/store';
import { of } from 'rxjs';

import { GitlabTreeImportService } from './gitlab-tree-import.service';
import { GitlabApiService } from './gitlab-api/gitlab-api.service';
import { ProjectService } from '../../../project/project.service';
import { MenuTreeService } from '../../../menu-tree/menu-tree.service';
import { IssueProviderActions } from '../../store/issue-provider.actions';
import { GitlabCfg } from './gitlab.model';
import { DEFAULT_GITLAB_CFG } from './gitlab.const';
import {
  GitlabOriginalGroupProject,
  GitlabOriginalSubgroup,
} from './gitlab-api/gitlab-api-responses';
import {
  MenuTreeFolderNode,
  MenuTreeKind,
  MenuTreeTreeNode,
} from '../../../menu-tree/store/menu-tree.model';

const PARENT_PROVIDER_ID = 'gitlab-parent-1';

const makeCfg = (overrides: Partial<GitlabCfg> = {}): GitlabCfg => ({
  ...DEFAULT_GITLAB_CFG,
  sourceMode: 'group',
  group: 'mygroup',
  token: 'tok',
  ...overrides,
});

const makeSubgroup = (
  fullPath: string,
  name = fullPath.split('/').pop() ?? fullPath,
): GitlabOriginalSubgroup => ({
  id: Math.floor(Math.random() * 100000),
  name,
  path: fullPath.split('/').pop() ?? fullPath,
  full_path: fullPath,
  parent_id: null,
});

const makeProject = (
  fullPath: string,
  id: number,
  archived = false,
): GitlabOriginalGroupProject => ({
  id,
  name: fullPath.split('/').pop() ?? fullPath,
  path: fullPath.split('/').pop() ?? fullPath,
  path_with_namespace: fullPath,
  archived,
  namespace: {
    id: 1,
    full_path: fullPath.split('/').slice(0, -1).join('/'),
  },
});

describe('GitlabTreeImportService', () => {
  let service: GitlabTreeImportService;
  let apiSpy: jasmine.SpyObj<GitlabApiService>;
  let projectSpy: jasmine.SpyObj<ProjectService>;
  let menuTreeStub: {
    projectTree: WritableSignal<MenuTreeTreeNode[]>;
    setProjectTree: jasmine.Spy<(next: MenuTreeTreeNode[]) => void>;
  };
  let store: jasmine.SpyObj<Store>;
  let projectIdCounter: number;
  let projectTreeState: WritableSignal<MenuTreeTreeNode[]>;

  const dispatchedActions = (): Action[] =>
    store.dispatch.calls.allArgs().map((args) => args[0] as unknown as Action);

  const findFolderByName = (
    tree: MenuTreeTreeNode[],
    name: string,
  ): MenuTreeFolderNode | null => {
    for (const node of tree) {
      if (node.k === MenuTreeKind.FOLDER) {
        if (node.name === name) return node;
        const nested = findFolderByName(node.children, name);
        if (nested) return nested;
      }
    }
    return null;
  };

  beforeEach(() => {
    projectIdCounter = 0;
    projectTreeState = signal<MenuTreeTreeNode[]>([]);
    apiSpy = jasmine.createSpyObj<GitlabApiService>('GitlabApiService', [
      'getGroupSubgroups$',
      'getGroupProjects$',
    ]);
    projectSpy = jasmine.createSpyObj<ProjectService>('ProjectService', ['add']);
    projectSpy.add.and.callFake(() => `sp-project-${++projectIdCounter}`);
    // MenuTreeService.projectTree is a computed signal on the real service; a
    // jasmine spy method won't satisfy the Signal<> type the service reads. A
    // stub with a WritableSignal + a plain spy for setProjectTree is enough
    // for tree-import to build and inspect the resulting tree.
    menuTreeStub = {
      projectTree: projectTreeState,
      setProjectTree: jasmine
        .createSpy<(next: MenuTreeTreeNode[]) => void>('setProjectTree')
        .and.callFake((next) => projectTreeState.set(next)),
    };
    store = jasmine.createSpyObj<Store>('Store', ['dispatch']);

    TestBed.configureTestingModule({
      providers: [
        GitlabTreeImportService,
        { provide: GitlabApiService, useValue: apiSpy },
        { provide: ProjectService, useValue: projectSpy },
        { provide: MenuTreeService, useValue: menuTreeStub },
        { provide: Store, useValue: store },
      ],
    });
    service = TestBed.inject(GitlabTreeImportService);
  });

  it('throws when sourceMode is not group', async () => {
    await expectAsync(
      service.importTree({ ...makeCfg(), sourceMode: 'project' }, PARENT_PROVIDER_ID),
    ).toBeRejectedWithError(/sourceMode=group/);
  });

  it('throws when group path is missing', async () => {
    await expectAsync(
      service.importTree({ ...makeCfg(), group: null }, PARENT_PROVIDER_ID),
    ).toBeRejectedWithError(/sourceMode=group/);
  });

  it('creates SP projects + providers for a flat group with two projects', async () => {
    apiSpy.getGroupSubgroups$.and.returnValue(of([]));
    apiSpy.getGroupProjects$.and.returnValue(
      of([makeProject('mygroup/proj-a', 10), makeProject('mygroup/proj-b', 11)]),
    );

    const result = await service.importTree(makeCfg(), PARENT_PROVIDER_ID);

    expect(result.createdProjects).toBe(2);
    expect(result.reusedProjects).toBe(0);
    expect(projectSpy.add).toHaveBeenCalledWith({ title: 'proj-a' });
    expect(projectSpy.add).toHaveBeenCalledWith({ title: 'proj-b' });

    // Single-provider design: no per-project GitLab providers created — the
    // parent group provider stays the sole polling source. Only the mapping
    // update to that parent should fire.
    const actions = dispatchedActions();
    const addProviderActions = actions.filter(
      (a) => a.type === IssueProviderActions.addIssueProvider.type,
    );
    expect(addProviderActions).toHaveSize(0);
    const updateProviderActions = actions.filter(
      (a) => a.type === IssueProviderActions.updateIssueProvider.type,
    );
    expect(updateProviderActions).toHaveSize(1);
  });

  it('nests subgroups into folders and sets a stable folderId', async () => {
    apiSpy.getGroupSubgroups$.and.callFake((path) => {
      if (path === 'mygroup') return of([makeSubgroup('mygroup/sub')]);
      return of([]);
    });
    apiSpy.getGroupProjects$.and.callFake((path) => {
      if (path === 'mygroup/sub') return of([makeProject('mygroup/sub/proj', 20)]);
      return of([]);
    });

    await service.importTree(makeCfg(), PARENT_PROVIDER_ID);

    const rootFolder = findFolderByName(projectTreeState(), 'mygroup');
    expect(rootFolder).withContext('root folder created').not.toBeNull();
    const subFolder = findFolderByName(projectTreeState(), 'sub');
    expect(subFolder).withContext('subgroup folder created').not.toBeNull();
    expect(subFolder!.children).toHaveSize(1);
    expect(subFolder!.children[0].k).toBe(MenuTreeKind.PROJECT);
  });

  it('reuses existing mapping entries on re-run', async () => {
    apiSpy.getGroupSubgroups$.and.returnValue(of([]));
    apiSpy.getGroupProjects$.and.returnValue(
      of([makeProject('mygroup/keep', 30), makeProject('mygroup/new', 31)]),
    );

    const cfgWithMapping = makeCfg({
      treeImportMapping: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'mygroup/keep': {
          spProjectId: 'existing-sp-project',
          gitlabProjectId: 30,
        },
      },
      treeImportFolderMapping: {
        mygroup: 'existing-folder-id',
      },
    });

    const result = await service.importTree(cfgWithMapping, PARENT_PROVIDER_ID);

    expect(result.reusedProjects).toBe(1);
    expect(result.createdProjects).toBe(1);
    expect(result.reusedFolders).toBe(1);
    expect(projectSpy.add).toHaveBeenCalledTimes(1);
    expect(projectSpy.add).toHaveBeenCalledWith({ title: 'new' });
    // Root folder retained its previous id.
    const rootFolder = findFolderByName(projectTreeState(), 'mygroup');
    expect(rootFolder?.id).toBe('existing-folder-id');
  });

  it('skips archived projects', async () => {
    apiSpy.getGroupSubgroups$.and.returnValue(of([]));
    apiSpy.getGroupProjects$.and.returnValue(
      of([
        makeProject('mygroup/live', 40),
        makeProject('mygroup/archived', 41, /* archived */ true),
      ]),
    );

    const result = await service.importTree(makeCfg(), PARENT_PROVIDER_ID);

    expect(result.createdProjects).toBe(1);
    expect(projectSpy.add).toHaveBeenCalledOnceWith({ title: 'live' });
  });

  it("preserves the user's existing top-level tree", async () => {
    projectTreeState.set([
      {
        k: MenuTreeKind.FOLDER,
        id: 'user-folder',
        name: 'user personal',
        isExpanded: true,
        children: [{ k: MenuTreeKind.PROJECT, id: 'unrelated-project' }],
      },
    ]);
    apiSpy.getGroupSubgroups$.and.returnValue(of([]));
    apiSpy.getGroupProjects$.and.returnValue(of([makeProject('mygroup/proj', 50)]));

    await service.importTree(makeCfg(), PARENT_PROVIDER_ID);

    const finalTree = projectTreeState();
    const userFolder = findFolderByName(finalTree, 'user personal');
    expect(userFolder).withContext('untouched folder preserved').not.toBeNull();
    expect(userFolder!.children[0]).toEqual({
      k: MenuTreeKind.PROJECT,
      id: 'unrelated-project',
    });
    // GitLab-derived folder is at the root, ahead of the user folder.
    expect(finalTree[0].k).toBe(MenuTreeKind.FOLDER);
    expect((finalTree[0] as MenuTreeFolderNode).name).toBe('mygroup');
  });

  it('persists the fresh mappings via updateIssueProvider', async () => {
    apiSpy.getGroupSubgroups$.and.returnValue(of([]));
    apiSpy.getGroupProjects$.and.returnValue(of([makeProject('mygroup/x', 60)]));

    const result = await service.importTree(makeCfg(), PARENT_PROVIDER_ID);

    const dispatched = dispatchedActions().find(
      (a) => a.type === IssueProviderActions.updateIssueProvider.type,
    ) as ReturnType<typeof IssueProviderActions.updateIssueProvider> | undefined;
    expect(dispatched).toBeDefined();
    expect(dispatched!.issueProvider.id).toBe(PARENT_PROVIDER_ID);
    const changes = dispatched!.issueProvider.changes as {
      treeImportMapping: Record<string, unknown>;
      treeImportFolderMapping: Record<string, string>;
    };
    expect(changes.treeImportMapping['mygroup/x']).toEqual(
      result.projectMapping['mygroup/x'],
    );
    expect(changes.treeImportFolderMapping['mygroup']).toEqual(
      result.folderMapping['mygroup'],
    );
  });
});
