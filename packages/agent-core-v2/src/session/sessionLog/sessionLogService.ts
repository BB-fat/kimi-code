/**
 * `sessionLog` domain — Session-scope `ILogService` implementation.
 *
 * Binds `sessionId` to every entry and writes to a rotating file under the
 * session's host directory (`logs/`, resolved through the lease's typed
 * `ISessionHostFiles` capability — the `sessionId` key is omitted from each
 * line since the path already identifies the session). Registered to the
 * single `ILogService` token at Session scope, so every Session/Agent
 * consumer injecting `@ILogService` lands here (Agent has no own binding and
 * falls back to this). Flushes synchronously when the Session scope is
 * disposed. The plain-data state (`rootLevel`) is registered into
 * `sessionState` (`ISessionStateService`) and read/written through it.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionHostFiles } from '#/session/sessionHostFiles/sessionHostFiles';
import { ISessionStateService } from '#/session/state/sessionState';

import { ILogService, type LogLevel } from '#/_base/log/log';
import { createFileLogWriter, type FileLogWriter } from '#/_base/log/fileLog';
import { ILogOptions } from '#/_base/log/logConfig';
import { BoundLogger, type LogLevelState } from '#/_base/log/logService';

export const sessionLogRootLevelKey = defineState<LogLevelState>('sessionLog.rootLevel', () => ({
  level: 'info',
}));

/**
 * Registers the root level into `sessionState` and hands the stored object to
 * the `BoundLogger` base, so base and subclass share one `LogLevelState`.
 * Runs inside the `super(...)` arguments, where `this` is not yet available.
 */
function seedRootLevel(states: ISessionStateService, level: LogLevel): LogLevelState {
  states.register(sessionLogRootLevelKey);
  states.set(sessionLogRootLevelKey, { level });
  return states.get(sessionLogRootLevelKey);
}

export class SessionLogService extends BoundLogger implements ILogService {
  declare readonly _serviceBrand: undefined;
  private readonly sink: FileLogWriter;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ILogOptions options: ILogOptions,
    @ISessionContext session: ISessionContext,
    @ISessionHostFiles hostFiles: ISessionHostFiles,
  ) {
    // The registration's `session.host_dir` gate guarantees the lease carries
    // the host-files capability object; a runtime projecting the string
    // without it is a runtime bug, not a degrade-to-app-log case.
    const sessionLogPath = hostFiles.sessionLogPath;
    if (sessionLogPath === null) {
      throw new Error(
        'SessionLogService requires the session.host_dir capability but the lease carries no host files',
      );
    }
    const sink = createFileLogWriter({
      path: sessionLogPath,
      maxBytes: options.sessionMaxBytes,
      files: options.sessionFiles,
      format: { omitContextKeys: ['sessionId'] },
    });
    super(sink, seedRootLevel(states, options.level), { sessionId: session.sessionId });
    this.sink = sink;
  }

  private get rootLevel(): LogLevelState {
    return this.states.get(sessionLogRootLevelKey);
  }

  get level(): LogLevel {
    return this.rootLevel.level;
  }

  setLevel(level: LogLevel): void {
    this.rootLevel.level = level;
  }

  flush(): Promise<void> {
    return this.sink.flush();
  }

  close(): Promise<void> {
    return this.sink.close();
  }

  override dispose(): void {
    this.sink.flushSync();
    void this.sink.close();
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ILogService,
  SessionLogService,
  ScopeActivation.OnScopeCreated,
  'log',
  // The per-session log file lives in the session's host directory; only
  // runtimes that own one (the Local workspace runtime) project the
  // `session.host_dir` capability and carry the typed `ISessionHostFiles`
  // object on their leases. Host-files-less (headless) runtime-driven
  // sessions fall back to the App log service.
  ['session.host_dir'],
);
