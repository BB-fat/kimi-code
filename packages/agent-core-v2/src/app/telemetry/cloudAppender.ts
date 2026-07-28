/**
 * `telemetry` domain (L1) — `CloudAppender`, an `ITelemetryAppender` that
 * batches events, drops non-primitive properties, redacts PII from string
 * values, enriches events with common context, and posts them to the
 * telemetry endpoint through `CloudTransport`, with durable handoff owned by
 * the telemetry spool store, assembled over the `storage` byte layer. Reads
 * host facts (`clientVersion`, env, platform/arch) from `IBootstrapService`;
 * `createCloudAppender` assembles one from a `ServicesAccessor` so hosts only
 * supply identity facts. Owns periodic flush, startup spool replay, and
 * deadline-aware durable shutdown. App-scoped; independent of
 * `@moonshot-ai/kimi-telemetry`.
 */

import { randomUUID } from 'node:crypto';
import { release } from 'node:os';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { abortError, createDeadlineAbortSignal, isAbortError } from '#/_base/utils/abort';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import type {
  ITelemetryAppender,
  TelemetryContextPatch,
  TelemetryProperties,
  TelemetryShutdownOptions,
} from './telemetry';
import {
  type CloudContext,
  type CloudPrimitive,
  type CloudProperties,
  CloudTransport,
  type EnrichedCloudEvent,
  isCloudPrimitive,
} from './cloudTransport';
import { resolveCoreVersion } from './coreVersion';
import { cleanTelemetryProperties } from './privacy';
import { type ITelemetrySpoolStore, TelemetrySpoolStore } from './telemetrySpoolStore';

export interface CloudAppenderOptions {
  readonly spool: ITelemetrySpoolStore;
  readonly bootstrap: IBootstrapService;
  readonly deviceId: string;
  readonly sessionId?: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly terminal?: string;
  readonly locale?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
  readonly endpoint?: string;
  readonly flushThreshold?: number;
  readonly flushIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retryBackoffsMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly replayMaxFiles?: number;
  readonly replayTimeoutMs?: number;
}

export interface CloudAppenderHostOptions {
  readonly deviceId: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly buildSha?: string;
  readonly sessionId?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
}

export function createCloudAppender(
  accessor: ServicesAccessor,
  host: CloudAppenderHostOptions,
): CloudAppender {
  return new CloudAppender({
    spool: new TelemetrySpoolStore({
      storage: accessor.get(IFileSystemStorageService),
    }),
    bootstrap: accessor.get(IBootstrapService),
    ...host,
  });
}

const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_REPLAY_MAX_FILES = 20;
const DEFAULT_REPLAY_TIMEOUT_MS = 5_000;

export class CloudAppender implements ITelemetryAppender {
  private readonly transport: CloudTransport;
  private readonly spool: ITelemetrySpoolStore;
  private readonly context: CloudContext;
  private readonly flushThreshold: number;
  private readonly flushIntervalMs: number;
  private readonly replayMaxFiles: number;
  private readonly replayTimeoutMs: number;
  private deviceId: string;
  private sessionId: string | null;
  private buffer: EnrichedCloudEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lifecycleController = new AbortController();
  private acceptingEvents = true;
  private started = false;
  private replayPending = false;
  private replayPromise: Promise<boolean> | null = null;
  private flushPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: CloudAppenderOptions) {
    this.deviceId = options.deviceId;
    this.sessionId = options.sessionId ?? null;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.replayMaxFiles = Math.max(0, Math.floor(options.replayMaxFiles ?? DEFAULT_REPLAY_MAX_FILES));
    this.replayTimeoutMs = Math.max(0, options.replayTimeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS);
    this.spool = options.spool;
    this.context = buildContext(options);
    this.transport = new CloudTransport({
      deviceId: options.deviceId,
      endpoint: options.endpoint,
      getAccessToken: options.getAccessToken,
      fetchImpl: options.fetchImpl,
      retryBackoffsMs: options.retryBackoffsMs,
      requestTimeoutMs: options.requestTimeoutMs,
      sleep: options.sleep,
    });
  }

  track(event: string, properties?: TelemetryProperties): void {
    if (!this.acceptingEvents) return;
    const eventSessionId = properties?.['sessionId'];
    const enriched: EnrichedCloudEvent = {
      event_id: randomUUID().replaceAll('-', ''),
      device_id: this.deviceId,
      session_id: typeof eventSessionId === 'string' ? eventSessionId : this.sessionId,
      event,
      timestamp: Date.now() / 1000,
      properties: cleanTelemetryProperties(sanitizeProperties(properties)),
      context: { ...this.context },
    };
    this.buffer.push(enriched);
    if (this.buffer.length >= this.flushThreshold) {
      void this.flush().catch(() => {});
    }
  }

  setContext(patch: TelemetryContextPatch): void {
    const deviceId = patch['deviceId'];
    if (typeof deviceId === 'string') {
      this.deviceId = deviceId;
    }
    const sessionId = patch['sessionId'];
    if (typeof sessionId === 'string') {
      this.sessionId = sessionId;
    }
    const model = patch['model'];
    if (typeof model === 'string') {
      setPrimitive(this.context, 'model', model);
    }
  }

  flush(): Promise<void> {
    if (this.flushPromise !== null) return this.flushPromise;
    if (this.buffer.length === 0 && !this.replayPending && this.replayPromise === null) {
      return Promise.resolve();
    }
    const flush = this.drainBuffer();
    this.flushPromise = flush;
    void flush.then(
      () => {
        this.clearFlush(flush);
      },
      () => {
        this.clearFlush(flush);
      },
    );
    return flush;
  }

  shutdown(options: TelemetryShutdownOptions = {}): Promise<void> {
    const clearDeadline = this.armShutdownDeadline(options);
    if (this.shutdownPromise === null) {
      this.acceptingEvents = false;
      this.stopPeriodicFlush();
      this.shutdownPromise = this.shutdownOwnedWork();
    }
    const shutdown = this.shutdownPromise;
    void shutdown.then(clearDeadline, clearDeadline);
    return shutdown;
  }

  start(): void {
    if (this.started || !this.acceptingEvents) return;
    this.started = true;
    this.replayPending = true;
    void this.ensureReplay();
    this.startPeriodicFlush();
  }

  startPeriodicFlush(): void {
    if (!this.acceptingEvents || this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer === null) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  recover(): Promise<void> {
    return this.retryDiskEvents();
  }

  async retryDiskEvents(): Promise<void> {
    const replay = this.replayPromise;
    if (replay !== null) await replay;
    this.replayPending = true;
    await this.ensureReplay();
  }

  private async drainBuffer(): Promise<void> {
    if (!(await this.ensureReplay())) {
      await this.handoffBufferedEvents();
      return;
    }
    while (this.buffer.length > 0) {
      const events = this.buffer;
      this.buffer = [];
      try {
        await this.transport.send(events, this.lifecycleController.signal);
      } catch {
        await this.handoffEvents(events);
      }
    }
  }

  private clearFlush(flush: Promise<void>): void {
    if (this.flushPromise === flush) this.flushPromise = null;
  }

  private async shutdownOwnedWork(): Promise<void> {
    await this.flush();
  }

  private ensureReplay(): Promise<boolean> {
    if (!this.replayPending) return Promise.resolve(true);
    if (this.replayPromise !== null) return this.replayPromise;
    const replay = this.replayDiskEvents(this.lifecycleController.signal).catch(() => false);
    this.replayPromise = replay;
    void replay.then((complete) => {
      this.replayPending = !complete;
      if (this.replayPromise === replay) this.replayPromise = null;
    });
    return replay;
  }

  private async handoffBufferedEvents(): Promise<void> {
    while (this.buffer.length > 0) {
      const events = this.buffer;
      this.buffer = [];
      await this.handoffEvents(events);
    }
  }

  private async handoffEvents(events: readonly EnrichedCloudEvent[]): Promise<void> {
    try {
      await this.spool.put(events);
    } catch (storageError) {
      this.buffer = [...events, ...this.buffer];
      throw storageError;
    }
  }

  private async replayDiskEvents(signal: AbortSignal): Promise<boolean> {
    const deadline = createDeadlineAbortSignal(signal, this.replayTimeoutMs);
    try {
      const entries = await this.spool.recoverable(this.replayMaxFiles + 1);
      let complete = entries.length <= this.replayMaxFiles;
      for (const entry of entries.slice(0, this.replayMaxFiles)) {
        if (deadline.signal.aborted) {
          complete = false;
          break;
        }
        try {
          await this.transport.send(entry.events, deadline.signal, []);
          await this.spool.acknowledge(entry.key);
        } catch (error) {
          complete = false;
          if (deadline.signal.aborted || isAbortError(error)) break;
        }
      }
      return complete && !deadline.signal.aborted;
    } finally {
      deadline.clear();
    }
  }

  private armShutdownDeadline(options: TelemetryShutdownOptions): () => void {
    const abort = (): void => {
      if (!this.lifecycleController.signal.aborted) {
        this.lifecycleController.abort(abortError('Telemetry shutdown deadline reached'));
      }
    };
    const signal = options.signal;
    if (signal?.aborted === true) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (options.deadlineMs !== undefined) {
      const remainingMs = options.deadlineMs - Date.now();
      if (remainingMs <= 0) {
        abort();
      } else {
        timeout = setTimeout(abort, remainingMs);
      }
    }
    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
  }
}

function sanitizeProperties(input?: TelemetryProperties): CloudProperties {
  const out: CloudProperties = {};
  if (input === undefined) return out;
  for (const [key, value] of Object.entries(input)) {
    if (isCloudPrimitive(value)) {
      out[key] = value;
    } else {
      onUnexpectedError(
        new Error(`telemetry property "${key}" is not a primitive and was dropped`),
      );
    }
  }
  return out;
}

function buildContext(options: CloudAppenderOptions): CloudContext {
  const { bootstrap } = options;
  const context: CloudContext = {
    app_name: options.appName,
    client_version: bootstrap.clientVersion,
    version: bootstrap.clientVersion,
    core_version: resolveCoreVersion(),
    runtime: 'node',
    platform: bootstrap.platform,
    arch: bootstrap.arch,
    node_version: process.versions.node,
    os_version: release(),
    ci: bootstrap.getEnv('CI') !== undefined,
    locale: options.locale ?? bootstrap.getEnv('LANG') ?? '',
    terminal: options.terminal ?? bootstrap.getEnv('TERM_PROGRAM') ?? '',
    ui_mode: options.uiMode ?? 'shell',
  };
  setPrimitive(context, 'model', options.model);
  setPrimitive(context, 'build_sha', options.buildSha);
  return context;
}

function setPrimitive(target: CloudContext, key: string, value: CloudPrimitive): void {
  if (value === undefined) return;
  if (typeof value === 'string' && value.length === 0) return;
  target[key] = value;
}
