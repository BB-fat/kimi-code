/**
 * `spine` domain (L4) — `spine_spawn` fission executor.
 *
 * Pure module (not a DI service). `executeSpawnBranches` forks one child agent
 * per task via `IAgentLifecycleService.fork('main', { trimTrailingToolCallBatch: true })`,
 * runs each branch with `ISessionSubagentService.run`, and waits for all
 * completions. Single-branch failures do not propagate: each branch records its
 * own outcome. The caller (`AgentSpineService`) owns capacity admission and
 * constructs the `spine.spawn.result.v1` receipt.
 *
 * Cache affinity: each forked agent shares the parent's session id through the
 * Agent-scope `IAgentProfileService.resolveRequestParams`, which uses
 * `ISessionContext.sessionId` as the prompt-cache key. That is the existing v2
 * seam; no extra wiring is required here. (If a future provider needs a
 * different cache key shape, extend `RunAgentOptions` or `ForkAgentOptions`.)
 */

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type {
  AgentRunHandle,
  ISessionSubagentService,
  RunAgentOptions,
} from '#/session/subagent/subagent';

import type { SpineSpawnTaskInput } from './spine';

export type SpawnBranchOutcome = 'completed' | 'errored' | 'aborted';

export interface SpawnBranchResult {
  readonly summary: string;
  readonly outcome: SpawnBranchOutcome;
  readonly memoryBody: string;
  readonly diagnostic?: string;
}

export interface SpawnExecutorDependencies {
  readonly lifecycle: IAgentLifecycleService;
  readonly subagentService: ISessionSubagentService;
}

const EMPTY_MEMORY_DIAGNOSTIC = 'child completed without a non-empty final memory';

export function taskEnvelope(task: SpineSpawnTaskInput): string {
  return (
    'You are one branch of a spine_spawn fission. The original continuation is suspended during this fission; no supervisory model is active.\n' +
    `Branch label and outcome: ${task.summary}\n` +
    `Assignment:\n${task.prompt}\n` +
    'When you finish, return only the terminal memory for this branch.'
  );
}

/**
 * Default aggregate thread limit for spine_spawn fissions. The main agent plus
 * up to `DEFAULT_MAX_THREADS - 1` concurrent child agents may run; the number of
 * tasks in one spawn call therefore cannot exceed `DEFAULT_MAX_THREADS - 1`.
 */
export const DEFAULT_MAX_THREADS = 4;

/**
 * Environment variable that overrides the default max thread count.
 */
export const SPINE_SPAWN_MAX_THREADS_ENV = 'KIMI_CODE_SPINE_SPAWN_MAX_THREADS';

/**
 * Parses the configured max thread count, falling back to the default when the
 * env value is missing, non-numeric, or not a positive integer.
 */
export function resolveMaxThreads(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_MAX_THREADS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 2) return DEFAULT_MAX_THREADS;
  return parsed;
}

/**
 * Returns the largest number of tasks a single spawn call may admit. The main
 * agent occupies one thread, leaving `maxThreads - 1` for children.
 */
export function maxSpawnBranchCount(maxThreads: number): number {
  return Math.max(1, maxThreads - 1);
}

export async function executeSpawnBranches(
  deps: SpawnExecutorDependencies,
  tasks: readonly SpineSpawnTaskInput[],
  signal: AbortSignal,
): Promise<readonly SpawnBranchResult[]> {
  const starts = await Promise.all(
    tasks.map((task) =>
      startBranch(deps, task, signal).then(
        (branch): BranchStart => ({ ok: true, branch }),
        (error: unknown): BranchStart => ({ ok: false, error }),
      ),
    ),
  );
  const started = starts.flatMap((start) => (start.ok ? [start.branch] : []));
  try {
    // A start failure aborts the whole batch: live siblings are cancelled and
    // reported aborted (the same all-or-nothing shape upstream uses), and every
    // started agent is still released in the finally below.
    const batchAborted = starts.some((start) => !start.ok);
    if (batchAborted) {
      for (const branch of started) {
        branch.run.turn.cancel('a sibling branch failed to start');
      }
    }
    const completions = await Promise.allSettled(
      starts.map((start) =>
        start.ok ? awaitBranch(start.branch, signal) : Promise.reject(start.error),
      ),
    );
    return completions.map((completion, index) =>
      finalizeBranch(tasks[index]!, starts[index]!, completion, batchAborted),
    );
  } finally {
    await Promise.all(started.map((branch) => releaseBranch(deps, branch)));
  }
}

type BranchStart =
  | { readonly ok: true; readonly branch: SpawnBranch }
  | { readonly ok: false; readonly error: unknown };

interface SpawnBranch {
  readonly task: SpineSpawnTaskInput;
  readonly handle: IAgentScopeHandle;
  readonly run: AgentRunHandle;
}

async function startBranch(
  deps: SpawnExecutorDependencies,
  task: SpineSpawnTaskInput,
  signal: AbortSignal,
): Promise<SpawnBranch> {
  const handle = await deps.lifecycle.fork('main', {
    trimTrailingToolCallBatch: true,
  });
  const run = await deps.subagentService.run(
    handle.id,
    { kind: 'prompt', prompt: taskEnvelope(task) },
    { signal } satisfies RunAgentOptions,
  );
  return { task, handle, run };
}

async function awaitBranch(
  branch: SpawnBranch,
  signal: AbortSignal,
): Promise<{ readonly summary: string }> {
  if (signal.aborted) {
    branch.run.turn.cancel(signal.reason);
    throw new AbortError(signal.reason);
  }
  return branch.run.completion;
}

function finalizeBranch(
  task: SpineSpawnTaskInput,
  start: BranchStart,
  completion: PromiseSettledResult<{ readonly summary: string }>,
  batchAborted: boolean,
): SpawnBranchResult {
  if (!start.ok) {
    const message = start.error instanceof Error ? start.error.message : String(start.error);
    return {
      summary: task.summary,
      outcome: 'errored',
      memoryBody: message,
      diagnostic: message,
    };
  }
  if (completion.status === 'rejected') {
    if (batchAborted) {
      const message = 'branch aborted: a sibling branch failed to start';
      return {
        summary: task.summary,
        outcome: 'aborted',
        memoryBody: message,
        diagnostic: message,
      };
    }
    const reason = extractReason(completion.reason);
    return {
      summary: task.summary,
      outcome: reason.kind === 'abort' ? 'aborted' : 'errored',
      memoryBody: reason.message,
      diagnostic: reason.message,
    };
  }
  const summary = completion.value.summary.trim();
  if (summary.length === 0) {
    return {
      summary: task.summary,
      outcome: 'errored',
      memoryBody: EMPTY_MEMORY_DIAGNOSTIC,
      diagnostic: EMPTY_MEMORY_DIAGNOSTIC,
    };
  }
  return {
    summary: task.summary,
    outcome: 'completed',
    memoryBody: summary,
  };
}

async function releaseBranch(
  deps: SpawnExecutorDependencies,
  branch: SpawnBranch,
): Promise<void> {
  try {
    await deps.lifecycle.remove(branch.handle.id);
  } catch (error) {
    // A release failure must not mask the batch's results; the receipt is the
    // join's only record, so report and move on.
    onUnexpectedError(error);
  }
}

interface RejectionReason {
  readonly kind: 'abort' | 'error';
  readonly message: string;
}

function extractReason(reason: unknown): RejectionReason {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (isAbortReason(reason)) return { kind: 'abort', message };
  return { kind: 'error', message };
}

function isAbortReason(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === 'AbortError') return true;
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    reason.name === 'AbortError'
  ) {
    return true;
  }
  return false;
}

class AbortError extends Error {
  constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'AbortError';
  }
}
