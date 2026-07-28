/**
 * `InMemoryStores` — in-memory typed Store backends: codec-parameterized
 * `IAtomicDocumentStore` / `IAppendLogStore` / `IBlobStore` implementations
 * with no filesystem involvement.
 *
 * Documents and blobs sit on `IFileSystemStorageService` byte storage (the
 * `InMemoryStorageService` sibling) with the same semantics as the node-fs
 * adapters: values are codec-encoded at write time and decoded on every read,
 * so callers always observe detached copies. Append logs keep one encoded
 * record per durable entry in a shared `InMemoryLogBackend` — memory needs no
 * line framing — while preserving the node-fs observable contract: batched
 * microtask-drained appends, read-flushes-first, sticky per-key failures until
 * a valid `rewrite`, live-tail-preserving `rewrite`, ref-counted `acquire`
 * retirement, and `flush`/`close` reporting the first failure in stable key
 * insertion order.
 *
 * Not auto-registered: typed Stores are handed out by a runtime's session
 * persistence context (e.g. the standalone memory host runtime), which also
 * owns the shared durable medium.
 */

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';

import {
  AppendLogCorruptedError,
  IAppendLogStore,
  type AppendLogOptions,
} from '#/persistence/interface/appendLogStore';
import {
  IAtomicDocumentStore,
  type DocumentCodec,
} from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore, type BlobReadRange } from '#/persistence/interface/blobStore';
import {
  IFileSystemStorageService,
  StorageError,
  StorageErrors,
} from '#/persistence/interface/storage';

export class InMemoryAtomicDocumentStore implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly storage: IFileSystemStorageService,
    private readonly codec: DocumentCodec,
  ) {}

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    const bytes = await this.storage.read(scope, key);
    if (bytes === undefined) return undefined;
    try {
      return this.codec.decode(bytes) as T;
    } catch (error) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_DECODE_FAILED,
        `failed to decode ${scope}/${key} as ${this.codec.format}`,
        {
          details: { scope, key, format: this.codec.format },
          cause: error,
        },
      );
    }
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    await this.storage.write(scope, key, this.codec.encode(value), { atomic: true });
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.storage.delete(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.storage.list(scope, prefix);
  }

  watch(scope: string, key: string): Event<void> {
    return this.storage.watch?.(scope, key) ?? (Event.None as Event<void>);
  }

  acquire(_scope: string, _key: string): IDisposable {
    return toDisposable(() => {});
  }
}

/**
 * The shared durable medium behind every `InMemoryAppendLogStore` instance of
 * one runtime: one encoded record per entry, scope/key addressed. Store
 * instances hold the per-key buffering state; this backend holds what a flush
 * makes durable, so data survives across store instances (leases) of the same
 * runtime.
 */
export class InMemoryLogBackend {
  private readonly scopes = new Map<string, Map<string, Uint8Array[]>>();

  entries(scope: string, key: string): readonly Uint8Array[] {
    return this.scopes.get(scope)?.get(key) ?? [];
  }

  appendBatch(scope: string, key: string, batch: readonly Uint8Array[]): void {
    const entries = this.bucket(scope, key);
    for (const record of batch) entries.push(record);
  }

  replace(scope: string, key: string, entries: readonly Uint8Array[]): void {
    this.bucket(scope, key).splice(0, Number.POSITIVE_INFINITY, ...entries);
  }

  list(scope: string): readonly string[] {
    const bucket = this.scopes.get(scope);
    return bucket === undefined ? [] : [...bucket.keys()];
  }

  deleteScope(scope: string): void {
    this.scopes.delete(scope);
  }

  copyScope(source: string, target: string): void {
    const bucket = this.scopes.get(source);
    this.scopes.delete(target);
    if (bucket === undefined) return;
    const copied = new Map<string, Uint8Array[]>();
    for (const [key, entries] of bucket) {
      copied.set(
        key,
        entries.map((entry) => entry.slice()),
      );
    }
    this.scopes.set(target, copied);
  }

  private bucket(scope: string, key: string): Uint8Array[] {
    let bucket = this.scopes.get(scope);
    if (bucket === undefined) {
      bucket = new Map();
      this.scopes.set(scope, bucket);
    }
    let entries = bucket.get(key);
    if (entries === undefined) {
      entries = [];
      bucket.set(key, entries);
    }
    return entries;
  }
}

interface LogKeyState {
  pending: unknown[];
  tail: Promise<void>;
  scheduled: boolean;
  failure: { readonly error: unknown } | undefined;
  refCount: number;
  retired: boolean;
  retirement: Promise<void> | undefined;
  onError?: (error: unknown) => void;
}

export class InMemoryAppendLogStore implements IAppendLogStore {
  declare readonly _serviceBrand: undefined;

  private readonly logs = new Map<string, LogKeyState>();

  constructor(
    private readonly backend: InMemoryLogBackend,
    private readonly codec: DocumentCodec,
  ) {}

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void {
    const state = this.state(scope, key);
    state.pending.push(record);
    if (options?.onError !== undefined && state.onError === undefined) {
      state.onError = options.onError;
    }
    if (state.scheduled) return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      void this.flushKey(scope, key, state).catch((error) => state.onError?.(error));
    });
  }

  async *read<R>(scope: string, key: string): AsyncIterable<R> {
    await this.flushKey(scope, key, this.state(scope, key));
    const entries = this.backend.entries(scope, key);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      try {
        yield this.codec.decode(entry) as R;
      } catch (error) {
        // Mirror the node-fs crash tolerance: a torn final entry is dropped,
        // corruption anywhere else throws.
        if (index === entries.length - 1) return;
        throw new AppendLogCorruptedError(scope, key, index + 1, error);
      }
    }
  }

  async rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void> {
    const state = this.state(scope, key);
    const encoded = records.map((record) => this.codec.encode(record));
    // The replacement is chained behind earlier durable operations; a valid
    // replacement clears the sticky failure (recovery boundary), while a
    // failed one turns sticky itself — exactly like the node-fs store — so a
    // later flush cannot duplicate data by guessing whether it committed.
    // Appends still queued keep their place as the live tail drained after
    // the replacement.
    const replaced = state.tail.then(() => {
      try {
        this.backend.replace(scope, key, encoded);
        state.failure = undefined;
      } catch (error) {
        state.failure = { error };
        throw error;
      }
    });
    state.tail = replaced.catch(() => undefined);
    await replaced;
    await this.flushKey(scope, key, state);
  }

  async flush(): Promise<void> {
    let firstFailure: unknown;
    let hasFailure = false;
    for (const [id, state] of this.logs) {
      const { scope, key } = fromLogId(id);
      try {
        await this.flushKey(scope, key, state);
      } catch (error) {
        if (!hasFailure) {
          firstFailure = error;
          hasFailure = true;
        }
      }
    }
    if (hasFailure) throw firstFailure;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  acquire(scope: string, key: string): IDisposable {
    const state = this.state(scope, key);
    state.refCount++;
    return toDisposable(() => {
      state.refCount--;
      if (state.refCount > 0) return;
      state.retired = true;
      state.retirement = this.settleRetiredState(scope, key, state).catch(() => undefined);
    });
  }

  private state(scope: string, key: string): LogKeyState {
    const id = logId(scope, key);
    let state = this.logs.get(id);
    if (state === undefined || state.retired) {
      state = {
        pending: [],
        tail: state?.retirement ?? Promise.resolve(),
        scheduled: false,
        failure: undefined,
        refCount: 0,
        retired: false,
        retirement: undefined,
      };
      this.logs.set(id, state);
    }
    return state;
  }

  private flushKey(scope: string, key: string, state: LogKeyState): Promise<void> {
    const drained = state.tail.then(() => {
      if (state.failure !== undefined) throw state.failure.error;
      if (state.pending.length === 0) return;
      const batch = state.pending.slice();
      try {
        const encoded = batch.map((record) => this.codec.encode(record));
        this.backend.appendBatch(scope, key, encoded);
      } catch (error) {
        state.failure = { error };
        throw error;
      }
      state.pending.splice(0, batch.length);
    });
    state.tail = drained.catch(() => undefined);
    return drained;
  }

  private async settleRetiredState(
    scope: string,
    key: string,
    state: LogKeyState,
  ): Promise<void> {
    try {
      await this.flushKey(scope, key, state);
    } finally {
      const id = logId(scope, key);
      if (this.logs.get(id) === state) this.logs.delete(id);
    }
  }
}

export class InMemoryBlobStore implements IBlobStore {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly storage: IFileSystemStorageService) {}

  async put(scope: string, key: string, data: Uint8Array): Promise<void> {
    await this.storage.write(scope, key, data, { atomic: true });
  }

  async putStream(scope: string, key: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    await this.storage.writeStream(scope, key, source, { atomic: true });
  }

  async get(scope: string, key: string): Promise<Uint8Array | undefined> {
    return this.storage.read(scope, key);
  }

  getStream(scope: string, key: string, range?: BlobReadRange): AsyncIterable<Uint8Array> {
    return this.storage.readStream(scope, key, range);
  }

  async has(scope: string, key: string): Promise<boolean> {
    const keys = await this.storage.list(scope, key);
    return keys.includes(key);
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.storage.delete(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.storage.list(scope, prefix);
  }
}

function logId(scope: string, key: string): string {
  return `${scope}\n${key}`;
}

function fromLogId(id: string): { scope: string; key: string } {
  const index = id.indexOf('\n');
  return { scope: id.slice(0, index), key: id.slice(index + 1) };
}
