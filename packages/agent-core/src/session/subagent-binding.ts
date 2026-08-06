import {
  SECONDARY_DERIVED_MODEL_ALIAS,
  SECONDARY_MODEL_ENV,
  secondaryModelPatch,
  type KimiConfig,
  type SecondaryModelConfig,
} from '../config';
import { ErrorCodes, KimiError } from '../errors';
import type { ExperimentalFlagResolver } from '../flags';

/**
 * Subagent model binding — per-spawn model selection for newly created
 * subagents.
 *
 * The parent model (through the `Agent` / `AgentSwarm` tool `model` parameter)
 * or the spawned profile (via `model_preference`) can request any configured
 * model alias, or the shortcuts `"primary"` / `"secondary"`. When the
 * `secondary-model` experiment is enabled and `[secondary_model]` is
 * configured, newly spawned subagents bind to it by default instead of
 * inheriting the caller's model. A recipe with patch fields binds the
 * synthesized derived entry ({@link SECONDARY_DERIVED_MODEL_ALIAS},
 * materialized by `applySecondaryModelConfig`); a pointer-only recipe binds
 * the pointed entry directly. `default_effort` is passed as the explicit
 * subagent thinking effort; free-form aliases and recipes without
 * `default_effort` leave thinking unset so the child resolves it naturally
 * (global thinking config → the bound model's default effort). When secondary
 * is unset, spawning behavior is unchanged: subagents inherit the caller's
 * model and effort.
 */

/**
 * Per-spawn model choice from the tool argument or a profile preference.
 * Free-form strings are treated as configured model aliases; the shortcuts
 * `"primary"` / `"secondary"` keep their symbolic meaning.
 */
export type SubagentModelChoice = string;

export type SubagentBindingSource = 'primary' | 'secondary' | 'explicit' | 'inherit';

export interface SubagentModelBinding {
  readonly modelAlias: string | undefined;
  readonly thinkingEffort?: string;
  readonly source: SubagentBindingSource;
}

export function resolveSecondaryModel(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
): SecondaryModelConfig | undefined {
  if (!flags.enabled('secondary-model')) return undefined;
  return config?.secondaryModel;
}

/**
 * Resolve which model a newly spawned subagent binds to. `requested` is the
 * explicit per-spawn choice (tool argument or profile preference); `own` is
 * the caller's current model state, used when inheriting.
 */
export function resolveSubagentBinding(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
  own: { readonly modelAlias: string | undefined; readonly thinkingEffort: string },
  requested?: SubagentModelChoice,
): SubagentModelBinding {
  if (requested === 'primary') {
    return {
      modelAlias: own.modelAlias,
      thinkingEffort: own.thinkingEffort,
      source: 'primary',
    };
  }

  // Free-form alias (anything other than the secondary shortcut / omit).
  if (requested !== undefined && requested !== 'secondary') {
    return { modelAlias: requested, thinkingEffort: undefined, source: 'explicit' };
  }

  // requested is undefined | 'secondary' — secondary default when available.
  const secondary = resolveSecondaryModel(config, flags);
  if (secondary?.model !== undefined) {
    return {
      modelAlias:
        secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ALIAS,
      thinkingEffort: secondary.defaultEffort,
      source: 'secondary',
    };
  }

  return {
    modelAlias: own.modelAlias,
    thinkingEffort: own.thinkingEffort,
    source: 'inherit',
  };
}

export interface BuildSubagentModelDescriptionsOptions {
  readonly config: KimiConfig | undefined;
  readonly flags: ExperimentalFlagResolver;
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
}

/**
 * The "Available models" block appended to the `Agent` / `AgentSwarm` tool
 * descriptions so the parent model knows it can pick. `undefined` when there
 * is nothing useful to list (no configured models and no secondary shortcut).
 */
export function buildSubagentModelDescriptions(
  options: BuildSubagentModelDescriptionsOptions,
): string | undefined {
  const { config, flags, callerModelAlias, availableModelIds = [], modelLabels = {} } = options;
  const secondaryModel = resolveSecondaryModel(config, flags)?.model;
  const catalogIds = availableModelIds.filter((id) => id !== SECONDARY_DERIVED_MODEL_ALIAS);

  if (catalogIds.length === 0 && secondaryModel === undefined) return undefined;

  const lines = ['Available models (pass via model):'];
  if (callerModelAlias !== undefined) {
    lines.push(
      `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
    );
  }
  if (secondaryModel !== undefined) {
    lines.push(
      `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks`,
    );
  }
  for (const id of catalogIds) {
    const label = modelLabels[id];
    lines.push(
      label !== undefined && label.length > 0 && label !== id
        ? `- ${id}: ${label}`
        : `- ${id}`,
    );
  }
  lines.push(
    'Pass a model alias copied exactly from the list above (the id before ":" / "—", e.g. provider/gpt-5.6-sol — not a shortened form like provider/gpt-5.6), or the shortcuts "primary" / "secondary". This explicit choice overrides the selected agent type\'s model_preference; without either, secondary is the default when configured, otherwise the subagent inherits your model. Ignored when resuming — resumed subagents keep their own model.',
  );
  return lines.join('\n');
}

/**
 * Point a spawn-time model resolution failure at the secondary-model
 * configuration when the bound model came from `[secondary_model]`. Free-alias
 * failures keep their plain error so the parent model is not misled.
 */
export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  source: SubagentBindingSource,
): unknown {
  if (source !== 'secondary') {
    return error;
  }
  if (!(error instanceof KimiError) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  // ProviderManager tags only the missing-alias failure with details.model;
  // malformed aliases and providers must keep their own actionable errors.
  if (error.details?.['model'] !== boundModel) return error;
  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ALIAS
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ALIAS}"`
      : `"${boundModel}"`;
  return new KimiError(
    error.code,
    `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      details: {
        ...error.details,
        secondaryModel: boundModel,
      },
    },
  );
}
