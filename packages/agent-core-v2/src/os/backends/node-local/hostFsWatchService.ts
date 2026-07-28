/**
 * `hostFsWatch` domain (L1) — `IHostFsWatchService` implementation.
 *
 * Wraps `chokidar` to report raw create/modify/delete events under an absolute
 * path. Each `watch()` call owns an independent `FSWatcher`; disposing the
 * handle closes it. Bound at App scope.
 */

import { FSWatcher } from 'chokidar';

import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

import {
  type HostFsChange,
  type HostFsChangeAction,
  type HostFsChangeKind,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

const DEFAULT_IGNORED = (p: string): boolean => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p);

class HostFsWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly emitter: Emitter<HostFsChange>;
  private readonly watcher: FSWatcher;
  private readyResolver: (() => void) | undefined;
  private disposed = false;

  constructor(path: string, options: HostFsWatchOptions | undefined) {
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.watcher = new FSWatcher({
      ignoreInitial: true,
      persistent: false,
      followSymlinks: options?.followSymlinks ?? false,
      depth: options?.recursive === false ? 0 : options?.depth,
      usePolling: options?.pollingIntervalMs !== undefined,
      interval: options?.pollingIntervalMs ?? 100,
      ignored: options?.ignored ?? DEFAULT_IGNORED,
    });
    this.ready = new Promise((resolve) => {
      this.readyResolver = resolve;
    });
    this.watcher.once('ready', () => {
      this.markReady();
    });
    this.watcher.once('error', () => {
      this.markReady();
    });
    this.watcher.on('all', (eventName: string, absPath: string) => {
      const mapped = mapChokidarEvent(eventName, absPath);
      if (mapped !== undefined) this.emitter.fire(mapped);
    });
    this.watcher.on('error', (error: unknown) => {
      onUnexpectedError(error);
    });
    this.watcher.add(path);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.markReady();
    void this.watcher.close().catch(() => undefined);
    this.emitter.dispose();
  }

  private markReady(): void {
    const resolve = this.readyResolver;
    this.readyResolver = undefined;
    resolve?.();
  }
}

export class HostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    return new HostFsWatchHandle(path, options);
  }
}

function mapChokidarEvent(eventName: string, absPath: string): HostFsChange | undefined {
  const mapped = mapActionAndKind(eventName);
  if (mapped === undefined) return undefined;
  return { path: absPath, action: mapped.action, kind: mapped.kind };
}

function mapActionAndKind(
  eventName: string,
): { action: HostFsChangeAction; kind: HostFsChangeKind } | undefined {
  switch (eventName) {
    case 'add':
      return { action: 'created', kind: 'file' };
    case 'addDir':
      return { action: 'created', kind: 'directory' };
    case 'change':
      return { action: 'modified', kind: 'file' };
    case 'unlink':
      return { action: 'deleted', kind: 'file' };
    case 'unlinkDir':
      return { action: 'deleted', kind: 'directory' };
    default:
      return undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostFsWatchService,
  HostFsWatchService,
  ScopeActivation.OnScopeCreated,
  'hostFsWatch',
);
