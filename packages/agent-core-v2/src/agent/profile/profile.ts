import type { AgentProfile, AgentProfileContext } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import type { Model } from '#/app/model/modelInstance';

import { createDecorator } from "#/_base/di/instantiation";
import type { ErrorCode } from '#/errors';
import { Error2 } from '#/_base/errors/errors';
import type { ToolSource } from '#/tool/toolContract';
import type { Hooks } from '#/hooks';

import { ProfileErrors } from './errors';

export { ProfileErrors } from './errors';

export type ProfileErrorCode = (typeof ProfileErrors.codes)[keyof typeof ProfileErrors.codes];

export class ProfileError extends Error2 {
  constructor(code: ProfileErrorCode, message: string, details?: Record<string, unknown>) {
    super(code as ErrorCode, message, { details });
    this.name = 'ProfileError';
  }
}

export interface AgentConfigData {
  cwd: string;
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  thinkingLevel: string;
  systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

export interface SystemPromptContext extends AgentProfileContext {
  readonly agentsMdWarning?: string;
}

export type ResolvedAgentProfile = AgentProfile;

export interface ProfileData extends AgentConfigData {
  readonly activeToolNames?: readonly string[];
}

export type ProfileUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
  activeToolNames: readonly string[];
}>;

export interface ProfileServiceOptions {
  readonly cwd?: string | (() => string | undefined);
  readonly chdir?: (cwd: string) => void | Promise<void>;
  readonly emitStatusUpdated?: () => void;
}

export interface ApplyProfileOptions {
  readonly additionalDirs?: readonly string[];
}

export interface ProfileModelContext {
  readonly modelAlias: string;
  readonly modelCapabilities: ModelCapability;
  readonly maxOutputSize: number | undefined;
  readonly alwaysThinking: boolean | undefined;
  readonly thinkingLevel: ThinkingEffort;
  readonly reservedContextSize: number | undefined;
  readonly compactionTriggerRatio: number | undefined;
}

export interface ProfileSetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface BindAgentInput {
  readonly profile: string;
  readonly model: string;
  readonly thinking?: string;
  readonly cwd?: string;
}

export interface WillSetModelContext {
  readonly currentAlias: string | undefined;
  readonly nextAlias: string;
  readonly nextMaxContextTokens: number | undefined;
}

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<{
    /**
     * Runs inside `setModel` after the target model resolved but before the
     * alias (and thus the provider used for new requests) switches. Handlers
     * that need the CURRENT model still active — e.g. pre-compacting an
     * oversized context with the larger-window model — must finish before
     * calling `next`.
     */
    onWillSetModel: WillSetModelContext;
  }>;

  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  bind(input: BindAgentInput): Promise<void>;
  setModel(model: string): Promise<ProfileSetModelResult>;
  setThinking(level: string): void;
  getModel(): string;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void>;
  refreshSystemPrompt(): Promise<void>;
  getAgentsMdWarning(): string | undefined;
  data(): ProfileData;
  getEffectiveThinkingLevel(): ThinkingEffort;
  resolveModelContext(): ProfileModelContext;
  getProvider(): Model;
  resolveModel(): Model | undefined;
  readonly provider: Model;
  getModelCapabilities(): ModelCapability;
  /**
   * `max_context_tokens` of the active model, clamped by the context ceiling
   * learned from provider overflow rejections (see
   * {@link observeMaxContextTokens}). The configured capability wins until an
   * overflow proves the real window smaller; consumers that size budgets or
   * triggers against the window must read this, not the raw capability.
   */
  getEffectiveMaxContextTokens(): number;
  /**
   * Record a context-window ceiling learned from a provider overflow rejection
   * for the active model alias. Ignored when the value is not below the
   * current effective max, so a stale or misattributed observation can never
   * loosen the clamp.
   */
  observeMaxContextTokens(observed: number): void;
  getMaxOutputSize(): number | undefined;
  hasModel(): boolean;
  isRunnable(): boolean;
  hasProvider(): boolean;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  isToolActive(name: string, source?: ToolSource): boolean;
  addActiveTool(name: string): void;
  removeActiveTool(name: string): void;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
