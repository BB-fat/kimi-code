import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import COWORK_BODY from './cowork.md?raw';

const PSEUDO_PATH = 'builtin://cowork';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/cowork.md',
  skillDirName: 'cowork',
  source: 'builtin',
  text: COWORK_BODY,
});

export const COWORK_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
