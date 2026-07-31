import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type {
  AgentRunHandle,
  AgentRunRequest,
  ISessionSubagentService,
  RunAgentOptions,
} from '#/session/subagent/subagent';
import type { SpineSpawnTaskInput } from '#/agent/spine/spine';
import {
  executeSpawnBranches,
  maxSpawnBranchCount,
  resolveMaxThreads,
  taskEnvelope,
  type SpawnBranchResult,
} from '#/agent/spine/spineSpawn';

interface FakeAgent {
  readonly id: string;
  removed: boolean;
  cancelled: boolean;
  completionValue: Promise<{ summary: string }>;
}

function fakeRunHandle(turnId: number, completion: Promise<{ summary: string }>): AgentRunHandle {
  const controller = new AbortController();
  return {
    agentId: `agent-${String(turnId)}`,
    turn: {
      id: turnId,
      signal: controller.signal,
      cancel: (reason?: unknown) => {
        controller.abort(reason);
        return true;
      },
      ready: Promise.resolve(),
      result: Promise.resolve({ type: 'completed', steps: 0 } as never),
    },
    completion,
  };
}

function buildFakes(tasks: readonly SpineSpawnTaskInput[]): {
  readonly lifecycle: IAgentLifecycleService;
  readonly subagentService: ISessionSubagentService;
  readonly agents: FakeAgent[];
  readonly runCompletionControllers: ReturnType<typeof buildCompletionController>[];
} {
  const agents: FakeAgent[] = [];
  const runCompletionControllers = tasks.map(() => buildCompletionController());

  const lifecycle: IAgentLifecycleService = {
    _serviceBrand: undefined,
    onDidCreate: { event: () => ({ dispose: () => undefined }) } as never,
    onDidDispose: { event: () => ({ dispose: () => undefined }) } as never,
    create: () => Promise.reject(new Error('not used')),
    fork: async (_sourceAgentId, opts) => {
      const id = `agent-${String(agents.length)}`;
      const agent: FakeAgent = {
        id,
        removed: false,
        cancelled: false,
        completionValue: Promise.resolve({ summary: '' }),
      };
      agents.push(agent);
      return {
        id,
        accessor: {
          get: () => {
            throw new Error('unexpected accessor call');
          },
        },
        dispose: () => undefined,
      } as unknown as IAgentScopeHandle;
    },
    get: () => undefined,
    list: () => [],
    broadcastPermissionMode: () => undefined,
    remove: async (agentId) => {
      const agent = agents.find((a) => a.id === agentId);
      if (agent !== undefined) agent.removed = true;
    },
  };

  const subagentService: ISessionSubagentService = {
    _serviceBrand: undefined,
    hooks: { onWillStartAgentTask: { register: () => ({ dispose: () => undefined }) } },
    onDidStopAgentTask: { event: () => ({ dispose: () => undefined }) },
    run: async (agentId: string, _request: AgentRunRequest, opts: RunAgentOptions) => {
      const index = agents.findIndex((a) => a.id === agentId);
      const agent = agents[index];
      if (agent === undefined) throw new Error(`unknown agent ${agentId}`);
      const controller = runCompletionControllers[index];
      if (controller === undefined) throw new Error(`no completion controller for ${agentId}`);

      // Wire cancellation: when the provided signal aborts, cancel the turn.
      const onAbort = () => {
        agent.cancelled = true;
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });

      agent.completionValue = controller.promise;
      const completion = agent.completionValue.finally(() => {
        opts.signal.removeEventListener('abort', onAbort);
      });
      return fakeRunHandle(index, completion);
    },
    notifyAgentTaskStopped: () => undefined,
  } as unknown as ISessionSubagentService;

  return { lifecycle, subagentService, agents, runCompletionControllers };
}

function buildCompletionController() {
  let resolve!: (value: { summary: string }) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<{ summary: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

const TASKS: SpineSpawnTaskInput[] = [
  { summary: 'branch A', prompt: 'do A' },
  { summary: 'branch B', prompt: 'do B' },
];

describe('executeSpawnBranches', () => {
  it('forks with trimTrailingToolCallBatch enabled', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const forkSpy = vi.spyOn(lifecycle, 'fork');
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: 'memory A' });
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    await promise;
    expect(forkSpy).toHaveBeenCalledTimes(2);
    expect(forkSpy).toHaveBeenCalledWith('main', { trimTrailingToolCallBatch: true });
  });

  it('wraps the task in the expected envelope', () => {
    const envelope = taskEnvelope({ summary: 'branch A', prompt: 'do A' });
    expect(envelope).toContain('You are one branch of a spine_spawn fission');
    expect(envelope).toContain('The original continuation is suspended during this fission');
    expect(envelope).toContain('no supervisory model is active');
    expect(envelope).toContain('Branch label and outcome: branch A');
    expect(envelope).toContain('Assignment:\ndo A');
    expect(envelope).toContain('When you finish, return only the terminal memory for this branch.');
  });

  it('returns a completed receipt when all branches succeed', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: 'memory A' });
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results).toEqual<readonly SpawnBranchResult[]>([
      { summary: 'branch A', outcome: 'completed', memoryBody: 'memory A' },
      { summary: 'branch B', outcome: 'completed', memoryBody: 'memory B' },
    ]);
  });

  it('isolates a single errored branch and keeps the rest', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.reject(new Error('boom'));
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.diagnostic).toContain('boom');
    expect(results[1]).toEqual({ summary: 'branch B', outcome: 'completed', memoryBody: 'memory B' });
  });

  it('isolates a single aborted branch and keeps the rest', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    const abortError = new Error('user cancelled');
    abortError.name = 'AbortError';
    runCompletionControllers[0]!.reject(abortError);
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results[0]?.outcome).toBe('aborted');
    expect(results[0]?.diagnostic).toContain('user cancelled');
    expect(results[1]).toEqual({ summary: 'branch B', outcome: 'completed', memoryBody: 'memory B' });
  });

  it('treats an empty summary as errored', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: '   ' });
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.diagnostic).toBe('child completed without a non-empty final memory');
    expect(results[0]?.memoryBody).toBe('child completed without a non-empty final memory');
    expect(results[1]).toEqual({ summary: 'branch B', outcome: 'completed', memoryBody: 'memory B' });
  });

  it('aborts unfinished branches when the turn signal is aborted and releases all agents', async () => {
    const { lifecycle, subagentService, agents } = buildFakes(TASKS);
    const controller = new AbortController();
    const promise = executeSpawnBranches(
      { lifecycle, subagentService },
      TASKS,
      controller.signal,
    );
    // Let both starts land, then abort before any branch completes.
    await Promise.resolve();
    controller.abort('turn cancelled');
    const results = await promise;
    expect(results.every((r) => r.outcome === 'aborted')).toBe(true);
    expect(agents.every((a) => a.removed)).toBe(true);
  });

  it('releases all agents in finally even when some fail', async () => {
    const { lifecycle, subagentService, agents, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: 'memory A' });
    runCompletionControllers[1]!.reject(new Error('boom'));
    await promise;
    expect(agents.every((a) => a.removed)).toBe(true);
  });

  it('errors a branch whose fork fails, aborts live siblings, and still releases them', async () => {
    const { lifecycle, subagentService, agents, runCompletionControllers } = buildFakes(TASKS);
    const originalFork = lifecycle.fork;
    let forkCalls = 0;
    lifecycle.fork = async (sourceAgentId, opts) => {
      forkCalls += 1;
      if (forkCalls === 2) throw new Error('fork denied');
      return originalFork(sourceAgentId, opts);
    };

    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    // The started branch's run is cancelled by the batch; simulate its turn
    // settling as an abort, the way a cancelled turn's completion rejects.
    const abortError = new Error('turn cancelled');
    abortError.name = 'AbortError';
    runCompletionControllers[0]!.reject(abortError);
    const results = await promise;

    expect(results[0]?.outcome).toBe('aborted');
    expect(results[0]?.diagnostic).toContain('a sibling branch failed to start');
    expect(results[1]?.outcome).toBe('errored');
    expect(results[1]?.diagnostic).toContain('fork denied');
    // Only one fork succeeded, and that agent was released despite the failure.
    expect(agents).toHaveLength(1);
    expect(agents[0]?.removed).toBe(true);
  });

  it('returns results even when releasing a branch fails', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    lifecycle.remove = async () => {
      throw new Error('remove failed');
    };
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: 'memory A' });
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results.every((r) => r.outcome === 'completed')).toBe(true);
  });
});

describe('resolveMaxThreads', () => {
  it('defaults to 4', () => {
    expect(resolveMaxThreads(undefined)).toBe(4);
    expect(resolveMaxThreads('')).toBe(4);
  });

  it('parses a valid positive integer', () => {
    expect(resolveMaxThreads('8')).toBe(8);
  });

  it('falls back for invalid values', () => {
    expect(resolveMaxThreads('abc')).toBe(4);
    expect(resolveMaxThreads('1')).toBe(4);
    expect(resolveMaxThreads('3.5')).toBe(4);
  });

  it('computes branch capacity as maxThreads - 1', () => {
    expect(maxSpawnBranchCount(4)).toBe(3);
    expect(maxSpawnBranchCount(2)).toBe(1);
  });
});
