/**
 * `sessionSkillCatalog` domain (L3) — workspace `ISkillSource` producer.
 *
 * Discovers project skills from the session's current `workDir`
 * (`workspaceContext`) through `ISkillDiscovery`, contributing them at priority
 * 30 (above user / extra / plugin / builtin). Watches the candidate root paths
 * (existing or not) through `fileSourceMonitor` and re-fires `onDidChange` on
 * debounced fs changes. Bound at Session scope so each session reads its own
 * workspace root.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import {
  IFileSourceMonitor,
  type IFileSourceWatch,
} from '#/app/fileSourceMonitor/fileSourceMonitor';
import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from '#/app/skillCatalog/configSection';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { resolveProjectSkillRoots } from '#/app/skillCatalog/skillRoots';
import {
  isSkillLoadAborted,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
import { SKILL_ROOT_WATCH_OPTIONS } from '#/app/skillCatalog/skillTraversal';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IWorkspaceFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IWorkspaceFileSkillSource: ServiceIdentifier<IWorkspaceFileSkillSource> =
  createDecorator<IWorkspaceFileSkillSource>('workspaceFileSkillSource');

export class WorkspaceFileSkillSource extends Disposable implements IWorkspaceFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'workspace';
  readonly priority = SKILL_SOURCE_PRIORITY.workspace;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watcher: IFileSourceWatch;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IConfigService private readonly config: IConfigService,
    @ISkillCatalogRuntimeOptions private readonly runtimeOptions: ISkillCatalogRuntimeOptions,
    @IFileSourceMonitor fileSourceMonitor: IFileSourceMonitor,
  ) {
    super();
    this.watcher = this._register(
      fileSourceMonitor.createWatch(SKILL_ROOT_WATCH_OPTIONS, () => this.onDidChangeEmitter.fire()),
    );
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(signal?: AbortSignal): Promise<SkillContribution> {
    if ((this.runtimeOptions.explicitDirs?.length ?? 0) > 0) {
      return { skills: [] };
    }
    await this.config.ready;
    if (isSkillLoadAborted(signal)) return { skills: [] };
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    const resolution = await resolveProjectSkillRoots(this.workspace.workDir, {
      mergeAllAvailableSkills,
    });
    if (isSkillLoadAborted(signal)) return { skills: [] };
    await this.watcher.setPaths(resolution.candidates);
    if (isSkillLoadAborted(signal)) return { skills: [] };
    return this.discovery.discover(resolution.roots, signal);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IWorkspaceFileSkillSource,
  WorkspaceFileSkillSource,
  ScopeActivation.OnScopeCreated,
  'sessionSkillCatalog',
);
