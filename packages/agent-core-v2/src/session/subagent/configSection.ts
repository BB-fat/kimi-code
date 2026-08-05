/**
 * `subagent` domain — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms` on disk) together
 * with the `KIMI_SUBAGENT_TIMEOUT_MS` env override (precedence: env >
 * config.toml > 2h default). While
 * the env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Per-run
 * timeouts resolve through `resolveSubagentTimeoutMs`, and the timeout
 * message renders with `formatSubagentTimeoutDescription`.
 *
 * The model half of the spawn binding lets the parent pick any configured
 * model alias via the `Agent`/`AgentSwarm` `model` parameter (or the
 * shortcuts `"primary"` / `"secondary"`). When the secondary-model experiment
 * is enabled and `[secondary_model]` is set, newly spawned subagents bind to
 * it by default instead of inheriting the caller's model. A recipe with patch
 * fields binds the synthesized derived entry (`SECONDARY_DERIVED_MODEL_ID`);
 * a pointer-only recipe binds the pointed entry directly. `default_effort` is
 * passed as the explicit subagent thinking; without it the subagent resolves
 * thinking naturally (global thinking config → the bound model's default
 * effort) rather than inheriting the caller's level. Free-form aliases leave
 * thinking unset for the same reason. Both tools resolve spawn bindings
 * through `resolveSubagentBinding`, advertise available models via
 * `buildSubagentModelDescriptions` (each line suffixed with the entry's
 * resolved capability flags when an `IModelCatalog` is provided, so the parent
 * can route multimodal or thinking-heavy subagent tasks instead of guessing
 * from the model id), and wrap secondary-model spawn failures with
 * `wrapSubagentModelError`; while the experiment is off they also strip the
 * no-op `model` parameter from their advertised schemas via
 * `stripSubagentModelParameter` when callers opt into that path.
 * Self-registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { IFlagService } from '#/app/flag/flag';
import {
  SECONDARY_MODEL_ENV,
  SECONDARY_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelPatch,
} from '#/app/kosongConfig/secondaryModelOverlay';
import { type SecondaryModelConfig } from '#/app/kosongConfig/configSection';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject } from '#/app/config/toml';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS },
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
});

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

/**
 * Per-spawn model choice from the tool argument or a profile preference.
 * Free-form strings are treated as configured model aliases; the shortcuts
 * `"primary"` / `"secondary"` keep their symbolic meaning.
 */
export type SubagentModelChoice = string;

export type SubagentBindingSource = 'primary' | 'secondary' | 'explicit' | 'inherit';

export interface SubagentModelBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly source: SubagentBindingSource;
}

export function resolveSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
): SecondaryModelConfig | undefined {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return undefined;
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: SubagentModelChoice,
): SubagentModelBinding {
  if (requested === 'primary') {
    return { model: own.modelAlias, thinking: own.thinkingLevel, source: 'primary' };
  }

  // Free-form alias (anything other than the secondary shortcut / omit).
  if (requested !== undefined && requested !== 'secondary') {
    return { model: requested, thinking: undefined, source: 'explicit' };
  }

  // requested is undefined | 'secondary' — secondary default when available.
  const secondary = resolveSecondaryModel(config, flags);
  if (secondary?.model !== undefined) {
    return {
      model:
        secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ID,
      thinking: secondary.defaultEffort,
      source: 'secondary',
    };
  }

  return { model: own.modelAlias, thinking: own.thinkingLevel, source: 'inherit' };
}

export interface BuildSubagentModelDescriptionsOptions {
  readonly config: IConfigService;
  readonly flags: IFlagService;
  readonly callerModelAlias: string | undefined;
  /**
   * Configured model ids from `[models]`. Reserved runtime ids (e.g. the
   * secondary derived entry) are filtered out. When empty/omitted and no
   * secondary shortcut is available, the description block is omitted.
   */
  readonly availableModelIds?: readonly string[];
  /**
   * Optional display labels keyed by model id (displayName / wire name).
   * Falls back to the id when missing.
   */
  readonly modelLabels?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional catalog used to append capability suffixes (`image_in`,
   * `thinking`, …) so the parent can route multimodal or thinking-heavy
   * subagent tasks. When omitted, lines are emitted without suffixes.
   */
  readonly modelCatalog?: IModelCatalog;
}

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const satisfies readonly (keyof ModelCapability)[];

function capabilitiesSuffix(
  modelCatalog: IModelCatalog | undefined,
  model: string | undefined,
): string {
  if (modelCatalog === undefined || model === undefined) return '';
  let capability: ModelCapability | undefined;
  try {
    capability = modelCatalog.get(model).capabilities;
  } catch {
    return '';
  }
  if (capability === undefined) return '';
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capability[flag] === true);
  return `; capabilities: ${names.length === 0 ? 'none' : names.join(', ')}`;
}

/**
 * The "Available models" block appended to the `Agent` / `AgentSwarm` tool
 * descriptions so the parent model knows it can pick. `undefined` when there
 * is nothing useful to list (no configured models and no secondary shortcut).
 */
export function buildSubagentModelDescriptions(
  options: BuildSubagentModelDescriptionsOptions,
): string | undefined {
  const {
    config,
    flags,
    callerModelAlias,
    availableModelIds = [],
    modelLabels = {},
    modelCatalog,
  } = options;
  const secondary = resolveSecondaryModel(config, flags);
  const secondaryModel = secondary?.model;
  const boundSecondary =
    secondaryModel === undefined
      ? undefined
      : secondaryModelPatch(secondary) === undefined
        ? secondaryModel
        : SECONDARY_DERIVED_MODEL_ID;
  const catalogIds = availableModelIds.filter((id) => id !== SECONDARY_DERIVED_MODEL_ID);

  if (catalogIds.length === 0 && secondaryModel === undefined) return undefined;

  const lines = ['Available models (pass via model):'];
  if (callerModelAlias !== undefined) {
    lines.push(
      `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks${capabilitiesSuffix(modelCatalog, callerModelAlias)}`,
    );
  }
  if (secondaryModel !== undefined) {
    lines.push(
      `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks${capabilitiesSuffix(modelCatalog, boundSecondary)}`,
    );
  }
  for (const id of catalogIds) {
    const label = modelLabels[id];
    const base =
      label !== undefined && label.length > 0 && label !== id ? `- ${id}: ${label}` : `- ${id}`;
    lines.push(`${base}${capabilitiesSuffix(modelCatalog, id)}`);
  }
  lines.push(
    'Pass a configured model alias from the list above, or the shortcuts "primary" / "secondary". This explicit choice overrides the selected agent type\'s model_preference; without either, secondary is the default when configured, otherwise the subagent inherits your model. Ignored when resuming — resumed subagents keep their own model.',
  );
  return lines.join('\n');
}

/**
 * Strip the `model` property from a subagent collaboration tool's advertised
 * JSON schema. While the `secondary-model` experiment is off the parameter is
 * a silent no-op on the official primary/secondary path, so callers that only
 * expose that pair can drop it from the schema. Free-form alias routing keeps
 * the parameter advertised regardless. Returns the input unchanged when there
 * is no `model` property; otherwise a shallow copy — the input is never
 * mutated.
 */
export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('model' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  source: SubagentBindingSource,
): unknown {
  // Only rewrite secondary-model resolution failures so free-alias errors keep
  // their plain "model not configured" message.
  if (source !== 'secondary') {
    return error;
  }
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;
  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ID
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ID}"`
      : `"${boundModel}"`;
  return new Error2(
    error.code,
    `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        secondaryModel: boundModel,
        secondaryModelConfig: {
          section: 'secondaryModel.model',
          environment: SECONDARY_MODEL_ENV,
        },
      },
    },
  );
}

export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}
