/**
 * `skillCatalog` domain (L3) — shared skill-tree traversal policy.
 *
 * Defines the directory exclusions and bounded depth used by both filesystem
 * discovery and live monitoring, keeping their observable tree topology
 * aligned. Pure policy; no scoped state.
 */

import type { FileSourceWatchOptions } from '#/app/fileSourceMonitor/fileSourceMonitor';

export const SKILL_SCAN_MAX_DEPTH = 8;
export const SKILL_WATCH_MAX_DEPTH = SKILL_SCAN_MAX_DEPTH + 2;

export const SKILL_ROOT_WATCH_OPTIONS: FileSourceWatchOptions = {
  target: 'directory',
  recursive: true,
  depth: SKILL_WATCH_MAX_DEPTH,
  followSymlinks: true,
  ignoredPathNames: ['node_modules'],
  ignoreDotDirectories: true,
};

export function isSkillTraversalDirectory(name: string): boolean {
  return name !== 'node_modules' && !name.startsWith('.');
}
