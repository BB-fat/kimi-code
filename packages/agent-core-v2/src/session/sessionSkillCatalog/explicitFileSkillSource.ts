/**
 * `sessionSkillCatalog` domain (L3) — explicit `ISkillSource` producer.
 *
 * Mirrors v1 SDK `skillDirs`: when runtime options provide `explicitDirs`, this
 * source contributes those directories as the user source, resolving relative
 * paths against the session project root. When no explicit dirs are configured,
 * it yields nothing so default user / project discovery remains active. Watches
 * the explicit directories through `fileSourceMonitor` and re-fires
 * `onDidChange` on debounced fs changes. Bound at Session scope so each session
 * resolves paths against its own workDir.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IFileSourceMonitor,
  type IFileSourceWatch,
} from '#/app/fileSourceMonitor/fileSourceMonitor';
import { resolveConfiguredSkillRoots } from '#/app/skillCatalog/skillRoots';
import { ISkillCatalogRuntimeOptions } from '#/app/skillCatalog/skillCatalogRuntimeOptions';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import {
  isSkillLoadAborted,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
import { SKILL_ROOT_WATCH_OPTIONS } from '#/app/skillCatalog/skillTraversal';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IExplicitFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IExplicitFileSkillSource: ServiceIdentifier<IExplicitFileSkillSource> =
  createDecorator<IExplicitFileSkillSource>('explicitFileSkillSource');

export class ExplicitFileSkillSource extends Disposable implements IExplicitFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'explicit';
  readonly priority = SKILL_SOURCE_PRIORITY.user;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watcher: IFileSourceWatch;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @ISkillCatalogRuntimeOptions private readonly runtimeOptions: ISkillCatalogRuntimeOptions,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSourceMonitor fileSourceMonitor: IFileSourceMonitor,
  ) {
    super();
    this.watcher = this._register(
      fileSourceMonitor.createWatch(SKILL_ROOT_WATCH_OPTIONS, () => this.onDidChangeEmitter.fire()),
    );
  }

  async load(signal?: AbortSignal): Promise<SkillContribution> {
    const explicitDirs = this.runtimeOptions.explicitDirs ?? [];
    if (explicitDirs.length === 0) {
      return { skills: [] };
    }
    const resolution = await resolveConfiguredSkillRoots(
      explicitDirs,
      this.workspace.workDir,
      this.bootstrap.osHomeDir,
      'user',
    );
    if (isSkillLoadAborted(signal)) return { skills: [] };
    await this.watcher.setPaths(resolution.candidates);
    if (isSkillLoadAborted(signal)) return { skills: [] };
    return this.discovery.discover(resolution.roots, signal);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IExplicitFileSkillSource,
  ExplicitFileSkillSource,
  ScopeActivation.OnScopeCreated,
  'sessionSkillCatalog',
);
