/**
 * `runtimeSession` domain (L6) — the empty / unavailable OS-handle
 * projections seeded into runtime-driven Session scopes when the lease does
 * not project the corresponding `os.*` capability (plan §5.3, §7.4).
 *
 * These projections are how Session Core enforces "no OS provider lookup past
 * the lease" mechanically: Session/Agent services always resolve the
 * `os/interface` contracts at SESSION scope — either the lease's handles or
 * these projections — never the App container's host services. The
 * projections behave like an empty, read-only host: every read reports the
 * `os.fs.not_found` shape consumers already tolerate (missing AGENTS.md,
 * missing skill files, …), while every mutation, spawn, terminal or watch
 * request fails with `session.capability_unavailable`.
 *
 * The functional OS contributions (session fs/process/terminal services and
 * the os tools) are additionally filtered out of the scope entirely by their
 * registration `requires` — these projections exist so the CORE services that
 * merely reference host interfaces for secondary discovery (profile,
 * catalogs, plan, permission policies) keep constructing without touching
 * the host.
 */

import {
  SessionHostRuntimeError,
  SessionHostRuntimeErrors,
} from '#/app/sessionHostRuntime/errors';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { HostDirEntry, HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostFsWatchHandle, IHostFsWatchService } from '#/os/interface/hostFsWatch';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { IHostTerminalService } from '#/os/interface/terminal';

function capabilityUnavailable(what: string): SessionHostRuntimeError {
  return new SessionHostRuntimeError(
    SessionHostRuntimeErrors.codes.SESSION_CAPABILITY_UNAVAILABLE,
    `${what} is not available: the session's runtime does not project this OS capability`,
  );
}

function notFound(path: string): HostFsError {
  return new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, 'read failed: path does not exist', {
    details: { path },
  });
}

/**
 * An `IHostFileSystem` shaped like an empty disk: reads miss the way a
 * missing file misses, writes fail with `session.capability_unavailable`.
 */
export class EmptyHostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  readText(path: string): Promise<string> {
    return Promise.reject(notFound(path));
  }

  writeText(path: string, _data: string): Promise<void> {
    return Promise.reject(capabilityUnavailable(`writing '${path}'`));
  }

  appendText(path: string, _data: string): Promise<void> {
    return Promise.reject(capabilityUnavailable(`appending '${path}'`));
  }

  readBytes(path: string): Promise<Uint8Array> {
    return Promise.reject(notFound(path));
  }

  writeBytes(path: string, _data: Uint8Array): Promise<void> {
    return Promise.reject(capabilityUnavailable(`writing '${path}'`));
  }

  readLines(path: string): AsyncGenerator<string> {
    const fail = async function* (): AsyncGenerator<string> {
      yield await Promise.reject(notFound(path));
    };
    return fail();
  }

  createExclusive(path: string, _data: Uint8Array): Promise<boolean> {
    return Promise.reject(capabilityUnavailable(`creating '${path}'`));
  }

  stat(path: string): Promise<HostFileStat> {
    return Promise.reject(notFound(path));
  }

  lstat(path: string): Promise<HostFileStat> {
    return Promise.reject(notFound(path));
  }

  readdir(path: string): Promise<readonly HostDirEntry[]> {
    return Promise.reject(notFound(path));
  }

  mkdir(path: string): Promise<void> {
    return Promise.reject(capabilityUnavailable(`mkdir '${path}'`));
  }

  remove(path: string): Promise<void> {
    return Promise.reject(capabilityUnavailable(`removing '${path}'`));
  }

  realpath(path: string): Promise<string> {
    return Promise.reject(notFound(path));
  }
}

export class UnavailableHostProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  spawn(command: string): Promise<never> {
    return Promise.reject(capabilityUnavailable(`spawning '${command}'`));
  }
}

export class UnavailableHostTerminalService implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  spawn(): Promise<never> {
    return Promise.reject(capabilityUnavailable('spawning a terminal'));
  }
}

export class UnavailableHostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  watch(path: string): IHostFsWatchHandle {
    throw capabilityUnavailable(`watching '${path}'`);
  }
}

/**
 * Host-fact snapshot of a host that is not there: POSIX-flavored placeholders
 * with an empty home directory, so discovery rooted at `homeDir` finds
 * nothing. `ready` is already settled.
 */
export class EmptyHostEnvironment implements IHostEnvironment {
  declare readonly _serviceBrand: undefined;

  readonly osKind = 'unknown';
  readonly osArch = 'unknown';
  readonly osVersion = '';
  readonly shellName = 'sh' as const;
  readonly shellPath = '/bin/sh';
  readonly pathClass = 'posix' as const;
  readonly homeDir = '';
  readonly ready = Promise.resolve();
}

/** Shared instances — the projections carry no state. */
export const EMPTY_HOST_FILE_SYSTEM = new EmptyHostFileSystem();
export const UNAVAILABLE_HOST_PROCESS_SERVICE = new UnavailableHostProcessService();
export const UNAVAILABLE_HOST_TERMINAL_SERVICE = new UnavailableHostTerminalService();
export const UNAVAILABLE_HOST_FS_WATCH_SERVICE = new UnavailableHostFsWatchService();
export const EMPTY_HOST_ENVIRONMENT = new EmptyHostEnvironment();
