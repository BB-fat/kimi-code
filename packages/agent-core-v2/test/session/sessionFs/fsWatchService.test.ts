/**
 * `sessionFsWatch` domain (L2) — verifies confinement to the declared subtree,
 * workspace-relative path mapping (including symlinked workspace roots),
 * debounce coalescing, window truncation, `.gitignore` filtering and handle
 * lifecycle. Unit cases use a fake shared path watch; the symlink case keeps
 * the real `pathWatch` service and stubs only the raw host watcher boundary.
 */

import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, createServices, stubPair } from '#/_base/di/test';
import {
  type IPathWatch,
  IPathWatchService,
  type PathWatchEvent,
  type PathWatchOptions,
} from '#/app/pathWatch/pathWatch';
import { PathWatchService } from '#/app/pathWatch/pathWatchService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { type HostFsChange, IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';
import type { FsChangeEvent } from '#/session/sessionFs/fsWatch';

import { ISessionFsWatchService } from '#/session/sessionFs/fsWatch';
import { SessionFsWatchService } from '#/session/sessionFs/fsWatchService';

import { stubHostFsWatch } from '../../os/stubs';

const WORK_DIR = '/repo';

void SessionFsWatchService;

function stubWorkspace(): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir: WORK_DIR,
    additionalDirs: [],
    setWorkDir: () => {},
    setAdditionalDirs: () => {},
    resolve: (rel) => (isAbsolute(rel) ? rel : resolve(WORK_DIR, rel)),
    isWithin: (abs) => {
      const r = relative(WORK_DIR, abs);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    },
    assertAllowed: (abs) => abs,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

interface FakeWatch {
  readonly service: IPathWatchService;
  readonly createOptions: readonly PathWatchOptions[];
  readonly watchedPaths: () => readonly string[];
  fire: (rel: string, action: HostFsChange['action'], kind?: HostFsChange['kind']) => void;
  readonly disposed: () => boolean;
}

function fakePathWatch(): FakeWatch {
  const createOptions: PathWatchOptions[] = [];
  let watchedPaths: readonly string[] = [];
  let listener: ((event: PathWatchEvent) => void) | undefined;
  let disposed = false;
  const service: IPathWatchService = {
    _serviceBrand: undefined,
    createWatch: (options, onDidChange): IPathWatch => {
      createOptions.push(options);
      listener = onDidChange;
      disposed = false;
      return {
        setPaths: async (paths) => {
          watchedPaths = [...paths];
        },
        dispose: () => {
          disposed = true;
          watchedPaths = [];
          listener = undefined;
        },
      };
    },
  };
  return {
    service,
    createOptions,
    watchedPaths: () => watchedPaths,
    fire: (rel, action, kind = 'file') =>
      listener?.({
        watchedPath: WORK_DIR,
        change: { path: join(WORK_DIR, rel), action, kind },
      }),
    disposed: () => disposed,
  };
}

function fakeHostFs(gitignore?: string): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    readText: async (p: string) => {
      if (gitignore !== undefined && p === join(WORK_DIR, '.gitignore')) return gitignore;
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
  } as unknown as IHostFileSystem;
}

interface Harness {
  readonly svc: ISessionFsWatchService;
  readonly watch: FakeWatch;
  readonly events: FsChangeEvent[];
}

function makeSession(gitignore?: string): Harness {
  const watch = fakePathWatch();
  const hostFs = fakeHostFs(gitignore);
  const host = createScopedTestHost([
    stubPair(IHostFileSystem, hostFs),
    stubPair(IHostFsWatchService, stubHostFsWatch()),
  ]);
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(ISessionStateService, new SessionStateService()),
    stubPair(ISessionWorkspaceContext, stubWorkspace()),
    stubPair(IPathWatchService, watch.service),
    stubPair(IHostFileSystem, hostFs),
  ]);
  const svc = session.accessor.get(ISessionFsWatchService);
  const events: FsChangeEvent[] = [];
  svc.onDidChangeFiles((e) => events.push(e));
  disposers.push(() => {
    host.dispose();
  });
  return { svc, watch, events };
}

const disposers: Array<() => void> = [];

describe('SessionFsWatchService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
    vi.useRealTimers();
  });

  it('starts a raw shared path watch on the workspace root for a non-empty subscription', () => {
    const { svc, watch } = makeSession();
    svc.setWatchedPaths(['src']);
    expect(watch.watchedPaths()).toEqual([WORK_DIR]);
    expect(watch.createOptions).toEqual([
      { target: 'directory', recursive: true, debounceMs: 0 },
    ]);
    expect(svc.watchedPaths).toEqual(['src']);
  });

  it('drops events outside the subscribed subtree', () => {
    const { svc, watch, events } = makeSession();
    svc.setWatchedPaths(['src']);

    watch.fire('src/a.ts', 'created');
    watch.fire('lib/b.ts', 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.changes).toEqual([{ path: 'src/a.ts', change: 'created', kind: 'file' }]);
  });

  it('coalesces changes within a window into one event', () => {
    const { svc, watch, events } = makeSession();
    svc.setWatchedPaths(['.']);

    watch.fire('a.ts', 'created');
    watch.fire('b.ts', 'modified');
    watch.fire('c.ts', 'deleted');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.coalesced_window_ms).toBe(200);
    expect(events[0]?.changes).toHaveLength(3);
  });

  it('marks the event truncated when the window overflows', () => {
    const { svc, watch, events } = makeSession();
    svc.setWatchedPaths(['.']);

    for (let i = 0; i < 501; i++) watch.fire(`f${i}.ts`, 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.truncated).toBe(true);
    expect(events[0]?.changes).toEqual([]);
    expect(events[0]?.count).toBe(501);
  });

  it('filters out `.gitignore`d paths once loaded', async () => {
    const { svc, watch, events } = makeSession('dist/\n');
    svc.setWatchedPaths(['.']);
    await Promise.resolve();
    await Promise.resolve();

    watch.fire('dist/x.js', 'created');
    watch.fire('src/keep.ts', 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.changes.map((c) => c.path)).toEqual(['src/keep.ts']);
  });

  it('rejects paths that escape the workspace', () => {
    const { svc } = makeSession();
    expect(() => {
      svc.setWatchedPaths(['../x']);
    }).toThrowError(/escapes workspace|rejected/);
    expect(() => {
      svc.setWatchedPaths(['/abs']);
    }).toThrowError(/rejected/);
  });

  it('disposes the shared path-watch handle when the subscription set becomes empty', () => {
    const { svc, watch } = makeSession();
    svc.setWatchedPaths(['src']);
    expect(watch.disposed()).toBe(false);
    svc.setWatchedPaths([]);
    expect(watch.disposed()).toBe(true);
  });

  it('does not fire after the service is disposed', () => {
    const { svc, watch, events } = makeSession();
    svc.setWatchedPaths(['.']);
    watch.fire('a.ts', 'created');
    (svc as unknown as { dispose: () => void }).dispose();
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(0);
  });
});

describe('SessionFsWatchService (shared path-watch integration)', () => {
  let disposables: DisposableStore;
  let root: string | undefined;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(async () => {
    disposables.dispose();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')(
    'emits workspace-relative changes when the watched workspace root is a symlink',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'session-fs-watch-symlink-'));
      const canonicalWorkDir = join(root, 'canonical-workspace');
      const lexicalWorkDir = join(root, 'workspace-link');
      await mkdir(join(canonicalWorkDir, 'src'), { recursive: true });
      await symlink(canonicalWorkDir, lexicalWorkDir, 'dir');
      const resolvedCanonicalWorkDir = await realpath(canonicalWorkDir);

      const rawWatch = stubHostFsWatch();
      const ix = createServices(disposables, {
        additionalServices: (reg) => {
          reg.defineInstance(ISessionStateService, new SessionStateService());
          reg.definePartialInstance(ISessionContext, { cwd: lexicalWorkDir });
          reg.define(ISessionWorkspaceContext, SessionWorkspaceContextService);
          reg.define(IHostFileSystem, HostFileSystem);
          reg.defineInstance(IHostFsWatchService, rawWatch);
          reg.define(IPathWatchService, PathWatchService);
          reg.define(ISessionFsWatchService, SessionFsWatchService);
        },
      });
      const svc = ix.get(ISessionFsWatchService);
      const events: FsChangeEvent[] = [];
      disposables.add(svc.onDidChangeFiles((event) => events.push(event)));

      svc.setWatchedPaths(['src']);
      await vi.waitFor(() => {
        expect(rawWatch.watchedPaths()).toContain(resolvedCanonicalWorkDir);
      });

      rawWatch.fire(join(resolvedCanonicalWorkDir, 'src', 'a.ts'), {
        action: 'created',
        kind: 'file',
      });

      await vi.waitFor(() => {
        expect(events[0]?.changes).toEqual([
          { path: 'src/a.ts', change: 'created', kind: 'file' },
        ]);
      });
    },
  );
});
