/**
 * `os` test stubs — shared `IHostFsWatchService` fake for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../os/stubs`).
 * The fake records watched paths and lets tests fire synthetic change events;
 * events reach a watcher when the changed path is its root or underneath it.
 */

import { Emitter } from '#/_base/event';
import {
  type HostFsChange,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

export interface StubHostFsWatch extends IHostFsWatchService {
  fire(path: string, change?: Partial<HostFsChange>): void;
  watchedPaths(): readonly string[];
}

export function stubHostFsWatch(): StubHostFsWatch {
  const watchers: Array<{ readonly path: string; readonly emitter: Emitter<HostFsChange> }> = [];
  return {
    _serviceBrand: undefined,
    watch(path: string, _options?: HostFsWatchOptions): IHostFsWatchHandle {
      const emitter = new Emitter<HostFsChange>();
      const entry = { path, emitter };
      watchers.push(entry);
      return {
        onDidChange: emitter.event,
        dispose: () => {
          const index = watchers.indexOf(entry);
          if (index >= 0) watchers.splice(index, 1);
          emitter.dispose();
        },
      };
    },
    fire(path: string, change?: Partial<HostFsChange>): void {
      for (const watcher of watchers) {
        if (path === watcher.path || path.startsWith(`${watcher.path}/`)) {
          watcher.emitter.fire({ path, action: 'modified', kind: 'file', ...change });
        }
      }
    },
    watchedPaths(): readonly string[] {
      return watchers.map((watcher) => watcher.path);
    },
  };
}
