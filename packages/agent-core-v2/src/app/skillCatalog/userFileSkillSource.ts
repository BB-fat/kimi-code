/**
 * `skillCatalog` domain (L3) — user/brand `ISkillSource` producer.
 *
 * Discovers user skills from the bootstrap home directories through
 * `ISkillDiscovery`, contributing them at priority 20 (above extra / plugin /
 * builtin, below workspace). Reads home paths from `bootstrap`. Watches the
 * candidate root paths (existing or not) through `fileSourceMonitor` and
 * re-fires `onDidChange` on debounced fs changes. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import {
  IFileSourceMonitor,
  type IFileSourceWatch,
} from '#/app/fileSourceMonitor/fileSourceMonitor';

import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from './configSection';
import { ISkillCatalogRuntimeOptions } from './skillCatalogRuntimeOptions';
import { ISkillDiscovery } from './skillDiscovery';
import { resolveUserSkillRoots } from './skillRoots';
import {
  isSkillLoadAborted,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from './skillSource';
import { SKILL_ROOT_WATCH_OPTIONS } from './skillTraversal';

export interface IUserFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IUserFileSkillSource: ServiceIdentifier<IUserFileSkillSource> =
  createDecorator<IUserFileSkillSource>('userFileSkillSource');

export class UserFileSkillSource extends Disposable implements IUserFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'user';
  readonly priority = SKILL_SOURCE_PRIORITY.user;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watcher: IFileSourceWatch;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
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
    const resolution = await resolveUserSkillRoots(
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
      { mergeAllAvailableSkills },
    );
    if (isSkillLoadAborted(signal)) return { skills: [] };
    await this.watcher.setPaths(resolution.candidates);
    if (isSkillLoadAborted(signal)) return { skills: [] };
    return this.discovery.discover(resolution.roots, signal);
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserFileSkillSource,
  UserFileSkillSource,
  ScopeActivation.OnScopeCreated,
  'skillCatalog',
);
