/**
 * `spine` domain (L4) — registers the `spine` experimental flag into `flag`.
 *
 * Gates the Spine tree-of-work experiment: the spine_open / spine_close /
 * spine_next / spine_tree tools, the projector fold hook, the spine system
 * prompt view, and session archiving. Off by default; enable via
 * `KIMI_CODE_SPINE` or the `[experimental]` config section (`spine = true`).
 *
 * `ignoreMaster: true` keeps spine off the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG` switch: the CLI force-enables that switch for
 * every v2 user (apps/kimi-code/src/main.ts), so following it would turn spine
 * on for everyone — "using v2" and "using spine" stay separate choices.
 * Imported for its side effect (registers the definition) from the package
 * barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SPINE_FLAG_ID = 'spine';
export const SPINE_FLAG_ENV = 'KIMI_CODE_SPINE';

export const spineFlag: FlagDefinitionInput = {
  id: SPINE_FLAG_ID,
  title: 'Spine (tree-of-work)',
  description:
    'Replace the flat todo list with a model-driven Spine tree of work nodes (spine_open / spine_close / spine_next); folds history around the tree and archives closed nodes under the session directory.',
  env: SPINE_FLAG_ENV,
  default: false,
  surface: 'core',
  ignoreMaster: true,
};

registerFlagDefinition(spineFlag);
