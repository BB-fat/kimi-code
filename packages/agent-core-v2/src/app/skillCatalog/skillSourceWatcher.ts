/**
 * `skillCatalog` domain (L3) — file-watch helper for file-based producers.
 *
 * Watches a producer's candidate paths (skill roots, AGENTS.md files) through
 * the os `IHostFsWatchService`, debounces raw fs events into one callback, and
 * lets the owner re-fire its change signal. Each candidate is watched
 * recursively, and its parent directory is watched non-recursively as well:
 * chokidar cannot bind a deep watch whose parent is still missing, so a
 * parent event re-binds the recursive watch — this is how a path created
 * mid-session (first `.agents/skills` in a project, a new `.kimi-code/AGENTS.md`)
 * gets detected. An optional `filter` confines recursive-handle events to
 * relevant paths (parent-handle events always pass — they carry the re-bind).
 * Plain helper constructed and disposed by its owner — not a scoped service.
 */

import { Disposable } from '#/_base/di/lifecycle';
import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

export const SKILL_SOURCE_WATCH_DEBOUNCE_MS = 300;

interface WatchEntry {
  recursive: IHostFsWatchHandle;
  parent: IHostFsWatchHandle | undefined;
}

export class SkillSourceWatcher extends Disposable {
  private readonly entries = new Map<string, WatchEntry>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly hostFsWatch: IHostFsWatchService,
    private readonly onChanged: () => void,
    private readonly filter?: (change: HostFsChange) => boolean,
  ) {
    super();
  }

  setPaths(paths: readonly string[]): void {
    const next = new Set(paths);
    for (const [path, entry] of this.entries) {
      if (next.has(path)) continue;
      entry.recursive.dispose();
      entry.parent?.dispose();
      this.entries.delete(path);
    }
    for (const path of next) {
      if (!this.entries.has(path)) this.watchCandidate(path);
    }
  }

  private watchCandidate(path: string): void {
    const recursive = this.hostFsWatch.watch(path, { recursive: true });
    recursive.onDidChange((change) => {
      if (this.filter === undefined || this.filter(change)) this.schedule();
    });
    const separator = path.includes('\\') ? '\\' : '/';
    const parentPath = path.slice(0, Math.max(0, path.lastIndexOf(separator)));
    const entry: WatchEntry = { recursive, parent: undefined };
    if (parentPath.length > 0 && parentPath !== path) {
      const parent = this.hostFsWatch.watch(parentPath, { recursive: false });
      // Parent events always pass the filter: they re-bind the recursive watch
      // so a candidate whose subtree did not exist yet still gets detected.
      parent.onDidChange(() => this.onParentChange(path));
      entry.parent = parent;
    }
    this.entries.set(path, entry);
  }

  private onParentChange(path: string): void {
    const entry = this.entries.get(path);
    if (entry === undefined) return;
    // The parent (re)appeared or churned: re-bind the recursive watch so it
    // can descend into the now-existing subtree, then re-scan via the
    // debounced callback.
    entry.recursive.dispose();
    const recursive = this.hostFsWatch.watch(path, { recursive: true });
    recursive.onDidChange((change) => {
      if (this.filter === undefined || this.filter(change)) this.schedule();
    });
    entry.recursive = recursive;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    const timer = setTimeout(() => {
      this.timer = undefined;
      this.onChanged();
    }, SKILL_SOURCE_WATCH_DEBOUNCE_MS);
    timer.unref?.();
    this.timer = timer;
  }

  override dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const entry of this.entries.values()) {
      entry.recursive.dispose();
      entry.parent?.dispose();
    }
    this.entries.clear();
    super.dispose();
  }
}
