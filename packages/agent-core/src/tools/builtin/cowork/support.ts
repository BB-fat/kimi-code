/**
 * Shared helpers for the cowork builtin tools: store construction, caller
 * identity resolution, and uniform error mapping. The cowork workspace always
 * anchors at the main checkout (the tower's working directory) — workers
 * whose cwd was overridden to their worktree still talk to the same
 * `.cowork/` tree.
 */

import { basename } from 'node:path';

import type { Agent } from '#/agent';

import {
  CoworkProtocolError,
  CoworkStore,
  GitError,
  TOWER_NAME,
  WORKTREES_DIR,
} from '../../../agent/cowork';
import type { CoworkState } from '../../../agent/cowork';
import type { ExecutableToolResult } from '../../../loop/types';

/** The store root is the main checkout holding `.cowork/`. */
export function newStore(agent: Agent): CoworkStore {
  return new CoworkStore(resolveCoworkRepoRoot(agent.config.cwd));
}

/**
 * Cowork worktrees always live at `<repoRoot>/.cowork/worktrees/<slot>`, so a
 * caller anchored inside one maps back to the main checkout by convention —
 * no state lookup needed (which would be circular: reading state requires the
 * store root).
 */
export function resolveCoworkRepoRoot(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/');
  const marker = `/${WORKTREES_DIR}/`;
  const index = normalized.indexOf(marker);
  if (index === -1) return cwd;
  return cwd.slice(0, index);
}

/**
 * Resolve the caller's cowork identity. The main agent is the control tower;
 * a spawned worker/reviewer is looked up in the roster by its agent id, which
 * is the basename of its homedir (`…/agents/agent-3` → `agent-3`).
 */
export function callerName(agent: Agent, state: CoworkState): string {
  if (agent.type === 'main') return TOWER_NAME;
  if (agent.homedir === undefined) {
    throw new CoworkProtocolError(
      'cannot resolve a cowork identity: this agent has no homedir to derive an agent id from',
    );
  }
  return newStore(agent).resolveCallerName(state, basename(agent.homedir));
}

/**
 * Run a cowork tool body, mapping expected protocol/git failures to error
 * results — their messages are written as next-step guidance for the model.
 * Unexpected (programming) errors keep propagating.
 */
export async function runCoworkTool(
  execute: () => Promise<ExecutableToolResult>,
): Promise<ExecutableToolResult> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof CoworkProtocolError || error instanceof GitError) {
      return { output: error.message, isError: true };
    }
    throw error;
  }
}
