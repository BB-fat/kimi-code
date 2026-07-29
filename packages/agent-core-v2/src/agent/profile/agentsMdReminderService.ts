/**
 * `profile` domain (L4) — `IAgentAgentsMdReminderService` implementation.
 *
 * Owns the `agents_md` context-injection provider. The AGENTS.md instruction
 * hierarchy is baked into the system prompt at (re)bind and after compaction,
 * so a user editing AGENTS.md mid-session leaves the model following stale
 * rules; this provider injects the fresh content at the next step boundary
 * when it differs. Unlike skills, removals and content edits announce too —
 * a deleted rule fails silently, never on invocation. Baselines come from
 * typed reminder metadata or the persisted prompt disclosure, ordered by
 * render generation. The live content is read once and then only re-read when the
 * shared `pathWatch` subscription reports a candidate change — never
 * per step, so the step pipeline carries no filesystem IO (fake-timer retry
 * loops included); cwd changes re-arm the watch and force one re-read. Typed
 * reminder metadata and the persisted prompt disclosure provide the baseline.
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { AgentsMdStatus } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { fingerprintDisclosureContent } from '#/app/agentProfileCatalog/profile-shared';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  type IPathWatch,
  IPathWatchService,
} from '#/app/pathWatch/pathWatch';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { agentsMdCandidatePaths, loadAgentsMdSnapshot } from './context';
import { IAgentProfileService } from './profile';
import { IAgentAgentsMdReminderService } from './agentsMdReminder';

const AGENTS_MD_INJECTION_VARIANT = 'agents_md';

const CURRENT_BLOCK_START = '<current-agents-md>';
const CURRENT_BLOCK_END = '</current-agents-md>';

export class AgentAgentsMdReminderService extends Disposable implements IAgentAgentsMdReminderService {
  declare readonly _serviceBrand: undefined;

  private readonly watcher: IPathWatch;
  private watchCwd: string | undefined;
  private changeVersion = 0;
  private loadedVersion = -1;
  private current: AgentsMdCurrent | undefined;

  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPathWatchService pathWatch: IPathWatchService,
  ) {
    super();
    this.watcher = this._register(
      pathWatch.createWatch({ target: 'file' }, () => {
        this.changeVersion += 1;
      }),
    );
    this._register(
      dynamicInjector.register(AGENTS_MD_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private async reminder({
    lastInjectedAt,
  }: ContextInjectionContext): Promise<ContextInjectionResult | undefined> {
    try {
      let profileData = this.profile.data();
      if (profileData.environmentDisclosure?.cwd !== profileData.cwd) return undefined;
      const current = await this.currentContent();
      profileData = this.profile.data();
      if (profileData.environmentDisclosure?.cwd !== profileData.cwd) return undefined;
      const baseline = this.baseline(lastInjectedAt);
      if (
        baseline === undefined ||
        baseline.fingerprint === fingerprintDisclosureContent(current.content)
      ) {
        return undefined;
      }
      return {
        content: buildAgentsMdReminder(current.content),
        disclosure: {
          kind: 'agents_md',
          renderGeneration: profileData.renderGeneration ?? 0,
          fingerprint: fingerprintDisclosureContent(current.content),
          status: current.status,
        },
      };
    } catch {
      return undefined;
    }
  }

  private async currentContent(): Promise<AgentsMdCurrent> {
    const cwd = this.profile.data().cwd;
    if (cwd !== this.watchCwd) {
      this.watchCwd = cwd;
      this.changeVersion += 1;
      await this.armWatch(cwd);
    }
    if (this.loadedVersion === this.changeVersion && this.current !== undefined) {
      return this.current;
    }
    const loadingVersion = this.changeVersion;
    const content = await loadAgentsMdSnapshot(
      { fs: this.fs, homeDir: this.env.homeDir },
      cwd,
      this.bootstrap.homeDir,
    );
    this.current = content;
    this.loadedVersion = loadingVersion;
    return content;
  }

  private async armWatch(cwd: string): Promise<void> {
    try {
      const paths = await agentsMdCandidatePaths(
        { fs: this.fs, homeDir: this.env.homeDir },
        this.bootstrap.homeDir,
        cwd,
      );
      if (cwd !== this.watchCwd) return;
      await this.watcher.setPaths(paths);
    } catch {
    }
  }

  private baseline(lastInjectedAt: number | null): AgentsMdDisclosure | undefined {
    const history = this.contentFromHistory(lastInjectedAt);
    const persisted = this.contentFromProfile();
    if (
      history !== undefined &&
      (persisted === undefined || history.renderGeneration >= persisted.renderGeneration)
    ) {
      return history;
    }
    return persisted;
  }

  private contentFromHistory(lastInjectedAt: number | null): AgentsMdDisclosure | undefined {
    const history = this.context.get();
    const start =
      lastInjectedAt === null ? history.length - 1 : Math.min(lastInjectedAt, history.length - 1);
    for (let index = start; index >= 0; index--) {
      const message: ContextMessage | undefined = history[index];
      const disclosure =
        message?.origin?.kind === 'injection' &&
        message.origin.variant === AGENTS_MD_INJECTION_VARIANT
          ? message.origin.disclosure
          : undefined;
      if (disclosure?.kind === 'agents_md') return disclosure;
    }
    return undefined;
  }

  private contentFromProfile(): AgentsMdDisclosure | undefined {
    const profileData = this.profile.data();
    if (profileData.environmentDisclosure?.cwd !== profileData.cwd) return undefined;
    const agentsMd = profileData.environmentDisclosure.agentsMd;
    if (!agentsMd?.disclosed) return undefined;
    return {
      ...agentsMd.value,
      renderGeneration: profileData.renderGeneration ?? 0,
    };
  }
}

interface AgentsMdCurrent {
  readonly content: string;
  readonly status: AgentsMdStatus;
}

interface AgentsMdDisclosure {
  readonly fingerprint: string;
  readonly status: AgentsMdStatus;
  readonly renderGeneration: number;
}

function buildAgentsMdReminder(current: string): string {
  const body =
    current.length > 0
      ? 'The AGENTS.md instructions have changed since your system prompt was rendered. The content below is current and supersedes the AGENTS.md instructions in your system prompt.'
      : 'The AGENTS.md instructions that fed your system prompt have been removed (or are now empty); they no longer apply.';
  return `${body}\n\n${CURRENT_BLOCK_START}\n${current}\n${CURRENT_BLOCK_END}\n\nDO NOT mention this to the user explicitly.`;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAgentsMdReminderService,
  AgentAgentsMdReminderService,
  ScopeActivation.OnScopeCreated,
  'profile',
);
