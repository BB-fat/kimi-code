/**
 * `telemetry` domain (L1) — durable failed-delivery spool access-pattern store.
 *
 * Owns the telemetry namespace, JSONL wire format, retention, capacity, and
 * acknowledgement protocol over the `storage` byte layer. App-scoped and
 * assembled privately by `CloudAppender`.
 */

import { randomBytes } from 'node:crypto';

import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import type { EnrichedCloudEvent } from './cloudTransport';

export interface TelemetrySpoolEntry {
  readonly key: string;
  readonly events: readonly EnrichedCloudEvent[];
}

export interface ITelemetrySpoolStore {
  put(events: readonly EnrichedCloudEvent[]): Promise<void>;
  recoverable(limit: number): Promise<readonly TelemetrySpoolEntry[]>;
  acknowledge(key: string): Promise<void>;
}

export interface TelemetrySpoolStoreOptions {
  readonly storage: IFileSystemStorageService;
  readonly maxFiles?: number;
  readonly now?: () => number;
}

export const TELEMETRY_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const TELEMETRY_SPOOL_MAX_FILES = 256;

const TELEMETRY_SCOPE = 'telemetry-v2';
const FAILED_PREFIX = 'failed_';
const JSONL_SUFFIX = '.jsonl';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class TelemetrySpoolStore implements ITelemetrySpoolStore {
  private readonly storage: IFileSystemStorageService;
  private readonly maxFiles: number;
  private readonly now: () => number;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: TelemetrySpoolStoreOptions) {
    this.storage = options.storage;
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? TELEMETRY_SPOOL_MAX_FILES));
    this.now = options.now ?? Date.now;
  }

  put(events: readonly EnrichedCloudEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    const pending = this.writes.then(() => this.putOwned(events));
    this.writes = pending.catch(() => undefined);
    return pending;
  }

  async recoverable(limit: number): Promise<readonly TelemetrySpoolEntry[]> {
    await this.writes;
    const files = await this.enforcePolicy();
    const entries: TelemetrySpoolEntry[] = [];
    const boundedLimit = Math.max(0, Math.floor(limit));
    for (const file of files) {
      if (entries.length >= boundedLimit) break;
      try {
        entries.push({ key: file.key, events: await this.readJsonl(file.key) });
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) {
          await this.acknowledge(file.key).catch(() => undefined);
          continue;
        }
        throw error;
      }
    }
    return entries;
  }

  acknowledge(key: string): Promise<void> {
    return this.storage.delete(TELEMETRY_SCOPE, key);
  }

  private async enforcePolicy(): Promise<readonly SpoolFile[]> {
    const keys = await this.storage.list(TELEMETRY_SCOPE, FAILED_PREFIX);
    const now = this.now();
    const files: SpoolFile[] = [];
    const discarded: string[] = [];
    for (const key of keys) {
      const createdAt = parseCreatedAt(key);
      if (createdAt === undefined || now - createdAt > TELEMETRY_SPOOL_MAX_AGE_MS) {
        discarded.push(key);
      } else {
        files.push({ key, createdAt });
      }
    }
    files.sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
    await Promise.all(discarded.map((key) => this.acknowledge(key).catch(() => undefined)));
    return files;
  }

  private async putOwned(events: readonly EnrichedCloudEvent[]): Promise<void> {
    const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    const files = await this.enforcePolicy().catch(() => []);
    if (files.length < this.maxFiles) {
      await this.storage.write(TELEMETRY_SCOPE, this.createKey(), textEncoder.encode(text), {
        atomic: true,
      });
      return;
    }

    const compactedCount = files.length - this.maxFiles + 1;
    const compacted = files.slice(0, compactedCount);
    const existing = await Promise.all(
      compacted.map(async (file) => {
        const bytes = await this.storage.read(TELEMETRY_SCOPE, file.key);
        if (bytes === undefined) return '';
        const jsonl = textDecoder.decode(bytes);
        return jsonl.length === 0 || jsonl.endsWith('\n') ? jsonl : jsonl + '\n';
      }),
    );
    await this.storage.write(
      TELEMETRY_SCOPE,
      this.createKey(),
      textEncoder.encode(existing.join('') + text),
      { atomic: true },
    );
    await Promise.all(compacted.map((file) => this.acknowledge(file.key).catch(() => undefined)));
  }

  private createKey(): string {
    return `${FAILED_PREFIX}${this.now()}_${randomBytes(6).toString('hex')}${JSONL_SUFFIX}`;
  }

  private async readJsonl(key: string): Promise<readonly EnrichedCloudEvent[]> {
    const bytes = await this.storage.read(TELEMETRY_SCOPE, key);
    if (bytes === undefined) return [];
    const events: EnrichedCloudEvent[] = [];
    for (const line of textDecoder.decode(bytes).split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const event: unknown = JSON.parse(trimmed);
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        throw new TypeError('telemetry spool entry must be an object');
      }
      events.push(event as EnrichedCloudEvent);
    }
    return events;
  }
}

interface SpoolFile {
  readonly key: string;
  readonly createdAt: number;
}

function parseCreatedAt(key: string): number | undefined {
  if (!key.startsWith(FAILED_PREFIX) || !key.endsWith(JSONL_SUFFIX)) return undefined;
  const rest = key.slice(FAILED_PREFIX.length);
  const underscore = rest.indexOf('_');
  if (underscore === -1) return undefined;
  const createdAt = Number(rest.slice(0, underscore));
  return Number.isFinite(createdAt) ? createdAt : undefined;
}
