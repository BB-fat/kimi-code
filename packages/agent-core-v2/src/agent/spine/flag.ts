/**
 * `spine` domain (L4) — independent environment gate for the spine experiment.
 *
 * Reads `KIMI_CODE_SPINE` directly from the environment rather than the `flag`
 * registry: the registry's master switch (`KIMI_CODE_EXPERIMENTAL_FLAG`, which
 * also enables the v2 engine itself) is force-on with no opt-out, so routing
 * spine through it would turn spine on for every v2 user. An independent env
 * keeps "using v2" and "using spine" as separate choices. Pure configuration,
 * no IO.
 */

export const SPINE_ENV = 'KIMI_CODE_SPINE';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isSpineEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return TRUTHY_VALUES.has((env[SPINE_ENV] ?? '').trim().toLowerCase());
}
