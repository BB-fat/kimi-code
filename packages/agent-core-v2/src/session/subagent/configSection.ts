/**
 * `subagent` domain — subagent config-section schemas, env binding, and
 * timeout / model resolution.
 *
 * Owns two on-disk sections:
 *
 * - `[subagent]` — `timeout_ms`, together with the `KIMI_SUBAGENT_TIMEOUT_MS`
 *   env override (precedence: env > config.toml > 2h default). While the env
 *   var is set, `stripEnvBoundFields` restores the env-free raw value before
 *   persistence, so the override never leaks into `config.toml`. Per-run
 *   timeouts resolve through `resolveSubagentTimeoutMs`, and the timeout
 *   message renders with `formatSubagentTimeoutDescription`.
 *
 * - `[secondary_model]` — the subagent model pool: `default_model` names the
 *   fallback model and the `[secondary_model.models]` table maps alias →
 *   description. A `default_model` without a `[secondary_model.models]` table
 *   stands on its own as an implicit single-entry pool (empty description) —
 *   the minimal "secondary model" configuration. As a compatibility fallback
 *   for the v1 engine's recipe, a lone legacy `model` key (likewise without a
 *   pool table) forms the same implicit single-entry pool, ranked below
 *   `default_model`; the recipe's patch fields (`default_effort`, ...) have
 *   no pool counterpart and are ignored by pool resolution — but the schema
 *   still declares them so validation never strips them and config
 *   reads/writes round-trip losslessly for the v1 engine, and `model` never
 *   substitutes for
 *   the pool table's required `default_model`. `force = true` instead
 *   removes the choice entirely: every spawn binds the resolved default
 *   (`default_model` ?? `model`), the tools hide the `model` parameter
 *   exactly like the no-pool case, and combining
 *   it with a `[secondary_model.models]` table is rejected — the table's only
 *   purpose is offering the main agent a choice.
 *
 * When a pool is configured (and not forced), newly spawned subagents
 * bind to the pool's default model unless the parent picks a model. The
 * `Agent` / `AgentSwarm` `model` parameter accepts any configured `[models]`
 * alias, plus the shortcuts `primary` (`PRIMARY_SUBAGENT_MODEL_CHOICE`, the
 * caller's own model and thinking level) and `secondary` (the pool default).
 * The pool does not restrict the selectable set — it only supplies the
 * omitted-request default and the advertised descriptions. Pool bindings
 * carry no explicit thinking level, so the subagent resolves thinking
 * naturally (global thinking config → the bound model's default effort)
 * rather than inheriting the caller's level. Without a pool, an omitted
 * `model` inherits the caller's model, but an explicit alias still binds.
 * The tools keep advertising the `model` parameter in that case (free-form
 * aliases remain useful); `stripSubagentModelParameter` is reserved for
 * `force = true`, which hides the parameter and binds every spawn to the
 * resolved default. The pool itself is gated behind the `secondary-model`
 * experimental flag (`flag.ts`): while the experiment is off the section is
 * inert — no default override, no startup validation — but free-form aliases
 * and the `primary` shortcut still work.
 *
 * Spawn bindings resolve through `resolveSubagentBinding`: a forced
 * configuration short-circuits to the resolved default before anything else, and
 * any explicit request — `primary` included — throws (defensive; the tools
 * strip the parameter); `primary` short-circuits to the caller's own
 * model+thinking; `secondary` binds the pool default when one exists and
 * otherwise inherits; any other requested string binds that alias directly
 * (the catalog, not the pool, decides whether it is configured); an omitted
 * request falls back to the pool default when the experiment is on, else
 * inherits. The tools advertise aliases via `buildSubagentModelDescriptions`:
 * `primary` / `secondary` lead, then every configured `[models]` id (when the
 * caller supplies them) plus any pool-only entries, with `[default]` /
 * `[main model]` markers and optional capability suffixes. An empty-string
 * description renders a bare `- alias` line. Spawn failures are wrapped by
 * `wrapSubagentModelError`: when the bound model is not the caller's own and
 * the catalog failed on exactly that alias, the parent model gets guidance
 * toward `[secondary_model.models]` / `[models]` instead of a bare resolution
 * error.
 * Cross-field validation is NOT part of the schema — it is enforced as
 * `Error2(CONFIG_INVALID)` by `assertValidSubagentModelConfig` (run before
 * session materialization by the session lifecycle, with the Session-scope
 * validation service in `subagentModelsValidationService.ts` as backstop),
 * which checks the `force` rules (a default — `default_model` or the legacy
 * `model` fallback — required, a
 * `[secondary_model.models]` table rejected) and delegates the pool checks to
 * `assertValidSubagentModelPool`: the default must be present and name a
 * pool key, every pool key must resolve through the model catalog, and the
 * reserved `primary` alias is rejected outright — as a pool key it would be
 * unreachable (explicit requests short-circuit to the caller's model) and
 * would render a self-contradictory description. `resolveSubagentBinding`
 * repeats the reserved-key and force-rule checks so a pool broken by a
 * runtime config edit fails loudly at spawn instead of binding the wrong
 * model; any other malformation the startup checks missed surfaces as the
 * spawn-time errors above. Writes that rewrite the `[models]` table
 * (provider removal/replace at the edge, background catalog refreshes)
 * fold the pool through `cascadeSubagentModelPool` into the same atomic
 * write — renamed aliases are repointed, dropped aliases filtered, and the
 * whole section cleared when its effective default dangles (an emptied pool
 * table folds into the implicit single-entry form — a default naming no
 * pool key would fail validation) — so the startup
 * validation never meets a pool orphaned by a write it did not see.
 * Self-registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { isPlainObject } from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';
export const SECONDARY_MODEL_SECTION = 'secondaryModel';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const SecondaryModelConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  models: z.record(z.string(), z.string()).optional(),
  force: z.boolean().optional(),
  model: z.string().min(1).optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

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

registerConfigSection(SECONDARY_MODEL_SECTION, SecondaryModelConfigSchema);

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';
export const SECONDARY_SUBAGENT_MODEL_CHOICE = 'secondary';

export interface SubagentModelBinding {
  readonly model: string;
  readonly thinking?: string;
}

export interface SubagentModelPool {
  readonly defaultModel?: string;
  readonly models: Record<string, string>;
}

export function resolveSubagentModelPool(config: IConfigService): SubagentModelPool | undefined {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.models !== undefined) {
    return { defaultModel: section.defaultModel, models: section.models };
  }
  if (section?.defaultModel !== undefined) {
    return { defaultModel: section.defaultModel, models: { [section.defaultModel]: '' } };
  }
  if (section?.model !== undefined) {
    return { defaultModel: section.model, models: { [section.model]: '' } };
  }
  return undefined;
}

export const SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model].force is set';

export const SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE =
  '[secondary_model].force cannot be combined with [secondary_model.models]: the pool table only exists to offer the main agent a choice, and force removes that choice';

export function isSubagentModelForced(config: IConfigService): boolean {
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION)?.force === true;
}

export function exposesSubagentModelChoice(config: IConfigService, flags: IFlagService): boolean {
  return !(flags.enabled(SECONDARY_MODEL_FLAG_ID) && isSubagentModelForced(config));
}

export const SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model.models] is configured';

export const SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE = `[secondary_model.models] key "${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved: it always binds the caller's own model. Rename the pool entry.`;

export const SECONDARY_MODEL_SECONDARY_MODEL_RESERVED_MESSAGE = `[secondary_model.models] key "${SECONDARY_SUBAGENT_MODEL_CHOICE}" is reserved: it always binds the pool default. Rename the pool entry.`;

export function assertValidSubagentModelPool(
  pool: SubagentModelPool,
  modelCatalog: IModelCatalog,
): void {
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  if (Object.hasOwn(pool.models, SECONDARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_SECONDARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: SECONDARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  const aliases = Object.keys(pool.models);
  if (pool.defaultModel === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, pool.defaultModel)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `[secondary_model].default_model "${pool.defaultModel}" is not a [secondary_model.models] key. Available models: ${aliases.join(', ')}.`,
      { details: { model: pool.defaultModel, availableModels: aliases } },
    );
  }
  for (const alias of aliases) {
    try {
      modelCatalog.get(alias);
    } catch (error) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[secondary_model.models] entry "${alias}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { model: alias } },
      );
    }
  }
}

export function assertValidSubagentModelConfig(
  config: IConfigService,
  flags: IFlagService,
  modelCatalog: IModelCatalog,
): void {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return;
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.force === true) {
    if (section.models !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'force' },
      });
    }
    if (section.defaultModel === undefined && section.model === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
      });
    }
  }
  const pool = resolveSubagentModelPool(config);
  if (pool !== undefined) assertValidSubagentModelPool(pool, modelCatalog);
}

export function cascadeSubagentModelPool(
  section: SecondaryModelConfig | undefined,
  survivingModels: Record<string, unknown>,
  renamedAliases: ReadonlyMap<string, string> = new Map(),
): SecondaryModelConfig | null | undefined {
  if (section === undefined) return undefined;
  const remap = (alias: string): string => renamedAliases.get(alias) ?? alias;
  const nextDefault = section.defaultModel === undefined ? undefined : remap(section.defaultModel);
  const nextLegacyDefault = section.model === undefined ? undefined : remap(section.model);
  const effectiveDefault = nextDefault ?? nextLegacyDefault;
  if (effectiveDefault !== undefined && !(effectiveDefault in survivingModels)) return null;

  let changed = nextDefault !== section.defaultModel || nextLegacyDefault !== section.model;
  let nextPool: Record<string, string> | undefined;
  if (section.models !== undefined) {
    nextPool = {};
    for (const [alias, description] of Object.entries(section.models)) {
      const key = remap(alias);
      if (!(key in survivingModels)) {
        changed = true;
        continue;
      }
      if (key !== alias) changed = true;
      nextPool[key] = description;
    }
    if (Object.keys(nextPool).length === 0) {
      nextPool = undefined;
      changed = true;
    }
  }
  if (!changed) return undefined;
  return { ...section, defaultModel: nextDefault, model: nextLegacyDefault, models: nextPool };
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: string,
): SubagentModelBinding {
  const enabled = flags.enabled(SECONDARY_MODEL_FLAG_ID);
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (enabled && section?.force === true) {
    if (section.models !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_EXCLUDES_MODELS_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'force' },
      });
    }
    const forcedModel = section.defaultModel ?? section.model;
    if (forcedModel === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_FORCE_REQUIRES_DEFAULT_MESSAGE, {
        details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
      });
    }
    if (requested !== undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid model "${requested}": [secondary_model].force is set, so every subagent binds "${forcedModel}" (omit the model parameter).`,
        { details: { model: requested } },
      );
    }
    return { model: forcedModel };
  }
  if (requested === PRIMARY_SUBAGENT_MODEL_CHOICE) {
    return { model: own.modelAlias, thinking: own.thinkingLevel };
  }
  const pool = enabled ? resolveSubagentModelPool(config) : undefined;
  if (pool !== undefined && Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  if (pool !== undefined && Object.hasOwn(pool.models, SECONDARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_SECONDARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: SECONDARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  if (requested === SECONDARY_SUBAGENT_MODEL_CHOICE) {
    if (pool?.defaultModel !== undefined) return { model: pool.defaultModel };
    return { model: own.modelAlias, thinking: own.thinkingLevel };
  }
  if (requested !== undefined) {
    return { model: requested };
  }
  if (pool !== undefined && pool.defaultModel === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (pool?.defaultModel !== undefined) {
    return { model: pool.defaultModel };
  }
  return { model: own.modelAlias, thinking: own.thinkingLevel };
}

export interface BuildSubagentModelDescriptionsExtras {
  readonly availableModelIds?: readonly string[];
  readonly modelLabels?: Readonly<Record<string, string | undefined>>;
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

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
  extras: BuildSubagentModelDescriptionsExtras = {},
): string | undefined {
  if (!exposesSubagentModelChoice(config, flags)) return undefined;
  const pool = flags.enabled(SECONDARY_MODEL_FLAG_ID) ? resolveSubagentModelPool(config) : undefined;
  const catalogIds = extras.availableModelIds ?? [];
  const modelLabels = extras.modelLabels ?? {};
  if (catalogIds.length === 0 && pool === undefined && callerModelAlias === undefined) {
    return undefined;
  }

  const lines = ['Available models (pass via model):'];
  const defaultModel = pool?.defaultModel;
  const listed = new Set<string>();

  if (callerModelAlias !== undefined) {
    lines.push(
      `- ${PRIMARY_SUBAGENT_MODEL_CHOICE}: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks${capabilitiesSuffix(extras.modelCatalog, callerModelAlias)}`,
    );
  }
  if (defaultModel !== undefined) {
    const poolDesc = pool?.models[defaultModel] ?? '';
    const desc = poolDesc === '' ? '' : `: ${poolDesc}`;
    lines.push(
      `- ${SECONDARY_SUBAGENT_MODEL_CHOICE}: ${defaultModel} (default) — the configured secondary / pool default model; prefer it for routine subagent tasks${desc}${capabilitiesSuffix(extras.modelCatalog, defaultModel)}`,
    );
  }

  const markersFor = (alias: string): string => {
    const markers: string[] = [];
    if (alias === defaultModel) markers.push('[default]');
    if (alias === callerModelAlias) markers.push('[main model]');
    return markers.length === 0 ? '' : ` ${markers.join(' ')}`;
  };

  for (const id of catalogIds) {
    listed.add(id);
    const label = modelLabels[id];
    const poolDesc = pool?.models[id];
    const description =
      poolDesc !== undefined
        ? poolDesc
        : label !== undefined && label.length > 0 && label !== id
          ? label
          : '';
    lines.push(
      `${formatPoolLine(`${id}${markersFor(id)}`, description)}${capabilitiesSuffix(extras.modelCatalog, id)}`,
    );
  }

  if (pool !== undefined) {
    if (defaultModel !== undefined && Object.hasOwn(pool.models, defaultModel) && !listed.has(defaultModel)) {
      listed.add(defaultModel);
      lines.push(
        `${formatPoolLine(`${defaultModel}${markersFor(defaultModel)}`, pool.models[defaultModel]!)}${capabilitiesSuffix(extras.modelCatalog, defaultModel)}`,
      );
    }
    for (const [alias, description] of Object.entries(pool.models)) {
      if (listed.has(alias)) continue;
      listed.add(alias);
      lines.push(
        `${formatPoolLine(`${alias}${markersFor(alias)}`, description)}${capabilitiesSuffix(extras.modelCatalog, alias)}`,
      );
    }
  }

  lines.push(
    'Pass a model alias copied exactly from the list above (the id before ":" / "—", e.g. provider/gpt-5.6-sol — not a shortened form like provider/gpt-5.6), or the shortcuts "primary" / "secondary". This explicit choice overrides the selected agent type\'s model_preference; without either, secondary is the default when a pool is configured, otherwise the subagent inherits your model. Ignored when resuming — resumed subagents keep their own model.',
  );
  return lines.join('\n');
}

function formatPoolLine(label: string, description: string): string {
  return description === '' ? `- ${label}` : `- ${label}: ${description}`;
}

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
  callerModelAlias: string | undefined,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;
  return new Error2(
    error.code,
    `${error.message} (subagent model "${boundModel}" comes from [secondary_model.models] or a tool model argument — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        subagentModel: boundModel,
        subagentModelConfig: {
          section: 'secondary_model.models',
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
