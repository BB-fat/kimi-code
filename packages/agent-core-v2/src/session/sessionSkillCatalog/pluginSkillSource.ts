/**
 * `sessionSkillCatalog` domain (L3) — plugin `ISkillSource` producer.
 *
 * Discovers skills contributed by enabled plugins through `ISkillDiscovery`
 * (roots from `plugin.pluginSkillRoots()`), contributing them at priority 5
 * (above builtin, below extra / user / workspace, so project, user and extra skills win name
 * collisions). Watches the resolved roots through `fileSourceMonitor` and
 * re-emits both filesystem changes and `plugin.onDidReload` through
 * `onDidChange`. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  IFileSourceMonitor,
  type IFileSourceWatch,
} from '#/app/fileSourceMonitor/fileSourceMonitor';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import {
  isSkillLoadAborted,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
import { SKILL_ROOT_WATCH_OPTIONS } from '#/app/skillCatalog/skillTraversal';
import { IPluginService } from '#/app/plugin/plugin';

export interface IPluginSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IPluginSkillSource: ServiceIdentifier<IPluginSkillSource> =
  createDecorator<IPluginSkillSource>('pluginSkillSource');

export const PLUGIN_SKILL_SOURCE_ID = 'plugin';

export class PluginSkillSource extends Disposable implements IPluginSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = PLUGIN_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.plugin;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watcher: IFileSourceWatch;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IPluginService private readonly plugins: IPluginService,
    @IFileSourceMonitor fileSourceMonitor: IFileSourceMonitor,
  ) {
    super();
    this.watcher = this._register(
      fileSourceMonitor.createWatch(SKILL_ROOT_WATCH_OPTIONS, () => {
        this.onDidChangeEmitter.fire();
      }),
    );
    this._register(this.plugins.onDidReload(() => {
      this.onDidChangeEmitter.fire();
    }));
  }

  async load(signal?: AbortSignal): Promise<SkillContribution> {
    const roots = await this.plugins.pluginSkillRoots();
    if (isSkillLoadAborted(signal)) return { skills: [] };
    await this.watcher.setPaths(roots.map((root) => root.path));
    if (isSkillLoadAborted(signal)) return { skills: [] };
    return this.discovery.discover(roots, signal);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IPluginSkillSource,
  PluginSkillSource,
  ScopeActivation.OnScopeCreated,
  'sessionSkillCatalog',
);
