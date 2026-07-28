/**
 * `fileSourceMonitor` domain (L2) — `IFileSourceMonitor` implementation.
 *
 * Probes through `hostFs`, watches through `hostFsWatch`, and owns the shared
 * raw-handle pool, missing-path ancestor progression, lexical/canonical target
 * tracking, per-consumer debounce, reference counts, and disposal barriers.
 * Bound at App scope.
 */

import { dirname, join, normalize, relative } from 'pathe';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type HostFsChange,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

import {
  type FileSourceWatchOptions,
  IFileSourceMonitor,
  type IFileSourceWatch,
} from './fileSourceMonitor';

const DEFAULT_DEBOUNCE_MS = 300;

interface NormalizedWatchOptions {
  readonly target: 'file' | 'directory';
  readonly recursive: boolean;
  readonly depth: number | undefined;
  readonly followSymlinks: boolean;
  readonly pollingIntervalMs: number | undefined;
  readonly ignoredPathNames: readonly string[];
  readonly ignoreDotDirectories: boolean;
  readonly debounceMs: number;
}

interface RawWatchSpec {
  readonly path: string;
  readonly recursive: boolean;
  readonly depth: number | undefined;
  readonly followSymlinks: boolean;
  readonly pollingIntervalMs: number | undefined;
  readonly ignoredPathNames: readonly string[];
  readonly ignoreDotDirectories: boolean;
}

interface RawWatchEntry {
  readonly handle: IHostFsWatchHandle;
  readonly listeners: Set<(change: HostFsChange) => void>;
}

interface RawWatchLease extends IDisposable {
  readonly key: string;
  readonly ready: Promise<void>;
}

interface WatchSlot {
  readonly key: string;
  readonly lease: RawWatchLease;
}

interface SharedPathState {
  readonly key: string;
  readonly lexicalPath: string;
  readonly options: NormalizedWatchOptions;
  readonly subscribers: Set<FileSourceWatch>;
  targetSlot: WatchSlot | undefined;
  lexicalSlot: WatchSlot | undefined;
  targetAncestorSlot: WatchSlot | undefined;
  canonicalTarget: string | undefined;
  missingCanonicalPath: string | undefined;
  available: boolean;
  initialized: boolean;
  advanceTail: Promise<void>;
}

export class FileSourceMonitorService extends Disposable implements IFileSourceMonitor {
  declare readonly _serviceBrand: undefined;

  private readonly states = new Map<string, SharedPathState>();
  private readonly rawWatches = new Map<string, RawWatchEntry>();
  private readonly subscriptions = new Set<FileSourceWatch>();
  private disposed = false;

  constructor(
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IHostFsWatchService private readonly hostFsWatch: IHostFsWatchService,
  ) {
    super();
  }

  createWatch(
    options: FileSourceWatchOptions,
    onDidChange: () => void,
  ): IFileSourceWatch {
    const watch = new FileSourceWatch(this, normalizeOptions(options), onDidChange);
    if (this.disposed) {
      watch.dispose();
      return watch;
    }
    this.subscriptions.add(watch);
    return watch;
  }

  setPaths(watch: FileSourceWatch, paths: readonly string[]): Promise<void> {
    if (this.disposed || watch.isDisposed) return Promise.resolve();
    const nextKeys = new Set<string>();
    const waits: Promise<void>[] = [];
    for (const candidate of paths) {
      const lexicalPath = normalizePath(candidate);
      const key = pathStateKey(lexicalPath, watch.options);
      if (nextKeys.has(key)) continue;
      nextKeys.add(key);
      if (watch.stateKeys.has(key)) continue;
      const state = this.acquireState(key, lexicalPath, watch.options, watch);
      waits.push(state.advanceTail);
    }
    for (const key of watch.stateKeys) {
      if (!nextKeys.has(key)) this.releaseState(key, watch);
    }
    watch.replaceStateKeys(nextKeys);
    return Promise.all(waits).then(() => undefined);
  }

  releaseWatch(watch: FileSourceWatch): void {
    this.subscriptions.delete(watch);
    for (const key of watch.stateKeys) this.releaseState(key, watch);
    watch.replaceStateKeys(new Set());
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const watch of this.subscriptions) watch.dispose();
    for (const state of this.states.values()) this.teardownState(state);
    this.states.clear();
    for (const entry of this.rawWatches.values()) entry.handle.dispose();
    this.rawWatches.clear();
    super.dispose();
  }

  private acquireState(
    key: string,
    lexicalPath: string,
    options: NormalizedWatchOptions,
    subscriber: FileSourceWatch,
  ): SharedPathState {
    let state = this.states.get(key);
    if (state === undefined) {
      state = {
        key,
        lexicalPath,
        options,
        subscribers: new Set(),
        targetSlot: undefined,
        lexicalSlot: undefined,
        targetAncestorSlot: undefined,
        canonicalTarget: undefined,
        missingCanonicalPath: undefined,
        available: false,
        initialized: false,
        advanceTail: Promise.resolve(),
      };
      this.states.set(key, state);
    }
    state.subscribers.add(subscriber);
    void this.queueAdvance(state);
    return state;
  }

  private releaseState(key: string, subscriber: FileSourceWatch): void {
    const state = this.states.get(key);
    if (state === undefined) return;
    state.subscribers.delete(subscriber);
    if (state.subscribers.size > 0) return;
    this.states.delete(key);
    this.teardownState(state);
  }

  private queueAdvance(state: SharedPathState): Promise<void> {
    const next = state.advanceTail.then(() => this.advanceState(state));
    state.advanceTail = next.catch(() => undefined);
    return state.advanceTail;
  }

  private async advanceState(state: SharedPathState): Promise<void> {
    if (!this.isStateLive(state)) return;
    const canonicalTarget = await this.resolveTarget(state.lexicalPath, state.options.target);
    if (!this.isStateLive(state)) return;
    if (canonicalTarget === undefined) {
      await this.armMissingState(state);
      return;
    }
    const changedTarget = state.canonicalTarget !== undefined && state.canonicalTarget !== canonicalTarget;
    const appeared = state.initialized && !state.available;
    state.available = true;
    state.initialized = true;
    state.canonicalTarget = canonicalTarget;
    state.missingCanonicalPath = undefined;
    state.targetSlot = this.replaceSlot(
      state.targetSlot,
      targetWatchSpec(canonicalTarget, state.options),
      (change) => {
        this.onTargetChange(state, change);
      },
    );
    const lexicalParent = normalizePath(dirname(state.lexicalPath));
    if (lexicalParent === canonicalTarget) {
      this.clearSlot(state.lexicalSlot);
      state.lexicalSlot = undefined;
    } else {
      state.lexicalSlot = this.replaceSlot(
        state.lexicalSlot,
        shallowWatchSpec(lexicalParent, state.options.pollingIntervalMs),
        (change) => {
          this.onLexicalParentChange(state, change);
        },
      );
    }
    this.clearSlot(state.targetAncestorSlot);
    state.targetAncestorSlot = undefined;
    await Promise.all([
      state.targetSlot.lease.ready,
      state.lexicalSlot?.lease.ready,
    ]);
    if (!this.isStateLive(state)) return;
    if (appeared || changedTarget) this.notify(state);
  }

  private async armMissingState(state: SharedPathState): Promise<void> {
    const disappeared = state.initialized && state.available;
    state.available = false;
    state.initialized = true;
    state.canonicalTarget = undefined;
    this.clearSlot(state.targetSlot);
    state.targetSlot = undefined;
    const lexicalAnchor = await this.nearestExistingDirectory(state.lexicalPath);
    if (!this.isStateLive(state)) return;
    const missingCanonicalPath = await this.resolveMissingCanonicalPath(
      state.lexicalPath,
      lexicalAnchor,
    );
    if (!this.isStateLive(state)) return;
    state.missingCanonicalPath = missingCanonicalPath;
    state.lexicalSlot = this.replaceSlot(
      state.lexicalSlot,
      shallowWatchSpec(lexicalAnchor, state.options.pollingIntervalMs),
      (change) => {
        this.onMissingChainChange(state, 'lexical', change);
      },
    );
    let targetAnchor: string | undefined;
    if (missingCanonicalPath === undefined || missingCanonicalPath === state.lexicalPath) {
      this.clearSlot(state.targetAncestorSlot);
      state.targetAncestorSlot = undefined;
    } else {
      targetAnchor = await this.nearestExistingDirectory(missingCanonicalPath);
      if (!this.isStateLive(state)) return;
      state.targetAncestorSlot = this.replaceSlot(
        state.targetAncestorSlot,
        shallowWatchSpec(targetAnchor, state.options.pollingIntervalMs),
        (change) => {
          this.onMissingChainChange(state, 'canonical', change);
        },
      );
    }
    await Promise.all([
      state.lexicalSlot.lease.ready,
      state.targetAncestorSlot?.lease.ready,
    ]);
    if (!this.isStateLive(state)) return;
    if (disappeared) this.notify(state);
    if (await this.missingStateAdvanced(state, lexicalAnchor, missingCanonicalPath, targetAnchor)) {
      void this.queueAdvance(state);
    }
  }

  private async missingStateAdvanced(
    state: SharedPathState,
    lexicalAnchor: string,
    missingCanonicalPath: string | undefined,
    targetAnchor: string | undefined,
  ): Promise<boolean> {
    if ((await this.resolveTarget(state.lexicalPath, state.options.target)) !== undefined) {
      return this.isStateLive(state);
    }
    if (!this.isStateLive(state)) return false;
    const nextLexicalAnchor = await this.nearestExistingDirectory(state.lexicalPath);
    if (!this.isStateLive(state)) return false;
    const nextMissingCanonicalPath = await this.resolveMissingCanonicalPath(
      state.lexicalPath,
      nextLexicalAnchor,
    );
    if (!this.isStateLive(state)) return false;
    const nextTargetAnchor =
      nextMissingCanonicalPath === undefined || nextMissingCanonicalPath === state.lexicalPath
        ? undefined
        : await this.nearestExistingDirectory(nextMissingCanonicalPath);
    return (
      this.isStateLive(state) &&
      (nextLexicalAnchor !== lexicalAnchor ||
        nextMissingCanonicalPath !== missingCanonicalPath ||
        nextTargetAnchor !== targetAnchor)
    );
  }

  private onTargetChange(state: SharedPathState, change: HostFsChange): void {
    if (!this.isStateLive(state)) return;
    this.notify(state);
    if (change.action === 'deleted') void this.queueAdvance(state);
  }

  private onLexicalParentChange(state: SharedPathState, change: HostFsChange): void {
    if (!this.isStateLive(state)) return;
    if (normalizePath(change.path) === state.lexicalPath) void this.queueAdvance(state);
  }

  private onMissingChainChange(
    state: SharedPathState,
    pathKind: 'lexical' | 'canonical',
    change: HostFsChange,
  ): void {
    if (!this.isStateLive(state)) return;
    const target =
      pathKind === 'lexical' ? state.lexicalPath : state.missingCanonicalPath;
    if (target === undefined) return;
    if (isOnPathChain(target, change.path)) void this.queueAdvance(state);
  }

  private notify(state: SharedPathState): void {
    for (const subscriber of state.subscribers) subscriber.signal();
  }

  private isStateLive(state: SharedPathState): boolean {
    return !this.disposed && this.states.get(state.key) === state && state.subscribers.size > 0;
  }

  private async resolveTarget(
    lexicalPath: string,
    target: 'file' | 'directory',
  ): Promise<string | undefined> {
    try {
      const stat = await this.hostFs.stat(lexicalPath);
      if (target === 'file' ? !stat.isFile : !stat.isDirectory) return undefined;
      return normalizePath(await this.hostFs.realpath(lexicalPath));
    } catch {
      return undefined;
    }
  }

  private async nearestExistingDirectory(candidate: string): Promise<string> {
    let current = normalizePath(candidate);
    while (true) {
      try {
        if ((await this.hostFs.stat(current)).isDirectory) return current;
      } catch {
      }
      const parent = normalizePath(dirname(current));
      if (parent === current) return current;
      current = parent;
    }
  }

  private async resolveMissingCanonicalPath(
    lexicalPath: string,
    lexicalAnchor: string,
  ): Promise<string | undefined> {
    try {
      const canonicalAnchor = normalizePath(await this.hostFs.realpath(lexicalAnchor));
      return normalizePath(join(canonicalAnchor, relative(lexicalAnchor, lexicalPath)));
    } catch {
      return undefined;
    }
  }

  private replaceSlot(
    current: WatchSlot | undefined,
    spec: RawWatchSpec,
    listener: (change: HostFsChange) => void,
  ): WatchSlot {
    const key = rawWatchKey(spec);
    if (current?.key === key) return current;
    const lease = this.acquireRawWatch(spec, listener);
    current?.lease.dispose();
    return { key, lease };
  }

  private clearSlot(current: WatchSlot | undefined): void {
    current?.lease.dispose();
  }

  private acquireRawWatch(
    spec: RawWatchSpec,
    listener: (change: HostFsChange) => void,
  ): RawWatchLease {
    const key = rawWatchKey(spec);
    let entry = this.rawWatches.get(key);
    if (entry === undefined) {
      const listeners = new Set<(change: HostFsChange) => void>();
      const options: HostFsWatchOptions = {
        recursive: spec.recursive,
        depth: spec.depth,
        followSymlinks: spec.followSymlinks,
        pollingIntervalMs: spec.pollingIntervalMs,
        ignored: createIgnoredPredicate(spec),
      };
      const handle = this.hostFsWatch.watch(spec.path, options);
      entry = { handle, listeners };
      this.rawWatches.set(key, entry);
      handle.onDidChange((change) => {
        for (const currentListener of listeners) currentListener(change);
      });
    }
    entry.listeners.add(listener);
    let disposed = false;
    return {
      key,
      ready: entry.handle.ready,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const current = this.rawWatches.get(key);
        if (current === undefined) return;
        current.listeners.delete(listener);
        if (current.listeners.size > 0) return;
        current.handle.dispose();
        this.rawWatches.delete(key);
      },
    };
  }

  private teardownState(state: SharedPathState): void {
    this.clearSlot(state.targetSlot);
    this.clearSlot(state.lexicalSlot);
    this.clearSlot(state.targetAncestorSlot);
    state.targetSlot = undefined;
    state.lexicalSlot = undefined;
    state.targetAncestorSlot = undefined;
  }
}

class FileSourceWatch implements IFileSourceWatch {
  private keys = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly owner: FileSourceMonitorService,
    readonly options: NormalizedWatchOptions,
    private readonly onDidChange: () => void,
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  get stateKeys(): ReadonlySet<string> {
    return this.keys;
  }

  setPaths(paths: readonly string[]): Promise<void> {
    return this.owner.setPaths(this, paths);
  }

  replaceStateKeys(keys: Set<string>): void {
    this.keys = keys;
  }

  signal(): void {
    if (this.disposed || this.timer !== undefined) return;
    if (this.options.debounceMs === 0) {
      this.onDidChange();
      return;
    }
    const timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) this.onDidChange();
    }, this.options.debounceMs);
    timer.unref?.();
    this.timer = timer;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.owner.releaseWatch(this);
  }
}

function normalizeOptions(options: FileSourceWatchOptions): NormalizedWatchOptions {
  return {
    target: options.target,
    recursive: options.recursive ?? false,
    depth: options.depth,
    followSymlinks: options.followSymlinks ?? false,
    pollingIntervalMs: options.pollingIntervalMs,
    ignoredPathNames: [...new Set(options.ignoredPathNames ?? [])].toSorted(),
    ignoreDotDirectories: options.ignoreDotDirectories ?? false,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
  };
}

function pathStateKey(path: string, options: NormalizedWatchOptions): string {
  return JSON.stringify([
    path,
    options.target,
    options.recursive,
    options.depth,
    options.followSymlinks,
    options.pollingIntervalMs,
    options.ignoredPathNames,
    options.ignoreDotDirectories,
  ]);
}

function targetWatchSpec(path: string, options: NormalizedWatchOptions): RawWatchSpec {
  return {
    path,
    recursive: options.recursive,
    depth: options.depth,
    followSymlinks: options.followSymlinks,
    pollingIntervalMs: options.pollingIntervalMs,
    ignoredPathNames: options.ignoredPathNames,
    ignoreDotDirectories: options.ignoreDotDirectories,
  };
}

function shallowWatchSpec(
  path: string,
  pollingIntervalMs: number | undefined,
): RawWatchSpec {
  return {
    path,
    recursive: false,
    depth: undefined,
    followSymlinks: false,
    pollingIntervalMs,
    ignoredPathNames: [],
    ignoreDotDirectories: false,
  };
}

function rawWatchKey(spec: RawWatchSpec): string {
  return JSON.stringify([
    spec.path,
    spec.recursive,
    spec.depth,
    spec.followSymlinks,
    spec.pollingIntervalMs,
    spec.ignoredPathNames,
    spec.ignoreDotDirectories,
  ]);
}

function createIgnoredPredicate(spec: RawWatchSpec): ((path: string) => boolean) | undefined {
  if (spec.ignoredPathNames.length === 0 && !spec.ignoreDotDirectories) return undefined;
  const ignoredNames = new Set(spec.ignoredPathNames);
  return (candidate) => {
    const rel = relative(spec.path, normalizePath(candidate));
    if (rel === '' || rel.startsWith('..')) return false;
    const segments = rel.split(/[\\/]+/).filter((segment) => segment.length > 0);
    return segments.some(
      (segment, index) =>
        ignoredNames.has(segment) ||
        (spec.ignoreDotDirectories &&
          segment.startsWith('.') &&
          (index < segments.length - 1 || !segment.endsWith('.md'))),
    );
  };
}

function isOnPathChain(target: string, changedPath: string): boolean {
  const normalizedTarget = normalizePath(target);
  const normalizedChange = normalizePath(changedPath);
  return (
    normalizedTarget === normalizedChange ||
    normalizedTarget.startsWith(`${normalizedChange}/`)
  );
}

function normalizePath(value: string): string {
  return normalize(value).replaceAll('\\', '/');
}

registerScopedService(
  LifecycleScope.App,
  IFileSourceMonitor,
  FileSourceMonitorService,
  ScopeActivation.OnScopeCreated,
  'fileSourceMonitor',
);
