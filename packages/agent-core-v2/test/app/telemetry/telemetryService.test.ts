/**
 * `telemetry` domain (L1) — telemetry facade lifecycle coverage.
 *
 * Exercises appender fan-out, context views, error isolation, ordered
 * replacement, terminal appender rejection, lifecycle-option forwarding, and
 * App-scope registration through `ITelemetryService`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LifecycleScope, ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import {
  type ITelemetryAppender,
  type TelemetryProperties,
  type TelemetryShutdownOptions,
  ITelemetryService,
} from '#/app/telemetry/telemetry';
import { TelemetryService } from '#/app/telemetry/telemetryService';

class CapturingAppender implements ITelemetryAppender {
  readonly events: { event: string; properties?: TelemetryProperties }[] = [];
  startCalls = 0;
  flushCalls = 0;
  shutdownCalls = 0;
  shutdownOptions: TelemetryShutdownOptions | undefined;
  start(): void {
    this.startCalls += 1;
  }
  track(event: string, properties?: TelemetryProperties): void {
    this.events.push({ event, properties });
  }
  flush(): void {
    this.flushCalls += 1;
  }
  shutdown(options?: TelemetryShutdownOptions): void {
    this.shutdownCalls += 1;
    this.shutdownOptions = options;
  }
}

function telemetryWithAppenders(...appenders: ITelemetryAppender[]): TelemetryService {
  const svc = new TelemetryService();
  for (const appender of appenders) {
    svc.addAppender(appender);
  }
  return svc;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TelemetryService (unit)', () => {
  it('noop by default — does not throw', () => {
    const svc = new TelemetryService();
    expect(() => svc.track('evt', { a: 1 })).not.toThrow();
  });

  it('merges bound context into tracked properties', async () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();
    await svc.setAppender(appender);
    svc.setContext({ sessionId: 's1' });
    svc.track('turn.start', { agentId: 'main' });
    expect(appender.events[0]).toEqual({
      event: 'turn.start',
      properties: { sessionId: 's1', agentId: 'main' },
    });
  });

  it('withContext merges context and shares the appender', async () => {
    const appender = new CapturingAppender();
    const root = new TelemetryService();
    await root.setAppender(appender);
    root.setContext({ sessionId: 's1' });
    const child = root.withContext({ agentId: 'main', turnId: 't1' });
    child.track('tool.call', { name: 'bash' });
    expect(appender.events[0]?.properties).toEqual({
      sessionId: 's1',
      agentId: 'main',
      turnId: 't1',
      name: 'bash',
    });
  });

  it('per-call properties override bound context on key collision', async () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();
    await svc.setAppender(appender);
    svc.setContext({ sessionId: 's1' });
    svc.track('evt', { sessionId: 'override' });
    expect(appender.events[0]?.properties?.['sessionId']).toBe('override');
  });

  it('fans out to every appender passed via appenders', () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = telemetryWithAppenders(a, b);
    svc.track('evt', { x: 1 });
    expect(a.events).toEqual([{ event: 'evt', properties: { x: 1 } }]);
    expect(b.events).toEqual([{ event: 'evt', properties: { x: 1 } }]);
  });

  it('addAppender registers an appender and its disposable removes it', () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = telemetryWithAppenders(a);
    const disposable = svc.addAppender(b);
    svc.track('first');
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    disposable.dispose();
    svc.track('second');
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(1);
  });

  it('an owning registration durably retires its appender', async () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();
    const registration = svc.addAppender(appender);

    await registration.shutdown();
    svc.track('after_retirement');

    expect(appender.shutdownCalls).toBe(1);
    expect(appender.events).toHaveLength(0);
  });

  it('registration shutdown tightens retirement started by disposal', async () => {
    const retired = deferred();
    const shutdownOptions: Array<TelemetryShutdownOptions | undefined> = [];
    const appender: ITelemetryAppender = {
      track() {},
      shutdown(options) {
        shutdownOptions.push(options);
        return retired.promise;
      },
    };
    const svc = new TelemetryService();
    const registration = svc.addAppender(appender);
    const options = { deadlineMs: 42 };

    registration.dispose();
    await Promise.resolve();
    const closing = registration.shutdown(options);
    await Promise.resolve();

    expect(shutdownOptions).toEqual([undefined, options]);
    retired.resolve();
    await closing;
  });

  it('addAppender starts the registered appender', () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();

    svc.addAppender(appender);

    expect(appender.startCalls).toBe(1);
  });

  it('removeAppender stops delivery to that appender', () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = telemetryWithAppenders(a, b);
    void svc.removeAppender(a);
    svc.track('evt');
    expect(a.events).toHaveLength(0);
    expect(b.events).toHaveLength(1);
  });

  it('setAppender starts the replacement appender after retirement completes', async () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();

    await svc.setAppender(appender);

    expect(appender.startCalls).toBe(1);
  });

  it('setAppender durably retires the appender it replaces', async () => {
    const previous = new CapturingAppender();
    const replacement = new CapturingAppender();
    const svc = telemetryWithAppenders(previous);

    await svc.setAppender(replacement);

    expect(previous.shutdownCalls).toBe(1);
    expect(replacement.startCalls).toBe(1);
  });

  it('setAppender starts the replacement only after the previous appender retires', async () => {
    const retired = deferred();
    const lifecycle: string[] = [];
    const previous: ITelemetryAppender = {
      track() {},
      async shutdown() {
        lifecycle.push('shutdown-started');
        await retired.promise;
        lifecycle.push('shutdown-finished');
      },
    };
    const replacement: ITelemetryAppender = {
      start() {
        lifecycle.push('replacement-started');
      },
      track() {},
    };
    const svc = new TelemetryService();
    await svc.setAppender(previous);

    const replacing = svc.setAppender(replacement);
    await Promise.resolve();

    expect(lifecycle).toEqual(['shutdown-started']);

    retired.resolve();
    await replacing;

    expect(lifecycle).toEqual([
      'shutdown-started',
      'shutdown-finished',
      'replacement-started',
    ]);
  });

  it('setAppender holds replacement traffic until previous retirement completes', async () => {
    const retired = deferred();
    const lifecycle: string[] = [];
    const previous: ITelemetryAppender = {
      track() {},
      async shutdown() {
        lifecycle.push('shutdown-started');
        await retired.promise;
        lifecycle.push('shutdown-finished');
      },
    };
    const replacement: ITelemetryAppender = {
      start() {
        lifecycle.push('replacement-started');
      },
      track(event) {
        lifecycle.push(`replacement-tracked:${event}`);
      },
      flush() {
        lifecycle.push('replacement-flushed');
      },
    };
    const svc = new TelemetryService();
    await svc.setAppender(previous);

    const replacing = svc.setAppender(replacement);
    svc.track('during-replacement');
    const flushing = svc.flush();
    await Promise.resolve();

    expect(lifecycle).toEqual(['shutdown-started']);

    retired.resolve();
    await Promise.all([replacing, flushing]);

    expect(lifecycle).toEqual([
      'shutdown-started',
      'shutdown-finished',
      'replacement-started',
      'replacement-tracked:during-replacement',
      'replacement-flushed',
    ]);
  });

  it('setAppender recovers an active replacement after the previous appender retires', async () => {
    const retired = deferred();
    const lifecycle: string[] = [];
    const previous: ITelemetryAppender = {
      track() {},
      async shutdown() {
        lifecycle.push('shutdown-started');
        await retired.promise;
        lifecycle.push('shutdown-finished');
      },
    };
    const replacement: ITelemetryAppender = {
      start() {},
      recover() {
        lifecycle.push('replacement-recovered');
      },
      track() {},
    };
    const svc = new TelemetryService();
    await svc.setAppender(previous);
    svc.addAppender(replacement);

    const replacing = svc.setAppender(replacement);
    await Promise.resolve();

    expect(lifecycle).toEqual(['shutdown-started']);

    retired.resolve();
    await replacing;

    expect(lifecycle).toEqual([
      'shutdown-started',
      'shutdown-finished',
      'replacement-recovered',
    ]);
  });

  it('addAppender rejects an appender after its registration retires it', async () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();
    const registration = svc.addAppender(appender);
    await registration.shutdown();

    expect(() => svc.addAppender(appender)).toThrow(
      'Telemetry appender has already shut down',
    );
  });

  it('setAppender rejects an appender retired by a later replacement', async () => {
    const retired = new CapturingAppender();
    const replacement = new CapturingAppender();
    const svc = new TelemetryService();
    await svc.setAppender(retired);
    await svc.setAppender(replacement);

    await expect(svc.setAppender(retired)).rejects.toThrow(
      'Telemetry appender has already shut down',
    );
  });

  it('setEnabled(false) drops track; setEnabled(true) resumes', () => {
    const appender = new CapturingAppender();
    const svc = telemetryWithAppenders(appender);
    svc.setEnabled(false);
    svc.track('dropped');
    expect(appender.events).toHaveLength(0);
    svc.setEnabled(true);
    svc.track('sent');
    expect(appender.events).toEqual([{ event: 'sent', properties: {} }]);
  });

  it('withContext view follows root enablement changes', () => {
    const appender = new CapturingAppender();
    const root = telemetryWithAppenders(appender);
    const child = root.withContext({ turnId: 't1' });

    root.setEnabled(false);
    child.track('dropped');
    expect(appender.events).toHaveLength(0);

    root.setEnabled(true);
    child.track('sent');
    expect(appender.events).toEqual([{ event: 'sent', properties: { turnId: 't1' } }]);
  });

  it('withContext view follows root appender changes', async () => {
    const root = new TelemetryService();
    const child = root.withContext({ agent_id: 'main' });
    const appender = new CapturingAppender();

    await root.setAppender(appender);
    child.track('sent');

    expect(appender.events).toEqual([{ event: 'sent', properties: { agent_id: 'main' } }]);
  });

  it('flush fans out to every appender', async () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = telemetryWithAppenders(a, b);
    await svc.flush();
    expect(a.flushCalls).toBe(1);
    expect(b.flushCalls).toBe(1);
  });

  it('shutdown fans out to every appender', async () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = telemetryWithAppenders(a, b);
    await svc.shutdown();
    expect(a.shutdownCalls).toBe(1);
    expect(b.shutdownCalls).toBe(1);
  });

  it('shutdown durably retires a replacement accepted during transition', async () => {
    const retired = deferred();
    const lifecycle: string[] = [];
    const previous: ITelemetryAppender = {
      track() {},
      shutdown: () => retired.promise,
    };
    const replacement: ITelemetryAppender = {
      start() {
        lifecycle.push('replacement-started');
      },
      track(event) {
        lifecycle.push(`replacement-tracked:${event}`);
      },
      shutdown() {
        lifecycle.push('replacement-shutdown');
      },
    };
    const svc = new TelemetryService();
    await svc.setAppender(previous);

    const replacing = svc.setAppender(replacement);
    svc.track('before-shutdown');
    const closing = svc.shutdown();
    retired.resolve();

    await Promise.all([replacing, closing]);

    expect(lifecycle).toEqual([
      'replacement-started',
      'replacement-tracked:before-shutdown',
      'replacement-shutdown',
    ]);
  });

  it('shutdown forwards its budget to retirement active during replacement', async () => {
    const retired = deferred();
    const shutdownOptions: Array<TelemetryShutdownOptions | undefined> = [];
    const previous: ITelemetryAppender = {
      track() {},
      shutdown(options) {
        shutdownOptions.push(options);
        options?.signal?.addEventListener('abort', retired.resolve, { once: true });
        return retired.promise;
      },
    };
    const replacement = new CapturingAppender();
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const svc = new TelemetryService();
    await svc.setAppender(previous);

    const replacing = svc.setAppender(replacement);
    await Promise.resolve();
    const closing = svc.shutdown(options);
    await Promise.resolve();

    expect(shutdownOptions).toEqual([undefined, options]);

    controller.abort();
    await Promise.all([replacing, closing]);

    expect(replacement.shutdownOptions).toBe(options);
  });

  it('shutdown forwards one lifecycle budget to every appender', async () => {
    const first = new CapturingAppender();
    const second = new CapturingAppender();
    const svc = telemetryWithAppenders(first, second);
    const options = {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 25,
    };

    await svc.shutdown(options);

    expect(first.shutdownOptions).toBe(options);
    expect(second.shutdownOptions).toBe(options);
  });

  it('repeated shutdown shares and awaits retirement started by disposal', async () => {
    const retired = deferred();
    let shutdownCalls = 0;
    const appender: ITelemetryAppender = {
      track() {},
      shutdown() {
        shutdownCalls += 1;
        return retired.promise;
      },
    };
    const svc = new TelemetryService();
    const registration = svc.addAppender(appender);
    registration.dispose();

    const first = svc.shutdown();
    const second = svc.shutdown();

    expect(second).toBe(first);
    expect(shutdownCalls).toBe(0);
    await Promise.resolve();
    expect(shutdownCalls).toBe(1);

    retired.resolve();
    await first;
  });

  it('service shutdown forwards a lifecycle budget to retirement started by disposal', async () => {
    const retired = deferred();
    const shutdownOptions: Array<TelemetryShutdownOptions | undefined> = [];
    const appender: ITelemetryAppender = {
      track() {},
      shutdown(options) {
        shutdownOptions.push(options);
        return retired.promise;
      },
    };
    const svc = new TelemetryService();
    const registration = svc.addAppender(appender);
    const options = { deadlineMs: 42 };

    registration.dispose();
    await Promise.resolve();
    const closing = svc.shutdown(options);
    await Promise.resolve();

    expect(shutdownOptions).toEqual([undefined, options]);
    retired.resolve();
    await closing;
  });

  it('rejects appenders registered after shutdown begins', async () => {
    const svc = new TelemetryService();
    await svc.shutdown();
    const appender = new CapturingAppender();

    expect(() => {
      svc.addAppender(appender);
    }).toThrow('Telemetry service has already shut down');
    await expect(svc.setAppender(appender)).rejects.toThrow(
      'Telemetry service has already shut down',
    );

    expect(appender.startCalls).toBe(0);
  });

  it('flush is a no-op for appenders without flush', async () => {
    const minimal: ITelemetryAppender = { track() {} };
    const svc = telemetryWithAppenders(minimal);
    await expect(svc.flush()).resolves.toBeUndefined();
    await expect(svc.shutdown()).resolves.toBeUndefined();
  });
});

describe('TelemetryService (error isolation)', () => {
  beforeEach(() => setUnexpectedErrorHandler(() => {}));
  afterEach(() => resetUnexpectedErrorHandler());

  it('a throwing appender does not prevent delivery to other appenders', () => {
    const bad: ITelemetryAppender = {
      track() {
        throw new Error('boom');
      },
    };
    const good = new CapturingAppender();
    const svc = telemetryWithAppenders(bad, good);
    expect(() => svc.track('evt')).not.toThrow();
    expect(good.events).toEqual([{ event: 'evt', properties: {} }]);
  });

  it('a throwing appender start does not prevent other appenders from registering', () => {
    const bad: ITelemetryAppender = {
      start() {
        throw new Error('boom');
      },
      track() {},
    };
    const good = new CapturingAppender();
    const svc = new TelemetryService();

    svc.addAppender(bad);
    svc.addAppender(good);
    svc.track('evt');

    expect(good.events).toEqual([{ event: 'evt', properties: {} }]);
  });

  it('flush tolerates a rejecting appender and still flushes the rest', async () => {
    const bad: ITelemetryAppender = {
      track() {},
      async flush() {
        throw new Error('boom');
      },
    };
    const good = new CapturingAppender();
    const svc = telemetryWithAppenders(bad, good);
    await expect(svc.flush()).resolves.toBeUndefined();
    expect(good.flushCalls).toBe(1);
  });

  it('flush tolerates a synchronously throwing appender and still flushes the rest', async () => {
    const bad: ITelemetryAppender = {
      track() {},
      flush() {
        throw new Error('boom');
      },
    };
    const good = new CapturingAppender();
    const svc = telemetryWithAppenders(bad, good);

    await expect(svc.flush()).resolves.toBeUndefined();

    expect(good.flushCalls).toBe(1);
  });

  it('shutdown tolerates a rejecting appender and still shuts down the rest', async () => {
    const bad: ITelemetryAppender = {
      track() {},
      async shutdown() {
        throw new Error('boom');
      },
    };
    const good = new CapturingAppender();
    const svc = telemetryWithAppenders(bad, good);
    await expect(svc.shutdown()).resolves.toBeUndefined();
    expect(good.shutdownCalls).toBe(1);
  });

  it('shutdown tolerates a synchronously throwing appender and still shuts down the rest', async () => {
    const bad: ITelemetryAppender = {
      track() {},
      shutdown() {
        throw new Error('boom');
      },
    };
    const good = new CapturingAppender();
    const svc = telemetryWithAppenders(bad, good);

    await expect(svc.shutdown()).resolves.toBeUndefined();

    expect(good.shutdownCalls).toBe(1);
  });
});

describe('ITelemetryService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ITelemetryService,
      TelemetryService,
      ScopeActivation.OnScopeCreated,
      'telemetry',
    );
  });

  it('resolves from the App scope', () => {
    const host = createScopedTestHost();
    const svc = host.app.accessor.get(ITelemetryService);
    expect(() => svc.track('scoped')).not.toThrow();
    host.dispose();
  });
});
