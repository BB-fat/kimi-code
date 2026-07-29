/**
 * `sessionTitle` domain (L6) — registers the `auto-title` experimental flag
 * into `flag`.
 *
 * Gates generating the session title through the managed platform's
 * `chat_title` tool (replacing the truncated-prompt easy title). Off by
 * default; enable via `KIMI_CODE_EXPERIMENTAL_AUTO_TITLE`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect (registers the definition) from the package
 * barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AUTO_TITLE_FLAG_ID = 'auto-title';
export const AUTO_TITLE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AUTO_TITLE';

export const autoTitleFlag: FlagDefinitionInput = {
  id: AUTO_TITLE_FLAG_ID,
  title: 'Auto session title',
  description:
    'Generate the session title from the first prompt through the managed chat_title tool instead of keeping the truncated prompt. Requires a managed Kimi Code OAuth login.',
  env: AUTO_TITLE_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(autoTitleFlag);
