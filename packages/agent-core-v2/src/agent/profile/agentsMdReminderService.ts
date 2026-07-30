/**
 * `profile` domain (L4) — `IAgentAgentsMdReminderService` implementation.
 *
 * Owns the `agents_md` context-injection provider. The AGENTS.md instruction
 * hierarchy is baked into the system prompt at (re)bind and after compaction,
 * so a user editing AGENTS.md mid-session leaves the model following stale
 * rules; this provider injects the fresh content at the next step boundary
 * when it differs. Unlike skills, removals and content edits announce too —
 * a deleted rule fails silently, never on invocation. The provider runs only
 * while the profile's rendered snapshot exists and matches the live cwd. The
 * baseline prefers the typed disclosure on the newest surviving `agents_md`
 * injection, then the persisted rendered snapshot, then a runtime seed kept
 * in `agentState`: a profile whose snapshot declares no AGENTS.md disclosure
 * is seeded with the first observed fingerprint (quietly), so a later
 * creation, edit, or removal still announces. The live content is read once
 * and then only re-read when the shared `pathWatch` subscription reports a
 * candidate change — never per step, so the step pipeline carries no
 * filesystem IO (fake-timer retry loops included); cwd changes re-arm the
 * watch and force one re-read. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import {
  disclosureOfKind,
  pickDisclosureBaseline,
} from '#/agent/contextInjector/disclosureBaseline';
import { IAgentStateService } from '#/agent/state/agentState';
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

export const agentsMdReminderSeedKey = defineState<AgentsMdSeed | undefined>(
  'agentsMdReminder.seed',
  () => undefined,
);

export class AgentAgentsMdReminderService extends Disposable implements IAgentAgentsMdReminderService {
  declare readonly _serviceBrand: undefined;

  private readonly watcher: IPathWatch;
  private watchCwd: string | undefined;
  private changeVersion = 0;
  private loadedVersion = -1;
  private current: AgentsMdCurrent | undefined;

  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPathWatchService pathWatch: IPathWatchService,
  ) {
    super();
    this.states.register(agentsMdReminderSeedKey);
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
    lastDisclosure,
  }: ContextInjectionContext): Promise<ContextInjectionResult | undefined> {
    try {
      let profileData = this.profile.data();
      if (profileData.environmentDisclosure?.cwd !== profileData.cwd) return undefined;
      const current = await this.currentContent();
      profileData = this.profile.data();
      if (profileData.environmentDisclosure?.cwd !== profileData.cwd) return undefined;
      const renderGeneration = profileData.renderGeneration ?? 0;
      const fingerprint = fingerprintDisclosureContent(current.content);
      const baseline = pickDisclosureBaseline<AgentsMdDisclosure>(
        disclosureOfKind(lastDisclosure, 'agents_md'),
        this.contentFromProfile(),
        this.seed(),
      );
      if (baseline === undefined) {
        this.states.set(agentsMdReminderSeedKey, {
          fingerprint,
          status: current.status,
          renderGeneration,
          cwd: profileData.cwd,
        });
        return undefined;
      }
      if (baseline.fingerprint === fingerprint) {
        return undefined;
      }
      return {
        content: buildAgentsMdReminder(current.content),
        disclosure: {
          kind: 'agents_md',
          renderGeneration,
          fingerprint,
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
        cwd,
        this.bootstrap.homeDir,
      );
      if (cwd !== this.watchCwd) return;
      await this.watcher.setPaths(paths);
    } catch {
    }
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

  private seed(): AgentsMdDisclosure | undefined {
    const seed = this.states.get(agentsMdReminderSeedKey);
    if (seed === undefined || seed.cwd !== this.profile.data().cwd) return undefined;
    return seed;
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

interface AgentsMdSeed extends AgentsMdDisclosure {
  readonly cwd: string;
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
