/**
 * `telemetry` domain (L1) — `ITelemetryService` implementation.
 *
 * Owns the appender set, enabled flag, and root context, and creates forwarding
 * context views that merge scoped properties at emission time. Views retain no
 * transport state, so appender and enablement changes remain controlled by the
 * App-scoped root. Has no cross-domain collaborators.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { BugIndicatingError } from '#/errors';

import type {
  StrictPropertyCheck,
  TelemetryEventName,
  TelemetryEventPayload,
} from './events';
import {
  ITelemetryService,
  type ITelemetryAppender,
  type ITelemetryAppenderRegistration,
  nullTelemetryAppender,
  type TelemetryContextPatch,
  type TelemetryProperties,
  type TelemetryShutdownOptions,
} from './telemetry';

export class TelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined;

  private appenders: ITelemetryAppender[] = [nullTelemetryAppender];
  private readonly registrations = new Map<
    ITelemetryAppender,
    ITelemetryAppenderRegistration
  >();
  private readonly retirements = new Map<ITelemetryAppender, Promise<void>>();
  private shutdownPromise: Promise<void> | null = null;
  private context: TelemetryProperties = {};
  private enabled = true;

  track(event: string, properties?: TelemetryProperties): void {
    if (!this.enabled) {
      return;
    }
    const merged = { ...this.context, ...properties };
    for (const appender of this.appenders) {
      try {
        appender.track(event, merged);
      } catch (error) {
        onUnexpectedError(error);
      }
    }
  }

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.track(event, properties as TelemetryProperties);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetryContextView(this, patch);
  }

  setContext(patch: TelemetryContextPatch): void {
    this.context = { ...this.context, ...patch };
    for (const appender of this.appenders) {
      appender.setContext?.(patch);
    }
  }

  addAppender(appender: ITelemetryAppender): ITelemetryAppenderRegistration {
    this.assertOpen();
    const existing = this.registrations.get(appender);
    if (existing !== undefined) return existing;
    this.startAppender(appender);
    this.appenders.push(appender);
    return this.createRegistration(appender);
  }

  removeAppender(
    appender: ITelemetryAppender,
    options?: TelemetryShutdownOptions,
  ): Promise<void> {
    const retirement = this.retirements.get(appender);
    if (retirement !== undefined) return this.retireAppender(appender, options);
    if (!this.appenders.includes(appender)) return Promise.resolve();
    this.appenders = this.appenders.filter((a) => a !== appender);
    return this.retireAppender(appender, options);
  }

  async setAppender(
    appender: ITelemetryAppender,
    options?: TelemetryShutdownOptions,
  ): Promise<void> {
    this.assertOpen();
    if (!this.appenders.includes(appender)) this.startAppender(appender);
    if (!this.registrations.has(appender)) this.createRegistration(appender);
    const previous = this.appenders.filter((candidate) => candidate !== appender);
    this.appenders = [appender];
    await Promise.all(previous.map((candidate) => this.retireAppender(candidate, options)));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.appenders.map((appender) => this.invokeAppender(() => appender.flush?.())),
    );
  }

  shutdown(options?: TelemetryShutdownOptions): Promise<void> {
    if (this.shutdownPromise === null) {
      const appenders = new Set([...this.appenders, ...this.retirements.keys()]);
      this.appenders = [];
      for (const appender of appenders) {
        void this.retireAppender(appender, options);
      }
      this.shutdownPromise = Promise.all(this.retirements.values()).then(() => undefined);
    } else if (options !== undefined) {
      for (const appender of this.retirements.keys()) {
        void this.retireAppender(appender, options);
      }
    }
    return this.shutdownPromise;
  }

  private startAppender(appender: ITelemetryAppender): void {
    try {
      appender.start?.();
    } catch (error) {
      onUnexpectedError(error);
    }
  }

  private createRegistration(appender: ITelemetryAppender): ITelemetryAppenderRegistration {
    const registration: ITelemetryAppenderRegistration = {
      dispose: () => {
        void this.removeAppender(appender);
      },
      shutdown: (options) => this.removeAppender(appender, options),
    };
    this.registrations.set(appender, registration);
    return registration;
  }

  private assertOpen(): void {
    if (this.shutdownPromise !== null) {
      throw new BugIndicatingError('Telemetry service has already shut down');
    }
  }

  private retireAppender(
    appender: ITelemetryAppender,
    options?: TelemetryShutdownOptions,
  ): Promise<void> {
    const retirement = this.retirements.get(appender);
    if (retirement !== undefined) {
      if (options !== undefined) {
        void this.invokeAppender(() => appender.shutdown?.(options));
      }
      return retirement;
    }
    const pending = this.invokeAppender(() => appender.shutdown?.(options));
    this.retirements.set(appender, pending);
    return pending;
  }

  private invokeAppender(operation: () => Promise<void> | void | undefined): Promise<void> {
    return Promise.resolve().then(operation).catch(onUnexpectedError);
  }
}

class TelemetryContextView implements ITelemetryService {
  declare readonly _serviceBrand: undefined;
  private context: TelemetryProperties;

  constructor(
    private readonly root: ITelemetryService,
    context: TelemetryProperties,
  ) {
    this.context = context;
  }

  track(event: string, properties?: TelemetryProperties): void {
    this.root.track(event, { ...this.context, ...properties });
  }

  track2<K extends TelemetryEventName, E extends TelemetryEventPayload<K> = never>(
    event: K,
    properties?: StrictPropertyCheck<TelemetryEventPayload<K>, E>,
  ): void {
    this.track(event, properties as TelemetryProperties);
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetryContextView(this.root, { ...this.context, ...patch });
  }

  setContext(patch: TelemetryContextPatch): void {
    this.context = { ...this.context, ...patch };
  }

  addAppender(appender: ITelemetryAppender): ITelemetryAppenderRegistration {
    return this.root.addAppender(appender);
  }

  removeAppender(
    appender: ITelemetryAppender,
    options?: TelemetryShutdownOptions,
  ): Promise<void> {
    return this.root.removeAppender(appender, options);
  }

  setAppender(
    appender: ITelemetryAppender,
    options?: TelemetryShutdownOptions,
  ): Promise<void> {
    return this.root.setAppender(appender, options);
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  flush(): Promise<void> {
    return this.root.flush();
  }

  shutdown(options?: TelemetryShutdownOptions): Promise<void> {
    return this.root.shutdown(options);
  }
}

registerScopedService(
  LifecycleScope.App,
  ITelemetryService,
  TelemetryService,
  ScopeActivation.OnScopeCreated,
  'telemetry',
);
