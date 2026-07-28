/**
 * Scenario: shared live-file-source monitoring across lifecycle boundaries.
 *
 * Resolves the real App service by interface. Unit cases use the topology-aware
 * host-watch fake and a mutable host-fs boundary; integration cases use the
 * node-local host services against isolated temporary directories. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/fileSourceMonitor/fileSourceMonitor.test.ts`.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  IFileSourceMonitor,
  type IFileSourceWatch,
} from '#/app/fileSourceMonitor/fileSourceMonitor';
import { FileSourceMonitorService } from '#/app/fileSourceMonitor/fileSourceMonitorService';
import { SKILL_ROOT_WATCH_OPTIONS } from '#/app/skillCatalog/skillTraversal';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';

import { stubHostFsWatch, type StubHostFsWatch } from '../../os/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';

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

function mutableDirectoryFs(
  directories: Set<string>,
  canonicalPaths: ReadonlyMap<string, string> = new Map(),
): IHostFileSystem {
  return createFakeHostFs({
    stat: async (path) => {
      if (!directories.has(path)) throw new Error(`ENOENT: ${path}`);
      return { isFile: false, isDirectory: true, size: 0 };
    },
    realpath: async (path) => canonicalPaths.get(path) ?? path,
  });
}

describe('file source monitor (shared handles and path state)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
  });

  function build(hostFs: IHostFileSystem, hostWatch: IHostFsWatchService): IFileSourceMonitor {
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IHostFileSystem, hostFs);
        reg.defineInstance(IHostFsWatchService, hostWatch);
        reg.define(IFileSourceMonitor, FileSourceMonitorService);
      },
    });
    return ix.get(IFileSourceMonitor);
  }

  it('reuses raw handles when two consumers watch the same path and releases on the last dispose', async () => {
    const directories = new Set(['/workspace', '/workspace/skills']);
    const raw = stubHostFsWatch();
    const monitor = build(mutableDirectoryFs(directories), raw);
    const first = monitor.createWatch({ ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0 }, () => {});
    const second = monitor.createWatch({ ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0 }, () => {});

    await first.setPaths(['/workspace/skills']);
    await second.setPaths(['/workspace/skills']);

    expect(raw.watchedPaths().toSorted()).toEqual(['/workspace', '/workspace/skills']);
    first.dispose();
    expect(raw.watchedPaths().toSorted()).toEqual(['/workspace', '/workspace/skills']);
    second.dispose();
    expect(raw.watchedPaths()).toEqual([]);
  });

  it('passes the bounded skill traversal policy to the target watcher', async () => {
    const directories = new Set(['/workspace', '/workspace/skills']);
    const raw = stubHostFsWatch();
    const monitor = build(mutableDirectoryFs(directories), raw);
    const watch = monitor.createWatch({ ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0 }, () => {});

    await watch.setPaths(['/workspace/skills']);

    const target = raw.watchedEntries().find((entry) => entry.path === '/workspace/skills');
    expect(target?.options?.depth).toBe(10);
    expect(target?.options?.followSymlinks).toBe(true);
    expect(target?.options?.ignored?.('/workspace/skills/node_modules/pkg/SKILL.md')).toBe(true);
    expect(target?.options?.ignored?.('/workspace/skills/.cache/SKILL.md')).toBe(true);
    expect(target?.options?.ignored?.('/workspace/skills/.cache.md/SKILL.md')).toBe(true);
    expect(target?.options?.ignored?.('/workspace/skills/.skill.md')).toBe(false);
    expect(target?.options?.ignored?.('/workspace/skills/review/SKILL.md')).toBe(false);
  });

  it('advances from the nearest existing ancestor when a deep missing root appears', async () => {
    const directories = new Set(['/root']);
    const raw = stubHostFsWatch();
    const monitor = build(mutableDirectoryFs(directories), raw);
    let changes = 0;
    const watch = monitor.createWatch(
      { ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0 },
      () => {
        changes += 1;
      },
    );

    await watch.setPaths(['/root/a/b/skills']);
    expect(raw.watchedPaths()).toEqual(['/root']);

    directories.add('/root/a');
    raw.fire('/root/a', { action: 'created', kind: 'directory' });
    await vi.waitFor(() => {
      expect(raw.watchedPaths()).toContain('/root/a');
    });

    directories.add('/root/a/b');
    directories.add('/root/a/b/skills');
    raw.fire('/root/a/b', { action: 'created', kind: 'directory' });

    await vi.waitFor(() => {
      expect(changes).toBe(1);
    });
    expect(raw.watchedPaths()).toContain('/root/a/b/skills');
  });

  it('watches the canonical target when the lexical root is a symlink', async () => {
    const directories = new Set(['/workspace', '/workspace/skills-link', '/target/skills']);
    const raw = stubHostFsWatch();
    const monitor = build(
      mutableDirectoryFs(directories, new Map([['/workspace/skills-link', '/target/skills']])),
      raw,
    );
    let changes = 0;
    const watch = monitor.createWatch(
      { ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0, pollingIntervalMs: 25 },
      () => {
        changes += 1;
      },
    );

    await watch.setPaths(['/workspace/skills-link']);
    raw.fire('/target/skills/review/SKILL.md', { action: 'modified', kind: 'file' });

    expect(changes).toBe(1);
    expect(raw.watchedPaths()).toContain('/target/skills');
  });

  it('watches the canonical creation chain below an existing symlink ancestor', async () => {
    const lexical = '/workspace/skills-link/missing/skills';
    const canonical = '/target/missing/skills';
    const directories = new Set(['/workspace', '/workspace/skills-link', '/target']);
    const canonicalPaths = new Map([
      ['/workspace/skills-link', '/target'],
      [lexical, canonical],
    ]);
    const raw = stubHostFsWatch();
    const monitor = build(mutableDirectoryFs(directories, canonicalPaths), raw);
    let changes = 0;
    const watch = monitor.createWatch(
      { ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0 },
      () => {
        changes += 1;
      },
    );

    await watch.setPaths([lexical]);
    expect(raw.watchedPaths().toSorted()).toEqual(['/target', '/workspace/skills-link']);

    directories.add(lexical);
    directories.add(canonical);
    raw.fire('/target/missing', { action: 'created', kind: 'directory' });

    await vi.waitFor(() => {
      expect(changes).toBe(1);
    });
    expect(raw.watchedPaths()).toContain(canonical);
  });

  it('does not create a handle when the consumer disposes during an asynchronous probe', async () => {
    const stat = deferred<{ readonly isFile: boolean; readonly isDirectory: boolean; readonly size: number }>();
    const hostFs = createFakeHostFs({
      stat: () => stat.promise,
      realpath: async (path) => path,
    });
    const raw = stubHostFsWatch();
    const monitor = build(hostFs, raw);
    const watch = monitor.createWatch({ ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0 }, () => {});

    const setting = watch.setPaths(['/workspace/skills']);
    watch.dispose();
    stat.resolve({ isFile: false, isDirectory: true, size: 0 });
    await setting;

    expect(raw.watchedPaths()).toEqual([]);
  });
});

describe('file source monitor (node-local integration)', () => {
  let disposables: DisposableStore;
  let roots: string[];

  beforeEach(() => {
    disposables = new DisposableStore();
    roots = [];
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  function build(): IFileSourceMonitor {
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostFileSystem, HostFileSystem);
        reg.define(IHostFsWatchService, HostFsWatchService);
        reg.define(IFileSourceMonitor, FileSourceMonitorService);
      },
    });
    return ix.get(IFileSourceMonitor);
  }

  it('detects a deep root created after the subscription is ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-source-monitor-missing-'));
    roots.push(root);
    const target = join(root, 'a', 'b', 'skills');
    const monitor = build();
    let changes = 0;
    const watch = monitor.createWatch(
      { ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0, pollingIntervalMs: 25 },
      () => {
        changes += 1;
      },
    );
    await watch.setPaths([target]);

    await mkdir(join(target, 'review'), { recursive: true });
    await writeFile(join(target, 'review', 'SKILL.md'), 'content', 'utf8');

    await vi.waitFor(() => {
      expect(changes).toBeGreaterThan(0);
    }, { timeout: 3_000 });
  });

  it.runIf(process.platform !== 'win32')(
    'detects content changes through an existing symlink target',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'file-source-monitor-symlink-'));
      roots.push(root);
      const target = join(root, 'target');
      const lexical = join(root, 'skills-link');
      await mkdir(join(target, 'review'), { recursive: true });
      await symlink(target, lexical, 'dir');
      const monitor = build();
      let changes = 0;
      const watch: IFileSourceWatch = monitor.createWatch(
        { ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0, pollingIntervalMs: 25 },
        () => {
          changes += 1;
        },
      );
      await watch.setPaths([lexical]);

      await writeFile(join(target, 'review', 'SKILL.md'), 'updated', 'utf8');

      await vi.waitFor(() => {
        expect(changes).toBeGreaterThan(0);
      }, { timeout: 3_000 });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'detects content changes inside a symlinked bundle under a watched root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'file-source-monitor-nested-symlink-'));
      roots.push(root);
      const skillRoot = join(root, 'skills');
      const bundleTarget = join(root, 'bundle-target');
      const skillMd = join(bundleTarget, 'SKILL.md');
      await Promise.all([mkdir(skillRoot), mkdir(bundleTarget)]);
      await writeFile(skillMd, 'initial', 'utf8');
      await symlink(bundleTarget, join(skillRoot, 'review'), 'dir');
      const monitor = build();
      let changes = 0;
      const watch = monitor.createWatch(
        { ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0, pollingIntervalMs: 25 },
        () => {
          changes += 1;
        },
      );
      await watch.setPaths([skillRoot]);

      await writeFile(skillMd, 'updated', 'utf8');

      await vi.waitFor(() => {
        expect(changes).toBeGreaterThan(0);
      }, { timeout: 3_000 });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'detects a missing root created below a symlink ancestor',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'file-source-monitor-symlink-missing-'));
      roots.push(root);
      const target = join(root, 'target');
      const lexical = join(root, 'skills-link');
      const missingRoot = join(lexical, 'nested', 'skills');
      await mkdir(target, { recursive: true });
      await symlink(target, lexical, 'dir');
      const monitor = build();
      let changes = 0;
      const watch = monitor.createWatch(
        { ...SKILL_ROOT_WATCH_OPTIONS, debounceMs: 0, pollingIntervalMs: 25 },
        () => {
          changes += 1;
        },
      );
      await watch.setPaths([missingRoot]);

      await mkdir(join(target, 'nested', 'skills', 'review'), { recursive: true });
      await writeFile(join(target, 'nested', 'skills', 'review', 'SKILL.md'), 'content', 'utf8');

      await vi.waitFor(() => {
        expect(changes).toBeGreaterThan(0);
      }, { timeout: 3_000 });
    },
  );
});
