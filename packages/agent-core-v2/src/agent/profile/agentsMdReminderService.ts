/**
 * `profile` domain (L4) — `IAgentAgentsMdReminderService` implementation.
 *
 * Owns the `agents_md` context-injection provider. The AGENTS.md instruction
 * hierarchy is baked into the system prompt at (re)bind and after compaction,
 * so a user editing AGENTS.md mid-session leaves the model following stale
 * rules; this provider injects the fresh content at the next step boundary
 * when it differs. Unlike skills, removals and content edits announce too —
 * a deleted rule fails silently, never on invocation. The baseline is
 * history-derived: the last `agents_md` reminder in context, else the fenced
 * AGENTS.md block of the current system prompt, else the volatile
 * `seededContent` adopted at first evaluation (custom profiles without the
 * fenced block). The live content is read once and then only re-read when the
 * shared `fileSourceMonitor` subscription reports a candidate change — never
 * per step, so the step pipeline carries no filesystem IO (fake-timer retry
 * loops included); cwd changes re-arm the watch and force one re-read. The
 * plain-data state (`seededContent`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';

import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentStateService } from '#/agent/state/agentState';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IFileSourceMonitor,
  type IFileSourceWatch,
} from '#/app/fileSourceMonitor/fileSourceMonitor';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { agentsMdCandidatePaths, loadAgentsMd } from './context';
import { IAgentProfileService } from './profile';
import { IAgentAgentsMdReminderService } from './agentsMdReminder';

const AGENTS_MD_INJECTION_VARIANT = 'agents_md';

const SYSTEM_PROMPT_AGENTS_MD_HEADING = 'The applicable `AGENTS.md` instructions are:';
const SYSTEM_PROMPT_FENCE = '```````';
const CURRENT_BLOCK_START = '<current-agents-md>';
const CURRENT_BLOCK_END = '</current-agents-md>';

export const agentsMdReminderSeededContentKey = defineState<string | undefined>(
  'agentsMdReminder.seededContent',
  () => undefined,
);

export class AgentAgentsMdReminderService extends Disposable implements IAgentAgentsMdReminderService {
  declare readonly _serviceBrand: undefined;

  private readonly watcher: IFileSourceWatch;
  private watchCwd: string | undefined;
  private changeVersion = 0;
  private loadedVersion = -1;
  private current: string | undefined;

  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFileSourceMonitor fileSourceMonitor: IFileSourceMonitor,
  ) {
    super();
    this.states.register(agentsMdReminderSeededContentKey);
    this.watcher = this._register(
      fileSourceMonitor.createWatch({ target: 'file' }, () => {
        this.changeVersion += 1;
      }),
    );
    this._register(
      dynamicInjector.register(AGENTS_MD_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private get seededContent(): string | undefined {
    return this.states.get(agentsMdReminderSeededContentKey);
  }

  private set seededContent(value: string | undefined) {
    this.states.set(agentsMdReminderSeededContentKey, value);
  }

  private async reminder({ lastInjectedAt }: ContextInjectionContext): Promise<string | undefined> {
    try {
      const current = await this.currentContent();
      const baseline = this.baseline(lastInjectedAt) ?? this.adopt(current);
      if (baseline === current) return undefined;
      return buildAgentsMdReminder(current);
    } catch {
      return undefined;
    }
  }

  private async currentContent(): Promise<string> {
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
    const content = await loadAgentsMd(
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

  private baseline(lastInjectedAt: number | null): string | undefined {
    return this.contentFromHistory(lastInjectedAt) ?? this.contentFromSystemPrompt() ?? this.seededContent;
  }

  private adopt(current: string): string {
    this.seededContent = current;
    return current;
  }

  private contentFromHistory(lastInjectedAt: number | null): string | undefined {
    if (lastInjectedAt === null) return undefined;
    const message: ContextMessage | undefined = this.context.get()[lastInjectedAt];
    if (message === undefined) return undefined;
    return extractCurrentBlock(messageText(message));
  }

  private contentFromSystemPrompt(): string | undefined {
    const prompt = this.profile.getSystemPrompt();
    const headingIndex = prompt.indexOf(SYSTEM_PROMPT_AGENTS_MD_HEADING);
    if (headingIndex < 0) return undefined;
    const openFence = prompt.indexOf(SYSTEM_PROMPT_FENCE, headingIndex);
    if (openFence < 0) return undefined;
    const contentStart = openFence + SYSTEM_PROMPT_FENCE.length;
    const closeFence = prompt.indexOf(SYSTEM_PROMPT_FENCE, contentStart);
    if (closeFence < 0) return undefined;
    return prompt.slice(contentStart, closeFence).trim();
  }
}

function buildAgentsMdReminder(current: string): string {
  const body =
    current.length > 0
      ? 'The AGENTS.md instructions have changed since your system prompt was rendered. The content below is current and supersedes the AGENTS.md instructions in your system prompt.'
      : 'The AGENTS.md instructions that fed your system prompt have been removed (or are now empty); they no longer apply.';
  return `${body}\n\n${CURRENT_BLOCK_START}\n${current}\n${CURRENT_BLOCK_END}\n\nDO NOT mention this to the user explicitly.`;
}

function extractCurrentBlock(text: string): string | undefined {
  const start = text.indexOf(CURRENT_BLOCK_START);
  if (start < 0) return undefined;
  const contentStart = start + CURRENT_BLOCK_START.length;
  const end = text.indexOf(CURRENT_BLOCK_END, contentStart);
  if (end < 0) return undefined;
  return text.slice(contentStart, end).trim();
}

function messageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentAgentsMdReminderService,
  AgentAgentsMdReminderService,
  ScopeActivation.OnScopeCreated,
  'profile',
);
