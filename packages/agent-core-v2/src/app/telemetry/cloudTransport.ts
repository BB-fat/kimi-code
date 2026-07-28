/**
 * `telemetry` domain (L1) — HTTP delivery transport behind `CloudAppender`.
 *
 * Owns authentication, request deadlines, retry, and telemetry wire shaping.
 * Durable handoff and recovery are coordinated by `CloudAppender` through its
 * spool store. App-scoped; independent of `@moonshot-ai/kimi-telemetry`.
 */

import {
  abortable,
  abortError,
  createDeadlineAbortSignal,
  isAbortError,
} from '#/_base/utils/abort';

export type CloudPrimitive = boolean | number | string | undefined | null;

export type CloudProperties = Record<string, CloudPrimitive>;

export type CloudContext = Record<string, CloudPrimitive>;

export interface CloudEvent {
  readonly event_id: string;
  device_id: string | null;
  session_id: string | null;
  readonly event: string;
  readonly timestamp: number;
  readonly properties: CloudProperties;
}

export interface EnrichedCloudEvent extends CloudEvent {
  readonly context: CloudContext;
}

export interface CloudPayload {
  readonly user_id: string;
  readonly events: readonly Record<string, CloudPrimitive>[];
}

export interface CloudTransportOptions {
  readonly deviceId: string;
  readonly endpoint?: string;
  readonly getAccessToken?: () => string | null | Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly retryBackoffsMs?: readonly number[];
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const TELEMETRY_ENDPOINT = 'https://telemetry-logs.kimi.com/v1/event';
export const SERVER_EVENT_PREFIX = 'kfc_';
export const USER_ID_PREFIX = 'kfc_device_id_';
export const RETRY_BACKOFFS_MS = [1_000, 4_000, 16_000] as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class CloudTransport {
  private readonly deviceId: string;
  private readonly endpoint: string;
  private readonly getAccessToken: (() => string | null | Promise<string | null>) | null;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffsMs: readonly number[];
  private readonly requestTimeoutMs: number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: CloudTransportOptions) {
    this.deviceId = options.deviceId;
    this.endpoint = options.endpoint ?? TELEMETRY_ENDPOINT;
    this.getAccessToken = options.getAccessToken ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryBackoffsMs = options.retryBackoffsMs ?? RETRY_BACKOFFS_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleepImpl = options.sleep ?? abortableSleep;
  }

  async send(
    events: readonly EnrichedCloudEvent[],
    signal?: AbortSignal,
    retryBackoffsMs: readonly number[] = this.retryBackoffsMs,
  ): Promise<void> {
    if (events.length === 0) return;
    if (signal?.aborted === true) throw abortError();

    let payload: CloudPayload;
    try {
      payload = buildPayload(events, this.deviceId);
    } catch {
      return;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= retryBackoffsMs.length; attempt++) {
      try {
        await this.sendAttempt(payload, signal);
        return;
      } catch (error) {
        if (isSignalAborted(signal) || (isAbortError(error) && !(error instanceof TransientCloudError))) {
          throw error;
        }
        lastError = error;
        if (!(error instanceof TransientCloudError)) break;
        const backoff = retryBackoffsMs[attempt];
        if (backoff === undefined) break;
        const sleep = Promise.resolve().then(() => this.sleepImpl(backoff, signal));
        try {
          await (signal === undefined ? sleep : abortable(sleep, signal));
        } catch (sleepError) {
          if (isSignalAborted(signal) || isAbortError(sleepError)) throw sleepError;
          lastError = sleepError;
          break;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new TransientCloudError('telemetry delivery failed');
  }

  private async sendAttempt(payload: CloudPayload, signal?: AbortSignal): Promise<void> {
    const source = signal ?? new AbortController().signal;
    const deadline = createDeadlineAbortSignal(source, this.requestTimeoutMs);
    try {
      await this.sendHttp(payload, deadline.signal);
    } catch (error) {
      if (deadline.timedOut()) throw new TransientCloudError('telemetry request timed out');
      throw error;
    } finally {
      deadline.clear();
    }
  }

  private async sendHttp(payload: CloudPayload, signal: AbortSignal): Promise<void> {
    const tokenRequest =
      this.getAccessToken === null
        ? Promise.resolve(null)
        : Promise.resolve().then(() => this.getAccessToken?.() ?? null);
    const token = await abortable(tokenRequest, signal);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token !== null && token.length > 0) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await this.post(payload, headers, signal);
    if (response.status === 401 && headers['Authorization'] !== undefined) {
      delete headers['Authorization'];
      const retry = await this.post(payload, headers, signal);
      handleStatus(retry.status);
      return;
    }
    handleStatus(response.status);
  }

  private async post(
    payload: CloudPayload,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      const request = Promise.resolve().then(() =>
        this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { ...headers },
          body: JSON.stringify(payload),
          signal,
        }),
      );
      return await abortable(request, signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      throw new TransientCloudError(String(error));
    }
  }
}

export class TransientCloudError extends Error {
  override readonly name = 'TransientCloudError';
}

export function buildUserId(deviceId: string): string {
  return USER_ID_PREFIX + deviceId;
}

export function buildPayload(
  events: readonly EnrichedCloudEvent[],
  deviceId: string,
): CloudPayload {
  return {
    user_id: buildUserId(deviceId),
    events: events.map((event) => flattenEvent(applyServerPrefix(event))),
  };
}

export function applyServerPrefix(event: EnrichedCloudEvent): EnrichedCloudEvent {
  const name: unknown = event.event;
  if (typeof name !== 'string' || name.length === 0 || name.startsWith(SERVER_EVENT_PREFIX)) {
    return event;
  }
  return { ...event, event: SERVER_EVENT_PREFIX + name };
}

export function flattenEvent(event: EnrichedCloudEvent): Record<string, CloudPrimitive> {
  const out: Record<string, CloudPrimitive> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'properties') {
      flattenNested(out, 'property', value);
    } else if (key === 'context') {
      flattenNested(out, 'context', value);
    } else {
      assertPrimitive(key, value);
      out[key] = value;
    }
  }
  return out;
}

export function isCloudPrimitive(value: unknown): value is CloudPrimitive {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  );
}

function flattenNested(target: Record<string, CloudPrimitive>, prefix: string, value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, nestedValue] of Object.entries(value)) {
    assertPrimitive(`${prefix}.${key}`, nestedValue);
    target[`${prefix}_${key}`] = nestedValue;
  }
}

function assertPrimitive(key: string, value: unknown): asserts value is CloudPrimitive {
  if (isCloudPrimitive(value)) return;
  throw new TypeError(`telemetry ${key} must be primitive`);
}

function handleStatus(status: number): void {
  if (status >= 500 || status === 429) {
    throw new TransientCloudError(`HTTP ${String(status)}`);
  }
  if (status >= 400) return;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
