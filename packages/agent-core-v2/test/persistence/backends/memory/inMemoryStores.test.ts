/**
 * Scenario: the in-memory typed Store backends (`InMemoryAtomicDocumentStore`,
 * `InMemoryAppendLogStore`, `InMemoryBlobStore`) keep the node-fs observable
 * contract — codec round-trips, read-your-writes after flush, sticky failures
 * until rewrite, ref-counted acquire retirement — over the shared in-memory
 * durable medium.
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/persistence/backends/memory/inMemoryStores.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { AppendLogCorruptedError } from '#/persistence/interface/appendLogStore';
import type { DocumentCodec } from '#/persistence/interface/atomicDocumentStore';
import {
  InMemoryAppendLogStore,
  InMemoryAtomicDocumentStore,
  InMemoryBlobStore,
  InMemoryLogBackend,
} from '#/persistence/backends/memory/inMemoryStores';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';

const enc = new TextEncoder();

const SCOPE = 'session/s-1';
const KEY = 'wire.jsonl';

async function readAll<R>(store: InMemoryAppendLogStore, scope = SCOPE, key = KEY): Promise<R[]> {
  const out: R[] = [];
  for await (const record of store.read<R>(scope, key)) out.push(record);
  return out;
}

describe('InMemoryAtomicDocumentStore', () => {
  it('round-trips values through the codec and hands back detached copies', async () => {
    const store = new InMemoryAtomicDocumentStore(new InMemoryStorageService(), jsonDocumentCodec);
    const input = { nested: { list: [1, 2, 3] } };
    await store.set(SCOPE, 'state', input);
    input.nested.list.push(4);

    const read = await store.get<typeof input>(SCOPE, 'state');
    expect(read).toEqual({ nested: { list: [1, 2, 3] } });
    read?.nested.list.push(99);
    expect(await store.get(SCOPE, 'state')).toEqual({ nested: { list: [1, 2, 3] } });
  });

  it('replaces atomically, deletes, lists with prefix and fires watch', async () => {
    const store = new InMemoryAtomicDocumentStore(new InMemoryStorageService(), jsonDocumentCodec);
    let fired = 0;
    const subscription = store.watch(SCOPE, 'a')(() => fired++);

    await store.set(SCOPE, 'a', { v: 1 });
    await store.set(SCOPE, 'a', { v: 2 });
    await store.set(SCOPE, 'ab', { v: 3 });
    expect(await store.get(SCOPE, 'a')).toEqual({ v: 2 });
    expect(await store.list(SCOPE, 'a')).toEqual(['a', 'ab']);
    expect(fired).toBe(2);

    await store.delete(SCOPE, 'a');
    expect(await store.get(SCOPE, 'a')).toBeUndefined();
    expect(fired).toBe(3);
    subscription.dispose();
  });

  it('wraps undecodable bytes in storage.decode_failed', async () => {
    const storage = new InMemoryStorageService();
    const store = new InMemoryAtomicDocumentStore(storage, jsonDocumentCodec);
    await storage.write(SCOPE, 'broken', enc.encode('not json{'), { atomic: true });
    await expect(store.get(SCOPE, 'broken')).rejects.toMatchObject({
      code: 'storage.decode_failed',
    });
  });
});

describe('InMemoryAppendLogStore', () => {
  const flakyCodec = (failOn: (value: unknown) => string | undefined): DocumentCodec => ({
    format: 'flaky',
    encode: (value) => {
      const failure = failOn(value);
      if (failure !== undefined) throw new Error(failure);
      return jsonDocumentCodec.encode(value);
    },
    decode: jsonDocumentCodec.decode,
  });

  it('batches appends and read returns them in order (read flushes first)', async () => {
    const store = new InMemoryAppendLogStore(new InMemoryLogBackend(), jsonDocumentCodec);
    store.append(SCOPE, KEY, { n: 1 });
    store.append(SCOPE, KEY, { n: 2 });
    expect(await readAll(store)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('keeps flushed records durable across store instances sharing the backend', async () => {
    const backend = new InMemoryLogBackend();
    const first = new InMemoryAppendLogStore(backend, jsonDocumentCodec);
    first.append(SCOPE, KEY, { n: 1 });
    await first.flush();

    const second = new InMemoryAppendLogStore(backend, jsonDocumentCodec);
    expect(await readAll(second)).toEqual([{ n: 1 }]);
    second.append(SCOPE, KEY, { n: 2 });
    await second.close();
    expect(await readAll(first)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('flush reports the first failure in stable key insertion order and keeps it sticky', async () => {
    const codec = flakyCodec((value) => {
      const record = value as { boom?: boolean; id?: string };
      return record.boom === true ? `cannot encode ${record.id ?? '?'}` : undefined;
    });
    const store = new InMemoryAppendLogStore(new InMemoryLogBackend(), codec);
    store.append(SCOPE, 'a', { boom: true, id: 'a' });
    store.append(SCOPE, 'b', { boom: true, id: 'b' });
    await expect(store.flush()).rejects.toThrow('cannot encode a');
    // Sticky: the same failure is reported again without re-appending.
    await expect(store.flush()).rejects.toThrow('cannot encode a');
  });

  it('treats a valid rewrite as the recovery boundary for an ambiguous failure', async () => {
    class FailingBackend extends InMemoryLogBackend {
      failNext = false;
      override appendBatch(scope: string, key: string, batch: readonly Uint8Array[]): void {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('ambiguous io');
        }
        super.appendBatch(scope, key, batch);
      }
    }
    const backend = new FailingBackend();
    const store = new InMemoryAppendLogStore(backend, jsonDocumentCodec);
    store.append(SCOPE, KEY, { n: 1 });
    backend.failNext = true;
    await expect(store.flush()).rejects.toThrow('ambiguous io');
    await expect(store.flush()).rejects.toThrow('ambiguous io');
    // The outstanding append is the live tail: it is NOT part of the rewrite
    // records and drains after the atomic replacement.
    await store.rewrite(SCOPE, KEY, [{ n: 0 }]);
    expect(await readAll(store)).toEqual([{ n: 0 }, { n: 1 }]);
  });

  it('preserves the queued live tail across an atomic rewrite', async () => {
    const store = new InMemoryAppendLogStore(new InMemoryLogBackend(), jsonDocumentCodec);
    store.append(SCOPE, KEY, { n: 1 });
    await store.flush();
    store.append(SCOPE, KEY, { n: 2 });
    await store.rewrite(SCOPE, KEY, [{ n: 0 }]);
    expect(await readAll(store)).toEqual([{ n: 0 }, { n: 2 }]);
  });

  it('retires the keyed buffer when the last acquired handle releases', async () => {
    const backend = new InMemoryLogBackend();
    const store = new InMemoryAppendLogStore(backend, jsonDocumentCodec);
    const first = store.acquire(SCOPE, KEY);
    const second = store.acquire(SCOPE, KEY);
    store.append(SCOPE, KEY, { n: 1 });
    first.dispose();
    second.dispose();
    // Final release drained the pending records before retiring the buffer.
    expect(await readAll(store)).toEqual([{ n: 1 }]);
  });

  it('marks a failed rewrite sticky until a valid rewrite completes', async () => {
    class FailingBackend extends InMemoryLogBackend {
      failNextReplace = false;
      override replace(scope: string, key: string, entries: readonly Uint8Array[]): void {
        if (this.failNextReplace) {
          this.failNextReplace = false;
          throw new Error('replace io');
        }
        super.replace(scope, key, entries);
      }
    }
    const backend = new FailingBackend();
    const store = new InMemoryAppendLogStore(backend, jsonDocumentCodec);
    store.append(SCOPE, KEY, { n: 1 });
    await store.flush();

    backend.failNextReplace = true;
    await expect(store.rewrite(SCOPE, KEY, [{ n: 0 }])).rejects.toThrow('replace io');
    // The failed rewrite is sticky, mirroring the node-fs storageFailure.
    await expect(store.flush()).rejects.toThrow('replace io');
    await expect(readAll(store)).rejects.toThrow('replace io');
    // A valid rewrite is the recovery boundary.
    await store.rewrite(SCOPE, KEY, [{ n: 0 }]);
    expect(await readAll(store)).toEqual([{ n: 0 }]);
  });

  it('drops a torn final entry but throws AppendLogCorruptedError mid-stream', async () => {
    const backend = new InMemoryLogBackend();
    backend.appendBatch(SCOPE, KEY, [enc.encode('{"n":1}'), enc.encode('garbage')]);
    const store = new InMemoryAppendLogStore(backend, jsonDocumentCodec);
    expect(await readAll(store)).toEqual([{ n: 1 }]);

    backend.replace(SCOPE, KEY, [enc.encode('garbage'), enc.encode('{"n":1}')]);
    await expect(readAll(store)).rejects.toThrow(AppendLogCorruptedError);
  });
});

describe('InMemoryBlobStore', () => {
  it('put/get/has/delete/list round-trip, including ranged streams', async () => {
    const store = new InMemoryBlobStore(new InMemoryStorageService());
    await store.put(SCOPE, 'blob-1', enc.encode('hello world'));
    expect(await store.has(SCOPE, 'blob-1')).toBe(true);
    expect(await store.get(SCOPE, 'blob-1')).toEqual(enc.encode('hello world'));

    const chunks: Uint8Array[] = [];
    for await (const chunk of store.getStream(SCOPE, 'blob-1', { start: 0, end: 4 })) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(chunks[0])).toBe('hello');

    await store.put(SCOPE, 'blob-2', enc.encode('x'));
    expect(await store.list(SCOPE, 'blob-')).toEqual(['blob-1', 'blob-2']);
    await store.delete(SCOPE, 'blob-1');
    expect(await store.has(SCOPE, 'blob-1')).toBe(false);
  });

  it('putStream concatenates chunked sources', async () => {
    const store = new InMemoryBlobStore(new InMemoryStorageService());
    async function* source() {
      yield enc.encode('he');
      yield enc.encode('llo');
    }
    await store.putStream(SCOPE, 'streamed', source());
    expect(await store.get(SCOPE, 'streamed')).toEqual(enc.encode('hello'));
  });

  it('detaches byte references on both write and read', async () => {
    const store = new InMemoryBlobStore(new InMemoryStorageService());
    const source = enc.encode('hello');
    await store.put(SCOPE, 'blob', source);
    // Mutating the caller's buffer after the write must not touch storage.
    source.fill(0);
    expect(await store.get(SCOPE, 'blob')).toEqual(enc.encode('hello'));

    // Mutating a returned buffer must not touch storage either (disk reads
    // hand back a fresh copy in the file backend).
    const read = await store.get(SCOPE, 'blob');
    read?.fill(0);
    expect(await store.get(SCOPE, 'blob')).toEqual(enc.encode('hello'));
    for await (const chunk of store.getStream(SCOPE, 'blob')) {
      chunk.fill(0);
    }
    expect(await store.get(SCOPE, 'blob')).toEqual(enc.encode('hello'));
  });
});
