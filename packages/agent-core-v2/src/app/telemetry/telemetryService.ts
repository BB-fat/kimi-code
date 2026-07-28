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

interface PendingTelemetryEvent {
  readonly event: string;
  readonly properties: TelemetryProperties;
}

export class TelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined;

  private appenders: ITelemetryAppender[] = [nullTelemetryAppender];
  private readonly registrations = new Map<
    ITelemetryAppender,
    ITelemetryAppenderRegistration
  >();
  private readonly retirements = new Map<ITelemetryAppender, Promise<void>>();
  private readonly retiredAppenders = new WeakSet<ITelemetryAppender>();
  private appenderTransition: Promise<void> | null = null;
  private pendingEvents: PendingTelemetryEvent[] | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private context: TelemetryProperties = {};
  private enabled = true;

  track(event: string, properties?: TelemetryProperties): void {
    if (!this.enabled || this.shutdownPromise !== null) {
      return;
    }
    const merged = { ...this.context, ...properties };
    if (this.pendingEvents !== null) {
      this.pendingEvents.push({ event, properties: merged });
      return;
    }
    for (const appender of this.appenders) {
      this.trackAppender(appender, event, merged);
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
    this.assertReusable(appender);
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
    this.assertReusable(appender);
    const previousTransition = this.appenderTransition;
    const transition = (async () => {
      if (previousTransition !== null) await previousTransition;
      await this.replaceAppender(appender, options);
    })();
    this.appenderTransition = transition;
    try {
      await transition;
    } finally {
      if (this.appenderTransition === transition) this.appenderTransition = null;
    }
  }

  private async replaceAppender(
    appender: ITelemetryAppender,
    options?: TelemetryShutdownOptions,
  ): Promise<void> {
    this.assertReusable(appender);
    const active = this.appenders.includes(appender);
    const previous = this.appenders.filter((candidate) => candidate !== appender);
    const pendingEvents: PendingTelemetryEvent[] = [];
    this.pendingEvents = pendingEvents;
    this.appenders = [];
    await Promise.all(previous.map((candidate) => this.retireAppender(candidate, options)));
    if (active) {
      if (previous.length > 0) {
        await this.invokeAppender(() => appender.recover?.());
      }
    } else {
      this.startAppender(appender);
    }
    if (!this.registrations.has(appender)) this.createRegistration(appender);
    this.appenders = [appender];
    for (const pending of pendingEvents) {
      this.trackAppender(appender, pending.event, pending.properties);
    }
    if (this.pendingEvents === pendingEvents) this.pendingEvents = null;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async flush(): Promise<void> {
    const transition = this.appenderTransition;
    if (transition !== null) await transition;
    await Promise.all(
      this.appenders.map((appender) => this.invokeAppender(() => appender.flush?.())),
    );
  }

  shutdown(options?: TelemetryShutdownOptions): Promise<void> {
    if (this.shutdownPromise === null) {
      this.shutdownPromise = this.shutdownAfterTransition(this.appenderTransition, options);
    } else if (options !== undefined) {
      const tighten = (): void => {
        const appenders = new Set([...this.appenders, ...this.retirements.keys()]);
        for (const appender of appenders) {
          void this.retireAppender(appender, options);
        }
      };
      const transition = this.appenderTransition;
      if (transition === null) tighten();
      else void transition.then(tighten);
    }
    return this.shutdownPromise;
  }

  private async shutdownAfterTransition(
    transition: Promise<void> | null,
    options?: TelemetryShutdownOptions,
  ): Promise<void> {
    if (transition !== null) await transition;
    const appenders = new Set([...this.appenders, ...this.retirements.keys()]);
    this.appenders = [];
    for (const appender of appenders) {
      void this.retireAppender(appender, options);
    }
    await Promise.all(this.retirements.values());
  }

  private trackAppender(
    appender: ITelemetryAppender,
    event: string,
    properties: TelemetryProperties,
  ): void {
    try {
      appender.track(event, properties);
    } catch (error) {
      onUnexpectedError(error);
    }
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

  private assertReusable(appender: ITelemetryAppender): void {
    if (this.retiredAppenders.has(appender)) {
      throw new BugIndicatingError('Telemetry appender has already shut down');
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
    if (this.retiredAppenders.has(appender)) return Promise.resolve();
    this.retiredAppenders.add(appender);
    this.registrations.delete(appender);
    const pending = this.invokeAppender(() => appender.shutdown?.(options));
    this.retirements.set(appender, pending);
    void pending.then(() => {
      if (this.retirements.get(appender) === pending) {
        this.retirements.delete(appender);
      }
    });
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
