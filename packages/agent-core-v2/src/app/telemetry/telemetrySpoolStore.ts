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
  readonly maxFileBytes?: number;
  readonly now?: () => number;
}

export const TELEMETRY_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const TELEMETRY_SPOOL_MAX_FILES = 256;
export const TELEMETRY_SPOOL_MAX_FILE_BYTES = 256 * 1024;

const TELEMETRY_SCOPE = 'telemetry-v2';
const FAILED_PREFIX = 'failed_';
const JSONL_SUFFIX = '.jsonl';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class TelemetrySpoolStore implements ITelemetrySpoolStore {
  private readonly storage: IFileSystemStorageService;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: TelemetrySpoolStoreOptions) {
    this.storage = options.storage;
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? TELEMETRY_SPOOL_MAX_FILES));
    this.maxFileBytes = Math.max(
      1,
      Math.floor(options.maxFileBytes ?? TELEMETRY_SPOOL_MAX_FILE_BYTES),
    );
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
    const overflow = files.splice(0, Math.max(0, files.length - this.maxFiles));
    discarded.push(...overflow.map((file) => file.key));
    await Promise.all(discarded.map((key) => this.acknowledge(key).catch(() => undefined)));
    return files;
  }

  private async putOwned(events: readonly EnrichedCloudEvent[]): Promise<void> {
    const chunks = this.chunk(events).slice(-this.maxFiles);
    const files = [...(await this.enforcePolicy())];
    for (const chunk of chunks) {
      const file = this.createFile();
      await this.storage.write(TELEMETRY_SCOPE, file.key, chunk, { atomic: true });
      files.push(file);
      const overflow = files.splice(0, Math.max(0, files.length - this.maxFiles));
      await Promise.all(
        overflow.map((candidate) => this.acknowledge(candidate.key).catch(() => undefined)),
      );
    }
  }

  private chunk(events: readonly EnrichedCloudEvent[]): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    let lines: Uint8Array[] = [];
    let byteLength = 0;
    for (const event of events) {
      const line = textEncoder.encode(`${JSON.stringify(event)}\n`);
      if (line.byteLength > this.maxFileBytes) continue;
      if (byteLength + line.byteLength > this.maxFileBytes) {
        chunks.push(concatBytes(lines, byteLength));
        lines = [];
        byteLength = 0;
      }
      lines.push(line);
      byteLength += line.byteLength;
    }
    if (lines.length > 0) chunks.push(concatBytes(lines, byteLength));
    return chunks;
  }

  private createFile(): SpoolFile {
    const createdAt = this.now();
    return {
      key: `${FAILED_PREFIX}${createdAt}_${randomBytes(6).toString('hex')}${JSONL_SUFFIX}`,
      createdAt,
    };
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

function concatBytes(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
