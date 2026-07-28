/**
 * `runtimeSession` domain (L6) — `BlobBackedStorageService`, an
 * `IFileSystemStorageService` façade over the lease's `IBlobStore`.
 *
 * A few Session Core services (`AgentTaskService` task output,
 * `ToolResultTruncationService` offloaded tool results) still speak the
 * byte-store contract rather than the typed Store contracts. Seeding this
 * façade at Session scope keeps their bytes inside the lease's persistence
 * namespace — never the App container's storage (plan §1.5) — while the
 * legacy path keeps its App-scope store untouched.
 *
 * LIMITATIONS (transitional, M8): `append` is a read-concat-rewrite, not the
 * file backend's O(1) durable extension, and concurrent appends to one key
 * can lose updates; `watch` is unimplemented. Both are acceptable for the
 * consumers above (single-writer task output, write-once truncations); the
 * end state moves these consumers to lease artifacts directly (plan §7.5).
 */

import type { IBlobStore } from '#/persistence/interface/blobStore';
import type {
  IFileSystemStorageService,
  StorageAppendOptions,
  StorageReadRange,
  StorageWriteOptions,
} from '#/persistence/interface/storage';

export class BlobBackedStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly blobs: IBlobStore) {}

  read(scope: string, key: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(scope, key);
  }

  async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    yield* this.blobs.getStream(scope, key, range);
  }

  async write(scope: string, key: string, data: Uint8Array, _options?: StorageWriteOptions) {
    await this.blobs.put(scope, key, data);
  }

  async writeStream(
    scope: string,
    key: string,
    source: AsyncIterable<Uint8Array>,
    _options?: StorageWriteOptions,
  ): Promise<void> {
    await this.blobs.putStream(scope, key, source);
  }

  async append(
    scope: string,
    key: string,
    data: Uint8Array,
    _options?: StorageAppendOptions,
  ): Promise<void> {
    const existing = await this.blobs.get(scope, key);
    if (existing === undefined) {
      await this.blobs.put(scope, key, data);
      return;
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength);
    merged.set(existing, 0);
    merged.set(data, existing.byteLength);
    await this.blobs.put(scope, key, merged);
  }

  list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.blobs.list(scope, prefix);
  }

  delete(scope: string, key: string): Promise<void> {
    return this.blobs.delete(scope, key);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
