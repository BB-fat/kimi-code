/**
 * `IV1SessionRefResolver` — the five bare-id resolution rules of plan §1.3
 * (not found / unique / ambiguous / runtime unavailable / never silently
 * first), the discovery catch-up, `listAll` fan-out, and the frozen v1 error
 * envelope mapping. Run with
 * `pnpm --filter @moonshot-ai/kap-server exec vitest run test/v1SessionRefResolver.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  SessionHostRuntimeError,
  SessionHostRuntimeErrors,
  SessionHostRuntimeRegistry,
  type ISessionHostRuntime,
  type ISessionManager,
  type SessionDescriptor,
  type SessionRuntimeStatus,
} from '@moonshot-ai/agent-core-v2';

import {
  V1SessionRefResolver,
  v1ResolveFailureEnvelope,
} from '../src/app/v1Compatibility/v1SessionRefResolver';

function descriptor(runtimeId: string, sessionId: string, title?: string): SessionDescriptor {
  return {
    ref: { runtimeId, sessionId },
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(2).toISOString(),
    status: 'active',
    metadata: title === undefined ? {} : { title },
  };
}

interface FakeRuntimeOptions {
  readonly status?: SessionRuntimeStatus;
  /** sessionId → descriptor; an Error value is thrown from `get`. */
  readonly sessions?: Record<string, SessionDescriptor | Error>;
  /** Throw this from every `get` (e.g. a runtime that flipped unavailable). */
  readonly getError?: Error;
  /** Throw `session.runtime_unavailable` from `list`. */
  readonly listError?: Error;
}

function fakeRuntime(id: string, options: FakeRuntimeOptions = {}): ISessionHostRuntime {
  const manager = {
    get: async (sessionId: string) => {
      if (options.getError !== undefined) throw options.getError;
      const found = options.sessions?.[sessionId];
      if (found instanceof Error) throw found;
      return found;
    },
    list: async () => {
      if (options.listError !== undefined) throw options.listError;
      const items = Object.values(options.sessions ?? {}).filter(
        (item): item is SessionDescriptor => !(item instanceof Error),
      );
      return { items };
    },
  } as unknown as ISessionManager;
  return {
    id,
    kind: 'fake',
    sessions: manager,
    status: () => options.status ?? 'online',
    capabilities: () => new Set(),
    close: async () => {},
  };
}

const UNAVAILABLE = new SessionHostRuntimeError(
  SessionHostRuntimeErrors.codes.SESSION_RUNTIME_UNAVAILABLE,
  'fake runtime is offline',
);

function makeResolver(
  registry: SessionHostRuntimeRegistry,
  ensureDiscovered?: () => Promise<unknown>,
): { resolver: V1SessionRefResolver; state: { discoverCalls: number } } {
  const state = { discoverCalls: 0 };
  const resolver = new V1SessionRefResolver({
    registry,
    ensureDiscovered: async () => {
      state.discoverCalls += 1;
      await ensureDiscovered?.();
    },
  });
  return { resolver, state };
}

describe('V1SessionRefResolver (plan §1.3)', () => {
  it('rule 1: no match anywhere → not_found, after one discovery catch-up', async () => {
    const registry = new SessionHostRuntimeRegistry();
    registry.register(fakeRuntime('rt-a', { sessions: { s1: descriptor('rt-a', 's1') } }));
    const { resolver, state } = makeResolver(registry);

    const result = await resolver.resolve('missing');
    expect(result.kind).toBe('not_found');
    expect(state.discoverCalls).toBe(1);

    // A known-missing id keeps resolving to not_found (discovery is per-call
    // but cheap: already-registered buckets are reused by the manager).
    const again = await resolver.resolve('missing');
    expect(again.kind).toBe('not_found');
  });

  it('rule 2: exactly one match → resolved with ref, runtime and descriptor', async () => {
    const registry = new SessionHostRuntimeRegistry();
    const owner = fakeRuntime('rt-a', {
      sessions: { s1: descriptor('rt-a', 's1', 'hello') },
    });
    registry.register(owner);
    registry.register(fakeRuntime('rt-b', { sessions: { s2: descriptor('rt-b', 's2') } }));
    const { resolver, state } = makeResolver(registry);

    const result = await resolver.resolve('s1');
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.resolution.ref).toEqual({ runtimeId: 'rt-a', sessionId: 's1' });
    expect(result.resolution.runtime).toBe(owner);
    expect(result.resolution.descriptor.metadata['title']).toBe('hello');
    // A first-round hit never triggers the discovery catch-up.
    expect(state.discoverCalls).toBe(0);
  });

  it('rule 3+5: two runtimes with the same id → ambiguous, never the first candidate', async () => {
    const registry = new SessionHostRuntimeRegistry();
    // Registration order is deliberate: the FIRST registered runtime matches
    // too — the resolver must not fall back to it.
    registry.register(fakeRuntime('rt-first', { sessions: { same: descriptor('rt-first', 'same') } }));
    registry.register(fakeRuntime('rt-second', { sessions: { same: descriptor('rt-second', 'same') } }));
    const { resolver } = makeResolver(registry);

    const result = await resolver.resolve('same');
    expect(result.kind).toBe('ambiguous');
    // The discriminated union carries no candidate field at all.
    expect('resolution' in result).toBe(false);
  });

  it('rule 4: an offline registry entry keeps "no match" from becoming "not found"', async () => {
    const registry = new SessionHostRuntimeRegistry();
    registry.register(fakeRuntime('rt-online', { sessions: {} }));
    registry.register(fakeRuntime('rt-offline', { status: 'offline', sessions: {} }));
    const { resolver } = makeResolver(registry);

    const result = await resolver.resolve('anything');
    expect(result.kind).toBe('unavailable');
  });

  it('rule 4: a runtime flipping unavailable mid-probe maps the same way', async () => {
    const registry = new SessionHostRuntimeRegistry();
    registry.register(fakeRuntime('rt-flaky', { getError: UNAVAILABLE }));
    const { resolver } = makeResolver(registry);

    expect((await resolver.resolve('s1')).kind).toBe('unavailable');
    expect((await resolver.resolve('unknown')).kind).toBe('unavailable');
  });

  it('discovers a session whose runtime was never opened in this process', async () => {
    const registry = new SessionHostRuntimeRegistry();
    const { resolver, state } = makeResolver(registry, async () => {
      registry.register(fakeRuntime('rt-late', { sessions: { old: descriptor('rt-late', 'old') } }));
    });

    const result = await resolver.resolve('old');
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.resolution.ref.runtimeId).toBe('rt-late');
    }
    expect(state.discoverCalls).toBe(1);
  });

  it('listAll aggregates every online runtime and skips unavailable ones', async () => {
    const registry = new SessionHostRuntimeRegistry();
    registry.register(
      fakeRuntime('rt-a', {
        sessions: { s1: descriptor('rt-a', 's1'), s2: descriptor('rt-a', 's2') },
      }),
    );
    registry.register(fakeRuntime('rt-b', { sessions: { s3: descriptor('rt-b', 's3') } }));
    registry.register(fakeRuntime('rt-off', { status: 'offline', sessions: { s4: descriptor('rt-off', 's4') } }));
    registry.register(fakeRuntime('rt-flaky', { listError: UNAVAILABLE }));
    const { resolver, state } = makeResolver(registry);

    const all = await resolver.listAll();
    expect(all.map((item) => item.ref.sessionId).toSorted()).toEqual(['s1', 's2', 's3']);
    expect(state.discoverCalls).toBe(1);
  });
});

describe('v1ResolveFailureEnvelope (plan §1.3/§8)', () => {
  it('not_found keeps the current 40401 "does not exist" shape', () => {
    const envelope = v1ResolveFailureEnvelope({ kind: 'not_found' }, 's1', 'req-1');
    expect(envelope).toEqual({
      code: 40401,
      msg: 'session s1 does not exist',
      data: null,
      request_id: 'req-1',
    });
  });

  it('ambiguous/unavailable map to 50001 without candidates or new fields', () => {
    const ambiguous = v1ResolveFailureEnvelope({ kind: 'ambiguous' }, 's1', 'req-2');
    expect(ambiguous.code).toBe(50001);
    expect(ambiguous.data).toBeNull();
    // No candidate runtimes, no internal cause names, no stack on the wire.
    expect(JSON.parse(JSON.stringify(ambiguous))).toEqual({
      code: 50001,
      msg: 'session s1 is ambiguous across runtimes',
      data: null,
      request_id: 'req-2',
    });

    const unavailable = v1ResolveFailureEnvelope({ kind: 'unavailable' }, 's1', 'req-3');
    expect(JSON.parse(JSON.stringify(unavailable))).toEqual({
      code: 50001,
      msg: 'session s1 is temporarily unavailable',
      data: null,
      request_id: 'req-3',
    });
  });
});
