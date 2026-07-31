/**
 * `skillCatalog` domain (L3) — skill-root candidate watcher.
 *
 * Watches a dynamic set of skill-root candidates (existing or not) through
 * the os `IHostFsWatchService` and re-fires one debounced callback. An
 * existing candidate gets a recursive watch on its realpath (a symlinked
 * skill bundle is watched at its target); a missing one gets a shallow watch
 * on its nearest existing ancestor — a recursive watch bound at the
 * candidate can never fire while a parent directory is missing too, so the
 * ancestor watch re-arms the entry as the chain materializes. Events inside
 * a watched root are pruned to the discovery traversal policy
 * (`node_modules` and dot-directories ignored). Plain helper constructed and
 * disposed by its owner — not a scoped service.
 */

import { dirname, normalize, relative } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { TimeoutTimer } from '#/_base/utils/timer';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

import { isSkillTraversalDirectory } from './skillTraversal';

const WATCH_DEBOUNCE_MS = 300;

interface WatchEntry {
  /** Realpath of the existing candidate (target watch) or of the nearest existing ancestor (anchor watch). */
  readonly watchedPath: string;
  readonly isTarget: boolean;
  readonly handle: IHostFsWatchHandle;
}

export class SkillRootWatcher extends Disposable {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly debounce = this._register(new TimeoutTimer());
  private armTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly hostFsWatch: IHostFsWatchService,
    private readonly hostFs: IHostFileSystem,
    private readonly onChanged: () => void,
  ) {
    super();
  }

  /** Replaces the candidate set; resolves once every added candidate is armed. */
  async setPaths(candidates: readonly string[]): Promise<void> {
    const next = new Set(candidates.map(normalizePath));
    for (const [candidate, entry] of this.entries) {
      if (next.has(candidate)) continue;
      entry.handle.dispose();
      this.entries.delete(candidate);
    }
    const arming: Promise<void>[] = [];
    for (const candidate of next) {
      if (!this.entries.has(candidate)) arming.push(this.enqueue(() => this.arm(candidate)));
    }
    await Promise.all(arming);
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.handle.dispose();
    this.entries.clear();
    super.dispose();
  }

  /** Serializes (re-)arming so event-driven and setPaths-driven arming never interleave. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.armTail.then(operation);
    this.armTail = next.catch(() => undefined);
    return next;
  }

  private async arm(candidate: string): Promise<void> {
    const target = await this.existingDirRealpath(candidate);
    const watchedPath = target ?? (await this.nearestExistingDirRealpath(candidate));
    if (this.disposed || this.entries.has(candidate) || watchedPath === undefined) return;
    const handle =
      target !== undefined
        ? this.hostFsWatch.watch(watchedPath, {
            recursive: true,
            ignored: skillTreeIgnored(watchedPath),
          })
        : this.hostFsWatch.watch(watchedPath, { recursive: false });
    this.entries.set(candidate, { watchedPath, isTarget: target !== undefined, handle });
    handle.onDidChange((change) => {
      this.onFsChange(candidate, change);
    });
  }

  private onFsChange(candidate: string, change: HostFsChange): void {
    const entry = this.entries.get(candidate);
    if (entry === undefined || this.disposed) return;
    if (entry.isTarget) {
      this.schedule();
      // The watched root itself went away — re-arm on the ancestor chain so
      // a later re-creation is still caught.
      if (change.action === 'deleted' && normalizePath(change.path) === entry.watchedPath) {
        this.dropEntry(candidate, entry);
        void this.enqueue(() => this.arm(candidate));
      }
      return;
    }
    // Anchor event: the chain towards a missing candidate may have advanced.
    void this.enqueue(() => this.rearmMissing(candidate));
  }

  private async rearmMissing(candidate: string): Promise<void> {
    const entry = this.entries.get(candidate);
    if (entry === undefined || entry.isTarget || this.disposed) return;
    const target = await this.existingDirRealpath(candidate);
    const watchedPath = target ?? (await this.nearestExistingDirRealpath(candidate));
    if (watchedPath === undefined || watchedPath === entry.watchedPath) return;
    this.dropEntry(candidate, entry);
    await this.arm(candidate);
    // Only the candidate itself appearing is a visible change; a bare anchor
    // move (a parent directory showed up) is not.
    if (target !== undefined) this.schedule();
  }

  private dropEntry(candidate: string, entry: WatchEntry): void {
    entry.handle.dispose();
    this.entries.delete(candidate);
  }

  private schedule(): void {
    this.debounce.cancelAndSet(() => {
      this.onChanged();
    }, WATCH_DEBOUNCE_MS);
  }

  private async existingDirRealpath(candidate: string): Promise<string | undefined> {
    try {
      if (!(await this.hostFs.stat(candidate)).isDirectory) return undefined;
      return normalizePath(await this.hostFs.realpath(candidate));
    } catch {
      return undefined;
    }
  }

  private async nearestExistingDirRealpath(candidate: string): Promise<string | undefined> {
    let current = normalizePath(candidate);
    while (true) {
      try {
        if ((await this.hostFs.stat(current)).isDirectory) {
          return normalizePath(await this.hostFs.realpath(current));
        }
      } catch {
      }
      const parent = normalizePath(dirname(current));
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

function skillTreeIgnored(root: string): (path: string) => boolean {
  return (path) => {
    const rel = relative(root, normalizePath(path));
    if (rel === '' || rel.startsWith('..')) return false;
    return rel.split('/').some((segment) => !isSkillTraversalDirectory(segment));
  };
}

function normalizePath(value: string): string {
  return normalize(value).replaceAll('\\', '/');
}
