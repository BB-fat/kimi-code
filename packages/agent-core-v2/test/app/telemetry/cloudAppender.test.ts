/**
 * `telemetry` domain (L1) — cloud delivery and durable spool coverage.
 *
 * Exercises spool retention and capacity plus appender batching, durable
 * shutdown, startup and replacement-handoff replay, privacy, and wire shape
 * through the real transport and file-storage stack.
 */

import { getEventListeners } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { CloudAppender, type CloudAppenderOptions } from '#/app/telemetry/cloudAppender';
import { CloudTransport, type EnrichedCloudEvent } from '#/app/telemetry/cloudTransport';
import { TelemetryService } from '#/app/telemetry/telemetryService';
import { TelemetrySpoolStore } from '#/app/telemetry/telemetrySpoolStore';

import { stubBootstrap } from '../bootstrap/stubs';

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly body: {
    readonly user_id: string;
    readonly events: readonly Record<string, unknown>[];
  };
}

type Responder = (req: CapturedRequest) => Response | Promise<Response>;

function makeFetch(responder: Responder): typeof fetch {
  return (async (input: unknown, init: unknown) => {
    const requestInit = init as {
      headers: Record<string, string>;
      body: string;
      signal?: AbortSignal;
    };
    const req: CapturedRequest = {
      url: String(input),
      headers: requestInit.headers,
      signal: requestInit.signal,
      body: JSON.parse(requestInit.body) as CapturedRequest['body'],
    };
    return responder(req);
  }) as unknown as typeof fetch;
}

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response(null, { status });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function baseOptions(
  overrides: Partial<CloudAppenderOptions> & {
    homeDir?: string;
    now?: () => number;
    spoolMaxFiles?: number;
  } = {},
): CloudAppenderOptions {
  const { homeDir: dir = '', now, spool, spoolMaxFiles, ...rest } = overrides;
  return {
    spool:
      spool ??
      new TelemetrySpoolStore({
        storage: new FileStorageService(dir),
        maxFiles: spoolMaxFiles,
        now,
      }),
    bootstrap: { ...stubBootstrap(), clientVersion: '1.0.0' },
    deviceId: 'dev',
    appName: 'test-app',
    sleep: async () => {},
    ...rest,
  };
}

function listFailedSpoolFiles(homeDir: string): string[] {
  return readdirSync(join(homeDir, 'telemetry-v2')).filter((file) =>
    file.startsWith('failed_'),
  );
}

function readFirstFailedEvent(homeDir: string): Record<string, unknown> {
  const file = listFailedSpoolFiles(homeDir)[0] as string;
  const persisted = readFileSync(join(homeDir, 'telemetry-v2', file), 'utf8');
  return JSON.parse(persisted.trim()) as Record<string, unknown>;
}

function readAllFailedEvents(homeDir: string): Record<string, unknown>[] {
  return listFailedSpoolFiles(homeDir).flatMap((file) =>
    readFileSync(join(homeDir, 'telemetry-v2', file), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

function spoolEvent(event: string, padding = ''): EnrichedCloudEvent {
  return {
    event_id: `${event}-id`,
    device_id: 'dev',
    session_id: null,
    event,
    timestamp: 1,
    properties: { padding },
    context: {},
  };
}

describe('TelemetrySpoolStore', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'telemetry-spool-store-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('recovery expires entries older than retention while keeping newer entries', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    let now = 0;
    const store = new TelemetrySpoolStore({
      storage: new FileStorageService(homeDir),
      maxFiles: 2,
      now: () => now,
    });

    await store.put([spoolEvent('old')]);
    now = 6 * dayMs;
    await store.put([spoolEvent('new')]);
    now = 8 * dayMs;

    const entries = await store.recoverable(10);

    expect(entries.flatMap((entry) => entry.events).map((event) => event.event)).toEqual([
      'new',
    ]);
  });

  it('put keeps the newest entries when file capacity is exceeded', async () => {
    let now = 0;
    const store = new TelemetrySpoolStore({
      storage: new FileStorageService(homeDir),
      maxFiles: 1,
      now: () => now,
    });

    await store.put([spoolEvent('old')]);
    now = 1;
    await store.put([spoolEvent('new')]);

    const entries = await store.recoverable(10);

    expect(entries.flatMap((entry) => entry.events).map((event) => event.event)).toEqual([
      'new',
    ]);
  });

  it('put keeps only the newest chunk when one batch exceeds byte capacity', async () => {
    const store = new TelemetrySpoolStore({
      storage: new FileStorageService(homeDir),
      maxFiles: 1,
      maxFileBytes: 512,
    });

    await store.put([
      spoolEvent('first', 'x'.repeat(300)),
      spoolEvent('second', 'x'.repeat(300)),
    ]);

    const entries = await store.recoverable(10);

    expect(entries.flatMap((entry) => entry.events).map((event) => event.event)).toEqual([
      'second',
    ]);
  });

  it('put drops an event when its JSONL record exceeds byte capacity', async () => {
    const store = new TelemetrySpoolStore({
      storage: new FileStorageService(homeDir),
      maxFiles: 1,
      maxFileBytes: 128,
    });

    await store.put([spoolEvent('oversized', 'x'.repeat(300))]);

    await expect(store.recoverable(10)).resolves.toEqual([]);
  });
});

describe('CloudAppender', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cloud-appender-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('sends a flattened, prefixed payload with user_id and context', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        deviceId: 'dev123',
        sessionId: 'sess1',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track('tool.call', { name: 'bash', count: 2 });
    await appender.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://telemetry-logs.kimi.com/v1/event');
    expect(requests[0]?.body.user_id).toBe('kfc_device_id_dev123');
    const event = requests[0]?.body.events[0];
    expect(event?.['event']).toBe('kfc_tool.call');
    expect(event?.['device_id']).toBe('dev123');
    expect(event?.['session_id']).toBe('sess1');
    expect(event?.['property_name']).toBe('bash');
    expect(event?.['property_count']).toBe(2);
    expect(event?.['context_app_name']).toBe('test-app');
    expect(event?.['context_client_version']).toBe('1.0.0');
    expect(event?.['context_version']).toBe('1.0.0');
    expect(typeof event?.['context_core_version']).toBe('string');
    expect(typeof event?.['event_id']).toBe('string');
    expect(typeof event?.['timestamp']).toBe('number');
  });

  it('applies setContext sessionId and model updates to subsequent events', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        deviceId: 'dev123',
        model: 'initial-model',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.setContext({ sessionId: 'sess42', model: 'switched-model' });
    appender.track('turn_started', {});
    await appender.flush();

    const event = requests[0]?.body.events[0];
    expect(event?.['session_id']).toBe('sess42');
    expect(event?.['context_model']).toBe('switched-model');
  });

  it('uses the event sessionId for top-level session_id when it differs from appender context', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        sessionId: 'default-session',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track('evt', { sessionId: 'event-session' });
    await appender.flush();

    expect(requests[0]?.body.events[0]?.['session_id']).toBe('event-session');
  });

  it('sends Authorization header when a token is provided', async () => {
    const requests: CapturedRequest[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        getAccessToken: () => 'tok123',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    appender.track('evt');
    await appender.flush();

    expect(requests[0]?.headers['Authorization']).toBe('Bearer tok123');
  });

  it('auto-flushes when the buffer reaches the threshold', async () => {
    let sends = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        flushThreshold: 3,
        fetchImpl: makeFetch(() => {
          sends += 1;
          return okResponse();
        }),
      }),
    );

    appender.track('e1');
    appender.track('e2');
    expect(sends).toBe(0);
    appender.track('e3');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toBe(1);
  });

  it('shutdown flushes the remaining buffered events', async () => {
    let sends = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          sends += 1;
          return okResponse();
        }),
      }),
    );

    appender.track('e1');
    await appender.shutdown();
    expect(sends).toBe(1);
  });

  it('shutdown returns the original lifecycle promise when called repeatedly', async () => {
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => okResponse()),
      }),
    );
    appender.track('once');

    const first = appender.shutdown();
    const second = appender.shutdown();

    expect(second).toBe(first);
    await first;
  });

  it('a later shutdown cancellation tightens an active lifecycle', async () => {
    const requestStarted = deferred<void>();
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          requestStarted.resolve();
          return new Promise<Response>(() => {});
        }),
      }),
    );
    const cancellation = new AbortController();
    appender.track('cancelled_by_later_caller');

    const first = appender.shutdown();
    await requestStarted.promise;
    const second = appender.shutdown({ signal: cancellation.signal });
    cancellation.abort();
    await second;

    expect(second).toBe(first);
    const files = listFailedSpoolFiles(homeDir);
    expect(files).toHaveLength(1);
  });

  it('track drops events after shutdown begins', async () => {
    let requests = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          requests += 1;
          return okResponse();
        }),
      }),
    );

    await appender.shutdown();
    appender.track('too_late');
    await appender.flush();

    expect(requests).toBe(0);
  });

  it('flush drains events tracked while an earlier batch is in flight', async () => {
    const firstResponse = deferred<Response>();
    const firstRequestStarted = deferred<void>();
    const batches: string[][] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch((request) => {
          batches.push(request.body.events.map((event) => String(event['event'])));
          if (batches.length === 1) {
            firstRequestStarted.resolve();
            return firstResponse.promise;
          }
          return okResponse();
        }),
      }),
    );

    appender.track('first');
    const flushing = appender.flush();
    await firstRequestStarted.promise;
    appender.track('second');
    firstResponse.resolve(okResponse());
    await flushing;

    expect(batches).toEqual([['kfc_first'], ['kfc_second']]);
  });

  it('concurrent flush calls share ownership of one batch', async () => {
    const response = deferred<Response>();
    const requestStarted = deferred<void>();
    let requests = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          requests += 1;
          requestStarted.resolve();
          return response.promise;
        }),
      }),
    );
    appender.track('once');

    const first = appender.flush();
    await requestStarted.promise;
    const second = appender.flush();
    response.resolve(okResponse());
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(requests).toBe(1);
  });

  it('shutdown persists a threshold batch already in flight when cancellation fires', async () => {
    const requestStarted = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        flushThreshold: 1,
        fetchImpl: makeFetch((request) => {
          requestSignal = request.signal;
          requestStarted.resolve();
          return new Promise<Response>(() => {});
        }),
      }),
    );
    const cancellation = new AbortController();

    appender.track('threshold_in_flight');
    await requestStarted.promise;
    const closing = appender.shutdown({ signal: cancellation.signal });
    cancellation.abort();
    await closing;

    expect(requestSignal?.aborted).toBe(true);
    const files = listFailedSpoolFiles(homeDir);
    expect(files).toHaveLength(1);
    expect(readFirstFailedEvent(homeDir)).toMatchObject({
      event: 'threshold_in_flight',
    });
  });

  it('shutdown persists buffered events when its absolute deadline has elapsed', async () => {
    let requests = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          requests += 1;
          return okResponse();
        }),
      }),
    );

    appender.track('deadline_elapsed');
    await appender.shutdown({ deadlineMs: Date.now() - 1 });

    expect(requests).toBe(0);
    const files = listFailedSpoolFiles(homeDir);
    expect(files).toHaveLength(1);
    expect(readFirstFailedEvent(homeDir)).toMatchObject({ event: 'deadline_elapsed' });
  });

  it('retries on 5xx and saves to disk after exhausting backoffs', async () => {
    let attempts = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          attempts += 1;
          return statusResponse(500);
        }),
      }),
    );

    appender.track('evt');
    await appender.flush();

    expect(attempts).toBe(4);
    const files = listFailedSpoolFiles(homeDir);
    expect(files).toHaveLength(1);
  });

  it('releases lifecycle abort listeners after a retry backoff completes', async () => {
    let attempts = 0;
    const transport = new CloudTransport({
      deviceId: 'dev',
      retryBackoffsMs: [0],
      fetchImpl: makeFetch(() => {
        attempts += 1;
        return attempts === 1 ? statusResponse(500) : okResponse();
      }),
    });
    const lifecycle = new AbortController();

    await transport.send(
      [
        {
          event_id: 'event-1',
          device_id: 'dev',
          session_id: null,
          event: 'retry_listener_cleanup',
          timestamp: 1,
          properties: {},
          context: {},
        },
      ],
      lifecycle.signal,
    );

    expect(attempts).toBe(2);
    expect(getEventListeners(lifecycle.signal, 'abort')).toHaveLength(0);
  });

  it('shutdown cancellation interrupts token lookup and durably hands off the batch', async () => {
    const token = deferred<string | null>();
    const tokenStarted = deferred<void>();
    let requests = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        getAccessToken: () => {
          tokenStarted.resolve();
          return token.promise;
        },
        fetchImpl: makeFetch(() => {
          requests += 1;
          return okResponse();
        }),
      }),
    );
    const cancellation = new AbortController();
    appender.track('token_lookup_cancelled');

    const closing = appender.shutdown({ signal: cancellation.signal });
    await tokenStarted.promise;
    cancellation.abort();
    await closing;
    token.resolve(null);

    expect(requests).toBe(0);
    const persisted = readFirstFailedEvent(homeDir);
    expect(persisted).toMatchObject({
      event: 'token_lookup_cancelled',
    });

    let replayedEventId: unknown;
    const restartedAppender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch((request) => {
          replayedEventId = request.body.events[0]?.['event_id'];
          return okResponse();
        }),
      }),
    );
    restartedAppender.start();
    await restartedAppender.shutdown();

    expect(replayedEventId).toBe(persisted['event_id']);
  });

  it('shutdown cancellation interrupts retry sleep and durably hands off the batch', async () => {
    const sleepStarted = deferred<void>();
    const sleep = deferred<void>();
    let attempts = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          attempts += 1;
          return statusResponse(500);
        }),
        sleep: () => {
          sleepStarted.resolve();
          return sleep.promise;
        },
      }),
    );
    const cancellation = new AbortController();
    appender.track('retry_sleep_cancelled');

    const closing = appender.shutdown({ signal: cancellation.signal });
    await sleepStarted.promise;
    cancellation.abort();
    await closing;
    sleep.resolve();

    expect(attempts).toBe(1);
    expect(readFirstFailedEvent(homeDir)).toMatchObject({
      event: 'retry_sleep_cancelled',
    });
  });

  it('retries a 401 once without the Authorization header', async () => {
    const seenAuths: (string | undefined)[] = [];
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        getAccessToken: () => 'tok',
        fetchImpl: makeFetch((req) => {
          seenAuths.push(req.headers['Authorization']);
          if (req.headers['Authorization'] !== undefined) {
            return statusResponse(401);
          }
          return okResponse();
        }),
      }),
    );

    appender.track('evt');
    await appender.flush();

    expect(seenAuths).toEqual(['Bearer tok', undefined]);
  });

  it('retryDiskEvents resends saved events and removes the file on success', async () => {
    let shouldFail = true;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => (shouldFail ? statusResponse(500) : okResponse())),
      }),
    );

    appender.track('evt');
    await appender.flush();
    expect(listFailedSpoolFiles(homeDir)).toHaveLength(1);

    shouldFail = false;
    await appender.retryDiskEvents();
    expect(listFailedSpoolFiles(homeDir)).toHaveLength(0);
  });

  it('start replays recoverable events left by an earlier appender', async () => {
    const failingAppender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => statusResponse(500)),
      }),
    );
    failingAppender.track('persisted_before_restart');
    await failingAppender.flush();
    expect(listFailedSpoolFiles(homeDir)).toHaveLength(1);

    let replayed = 0;
    const restartedAppender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          replayed += 1;
          return okResponse();
        }),
      }),
    );

    restartedAppender.start();
    await restartedAppender.shutdown();

    expect(replayed).toBe(1);
    expect(listFailedSpoolFiles(homeDir)).toHaveLength(0);
  });

  it('setAppender replays events persisted while the previous appender retires', async () => {
    const previous = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => statusResponse(500)),
      }),
    );
    const replayed: string[] = [];
    const replacement = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch((request) => {
          replayed.push(String(request.body.events[0]?.['event']));
          return okResponse();
        }),
      }),
    );
    const service = new TelemetryService();
    await service.setAppender(previous);
    service.track('handoff');

    await service.setAppender(replacement);
    await replacement.flush();

    expect(replayed).toEqual(['kfc_handoff']);
    expect(listFailedSpoolFiles(homeDir)).toHaveLength(0);
  });

  it('setAppender recovers durable events when the replacement is already active', async () => {
    const previous = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => statusResponse(500)),
      }),
    );
    const replayed: string[] = [];
    const replacement = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch((request) => {
          replayed.push(String(request.body.events[0]?.['event']));
          return okResponse();
        }),
      }),
    );
    const service = new TelemetryService();
    await service.setAppender(previous);
    service.addAppender(replacement);
    await replacement.flush();
    previous.track('active_handoff');

    await service.setAppender(replacement);

    expect(replayed).toEqual(['kfc_active_handoff']);
    expect(listFailedSpoolFiles(homeDir)).toHaveLength(0);
  });

  it('flush joins startup replay even when no live events are buffered', async () => {
    const failingAppender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => statusResponse(500)),
      }),
    );
    failingAppender.track('persisted_before_flush');
    await failingAppender.flush();

    const replayStarted = deferred<void>();
    const replayResponse = deferred<Response>();
    const restartedAppender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          replayStarted.resolve();
          return replayResponse.promise;
        }),
      }),
    );
    restartedAppender.start();

    const settled = vi.fn();
    const flushing = restartedAppender.flush().then(settled);
    await replayStarted.promise;
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();

    replayResponse.resolve(okResponse());
    await flushing;
    expect(listFailedSpoolFiles(homeDir)).toHaveLength(0);
  });

  it('startup replay limits the number of recovered files in one lifecycle', async () => {
    let now = 1;
    const failingAppender = new CloudAppender(
      baseOptions({
        homeDir,
        now: () => now++,
        spoolMaxFiles: 10,
        fetchImpl: makeFetch(() => statusResponse(500)),
      }),
    );
    for (const event of ['first', 'second', 'third']) {
      failingAppender.track(event);
      await failingAppender.flush();
    }

    const replayed: string[] = [];
    const restartedAppender = new CloudAppender(
      baseOptions({
        homeDir,
        now: () => now,
        replayMaxFiles: 1,
        spoolMaxFiles: 10,
        fetchImpl: makeFetch((request) => {
          replayed.push(String(request.body.events[0]?.['event']));
          return okResponse();
        }),
      }),
    );

    restartedAppender.start();
    restartedAppender.track('live_after_backlog');
    await restartedAppender.shutdown();

    expect(replayed).toEqual(['kfc_first']);
    expect(listFailedSpoolFiles(homeDir)).toHaveLength(3);
    expect(readAllFailedEvents(homeDir).map((event) => event['event'])).toContain(
      'live_after_backlog',
    );
  });

  it('keeps the newest durable batches when the spool reaches its file cap', async () => {
    let now = 1;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        now: () => now++,
        spoolMaxFiles: 2,
        fetchImpl: makeFetch(() => statusResponse(500)),
      }),
    );

    for (const event of ['first', 'second', 'third']) {
      appender.track(event);
      await appender.flush();
    }

    expect(listFailedSpoolFiles(homeDir)).toHaveLength(2);
    expect(
      readAllFailedEvents(homeDir)
        .map((event) => event['event'])
        .toSorted(),
    ).toEqual(['second', 'third']);
  });

  it('start leaves legacy telemetry spool files for their owning pipeline', async () => {
    const telemetryDir = join(homeDir, 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    const legacyFile = 'failed_abcdef123456.jsonl';
    writeFileSync(join(telemetryDir, legacyFile), '{"event":"legacy"}\n');
    let requests = 0;
    const appender = new CloudAppender(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          requests += 1;
          return okResponse();
        }),
      }),
    );

    appender.start();
    await appender.shutdown();

    expect(requests).toBe(0);
    expect(readdirSync(telemetryDir)).toContain(legacyFile);
  });

  it('drops non-primitive properties and reports the violation', async () => {
    const errors: unknown[] = [];
    setUnexpectedErrorHandler((err) => errors.push(err));
    try {
      const requests: CapturedRequest[] = [];
      const appender = new CloudAppender(
        baseOptions({
          homeDir,
          fetchImpl: makeFetch((req) => {
            requests.push(req);
            return okResponse();
          }),
        }),
      );

      appender.track('evt', { ok: 'yes', bad: { nested: true } as unknown as string });
      await appender.flush();

      const event = requests[0]?.body.events[0];
      expect(event?.['property_ok']).toBe('yes');
      expect(event?.['property_bad']).toBeUndefined();
      expect(errors).toHaveLength(1);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});
