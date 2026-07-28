/**
 * `telemetry` domain (L1) — telemetry facade lifecycle coverage.
 *
 * Exercises appender fan-out, context views, error isolation, lifecycle-option
 * forwarding, and App-scope registration through `ITelemetryService`.
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
  const [first, ...rest] = appenders;
  if (first !== undefined) {
    void svc.setAppender(first);
  }
  for (const appender of rest) {
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

  it('merges bound context into tracked properties', () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();
    void svc.setAppender(appender);
    svc.setContext({ sessionId: 's1' });
    svc.track('turn.start', { agentId: 'main' });
    expect(appender.events[0]).toEqual({
      event: 'turn.start',
      properties: { sessionId: 's1', agentId: 'main' },
    });
  });

  it('withContext merges context and shares the appender', () => {
    const appender = new CapturingAppender();
    const root = new TelemetryService();
    void root.setAppender(appender);
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

  it('per-call properties override bound context on key collision', () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();
    void svc.setAppender(appender);
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

  it('setAppender starts the replacement appender', () => {
    const appender = new CapturingAppender();
    const svc = new TelemetryService();

    void svc.setAppender(appender);

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

  it('withContext view follows root appender changes', () => {
    const root = new TelemetryService();
    const child = root.withContext({ agent_id: 'main' });
    const appender = new CapturingAppender();

    void root.setAppender(appender);
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
