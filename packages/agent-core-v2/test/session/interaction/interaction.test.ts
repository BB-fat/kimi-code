import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { InstantiationType } from '#/_base/di/extensions';
import { DisposableStore } from '#/_base/di/lifecycle';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
  type Scope,
} from '#/_base/di/scope';
import { createScopedTestHost, TestInstantiationService, type ScopedTestHost } from '#/_base/di/test';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentInteractionTurnBridge } from '#/agent/interaction/interactionTurnBridge';
import { InteractionTurnBridgeService } from '#/agent/interaction/interactionTurnBridgeService';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';

describe('SessionInteractionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
  });
  afterEach(() => disposables.dispose());

  it('request blocks until respond resolves it', async () => {
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request<{ n: number }, string>({
      kind: 'question',
      payload: { n: 1 },
    });
    expect(svc.listPending()).toHaveLength(1);

    svc.respond(svc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(svc.listPending()).toHaveLength(0);
  });

  it('uses the caller-provided id for correlation', async () => {
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request({ id: 'tool-1', kind: 'approval', payload: {} });
    expect(svc.listPending()[0]!.id).toBe('tool-1');
    svc.respond('tool-1', { decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('listPending filters by kind', () => {
    const svc = ix.get(ISessionInteractionService);
    void svc.request({ kind: 'approval', payload: {} });
    void svc.request({ kind: 'question', payload: {} });
    expect(svc.listPending('approval')).toHaveLength(1);
    expect(svc.listPending('question')).toHaveLength(1);
    expect(svc.listPending()).toHaveLength(2);
  });

  it('onDidChangePending fires on request and on respond', async () => {
    const svc = ix.get(ISessionInteractionService);
    let count = 0;
    disposables.add(svc.onDidChangePending(() => count++));
    const pending = svc.request({ kind: 'question', payload: {} });
    expect(count).toBe(1);
    svc.respond(svc.listPending()[0]!.id, 'x');
    await pending;
    expect(count).toBe(2);
  });

  it('onDidChangePending carries the pending ids snapshot', () => {
    const svc = ix.get(ISessionInteractionService);
    const snapshots: (readonly string[])[] = [];
    disposables.add(svc.onDidChangePending((e) => snapshots.push(e.pending)));
    void svc.request({ id: 'a', kind: 'approval', payload: {} });
    void svc.request({ id: 'b', kind: 'question', payload: {} });
    svc.respond('a', {});
    expect(snapshots).toEqual([['a'], ['a', 'b'], ['b']]);
  });

  it('respond to an unknown id is a no-op', () => {
    const svc = ix.get(ISessionInteractionService);
    expect(() => svc.respond('nope', 'x')).not.toThrow();
  });

  it('enqueue parks a request and returns it without blocking', () => {
    const svc = ix.get(ISessionInteractionService);
    const interaction = svc.enqueue({ id: 'e1', kind: 'approval', payload: { tool: 'bash' } });
    expect(interaction).toMatchObject({
      id: 'e1',
      kind: 'approval',
      payload: { tool: 'bash' },
    });
    expect(svc.listPending()).toHaveLength(1);
  });

  it('enqueue generates an id when none is provided', () => {
    const svc = ix.get(ISessionInteractionService);
    const interaction = svc.enqueue({ kind: 'question', payload: {} });
    expect(interaction.id).toMatch(/^interaction-/);
    expect(svc.listPending()[0]!.id).toBe(interaction.id);
  });

  it('onDidResolve fires with the id and response when responded to', () => {
    const svc = ix.get(ISessionInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'e1', kind: 'approval', payload: {} });
    svc.respond('e1', { decision: 'approved' });

    expect(seen).toEqual([{ id: 'e1', response: { decision: 'approved' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('onDidResolve does not fire for an unknown id', () => {
    const svc = ix.get(ISessionInteractionService);
    let count = 0;
    disposables.add(svc.onDidResolve(() => count++));
    svc.respond('nope', 'x');
    expect(count).toBe(0);
  });

  it('cancelPendingForTurn resolves that turn’s parked requests as cancelled and keeps the rest (矛盾 c)', async () => {
    const svc = ix.get(ISessionInteractionService);
    const ended = svc.request({
      id: 'a1',
      kind: 'approval',
      payload: {},
      origin: { agentId: 'main', turnId: 3 },
    });
    const survived = svc.request({
      id: 'a2',
      kind: 'approval',
      payload: {},
      origin: { agentId: 'main', turnId: 7 },
    });
    expect(svc.listPending()).toHaveLength(2);

    svc.cancelPendingForTurn(3);

    expect(svc.listPending().map((i) => i.id)).toEqual(['a2']);
    expect(svc.isRecentlyResolved('a1')).toBe(true);
    await expect(ended).resolves.toEqual({ cancelled: true, reason: 'turn_ended' });
    svc.respond('a2', { decision: 'approved' });
    await expect(survived).resolves.toEqual({ decision: 'approved' });
  });
});

describe('IAgentInteractionTurnBridge (Agent → Session scope wiring)', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });
  afterEach(() => disposables.dispose());

  it('turn.ended on the agent bus cancels the Session kernel’s pending entries for that turn', () => {
    const ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(IAgentInteractionTurnBridge, new SyncDescriptor(InteractionTurnBridgeService));

    ix.get(IAgentInteractionTurnBridge); // wires the subscription
    const bus = ix.get(IEventBus);
    const svc = ix.get(ISessionInteractionService);
    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 3 } });
    svc.enqueue({ id: 'a2', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 7 } });

    bus.publish({ type: 'turn.ended', turnId: 3, reason: 'completed' } as unknown as DomainEvent);

    expect(svc.listPending().map((i) => i.id)).toEqual(['a2']);
    expect(svc.isRecentlyResolved('a1')).toBe(true);
  });

  it('resolves the interaction kernel across the real App > Session > Agent scope tree', () => {
    // Regression for the startup crash `[createInstance] SessionInteractionService
    // depends on UNKNOWN service eventBus`: the kernel is Session-scoped while
    // the bus is Agent-scoped, so the kernel must not inject the bus. Build the
    // real strict scope tree (createAppScope runs strict, like production);
    // resolving and *calling* the kernel from the Agent scope used to throw.
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionInteractionService,
      SessionInteractionService,
      InstantiationType.Delayed,
      'interaction',
    );
    registerScopedService(
      LifecycleScope.Agent,
      IEventBus,
      EventBusService,
      InstantiationType.Delayed,
      'event',
    );
    // Eager, matching the production registration: a Delayed proxy would be
    // returned by accessor.get() and never instantiated (nothing calls a
    // method on a pure wiring), so the subscription would never exist.
    registerScopedService(
      LifecycleScope.Agent,
      IAgentInteractionTurnBridge,
      InteractionTurnBridgeService,
      InstantiationType.Eager,
      'interaction',
    );

    const host: ScopedTestHost = createScopedTestHost();
    disposables.add({ dispose: () => host.dispose() });
    const session: Scope = host.child(LifecycleScope.Session, 'session-a');
    const agent: Scope = host.childOf(session, LifecycleScope.Agent, 'main');

    const kernel = agent.accessor.get(ISessionInteractionService);
    expect(() => kernel.listPending()).not.toThrow();

    // End to end through the scope tree: the agent-scoped bridge observes its
    // own bus and cancels the session kernel's parked entries.
    agent.accessor.get(IAgentInteractionTurnBridge);
    kernel.enqueue({
      id: 'a1',
      kind: 'approval',
      payload: {},
      origin: { agentId: 'main', turnId: 1 },
    });
    expect(kernel.listPending()).toHaveLength(1);
    agent.accessor
      .get(IEventBus)
      .publish({ type: 'turn.ended', turnId: 1, reason: 'completed' } as unknown as DomainEvent);
    expect(kernel.listPending()).toHaveLength(0);
  });
});
