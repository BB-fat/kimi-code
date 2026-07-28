/**
 * `sessionSkillCatalog` domain (L3) — extra `ISkillSource` producer.
 *
 * Discovers user-configured extra skill directories (`extraSkillDirs`) through
 * `ISkillDiscovery`, contributing them at priority 10 (above plugin / builtin,
 * below user / workspace). Relative paths resolve against the session project
 * root; `~` and `~/...` resolve against the bootstrap home dir. Watches the
 * configured directories through `fileSourceMonitor` and re-fires
 * `onDidChange` on debounced fs changes. Bound at Session scope so each
 * session reads its own workspace root.
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
  EXTRA_SKILL_DIRS_SECTION,
  type ExtraSkillDirsConfig,
} from '#/app/skillCatalog/configSection';
import { resolveConfiguredSkillRoots } from '#/app/skillCatalog/skillRoots';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import {
  isSkillLoadAborted,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
import { SKILL_ROOT_WATCH_OPTIONS } from '#/app/skillCatalog/skillTraversal';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IExtraFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IExtraFileSkillSource: ServiceIdentifier<IExtraFileSkillSource> =
  createDecorator<IExtraFileSkillSource>('extraFileSkillSource');

export class ExtraFileSkillSource extends Disposable implements IExtraFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'extra';
  readonly priority = SKILL_SOURCE_PRIORITY.extra;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watcher: IFileSourceWatch;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IConfigService private readonly config: IConfigService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSourceMonitor fileSourceMonitor: IFileSourceMonitor,
  ) {
    super();
    this.watcher = this._register(
      fileSourceMonitor.createWatch(SKILL_ROOT_WATCH_OPTIONS, () => this.onDidChangeEmitter.fire()),
    );
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === EXTRA_SKILL_DIRS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(signal?: AbortSignal): Promise<SkillContribution> {
    await this.config.ready;
    if (isSkillLoadAborted(signal)) return { skills: [] };
    const extraSkillDirs = this.config.get<ExtraSkillDirsConfig>(EXTRA_SKILL_DIRS_SECTION) ?? [];
    const resolution = await resolveConfiguredSkillRoots(
      extraSkillDirs,
      this.workspace.workDir,
      this.bootstrap.osHomeDir,
      'extra',
    );
    if (isSkillLoadAborted(signal)) return { skills: [] };
    await this.watcher.setPaths(resolution.candidates);
    if (isSkillLoadAborted(signal)) return { skills: [] };
    return this.discovery.discover(resolution.roots, signal);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IExtraFileSkillSource,
  ExtraFileSkillSource,
  ScopeActivation.OnScopeCreated,
  'sessionSkillCatalog',
);
