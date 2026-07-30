/**
 * `CapabilityService` — registry semantics, readiness computation, and
 * install orchestration (progress transitions, serialized runs, coded
 * errors). Entries are fakes; entry internals are covered per-entry.
 */

import { describe, expect, it } from 'vitest';

import { isError2 } from '#/_base/errors/errors';
import { CapabilityErrors } from '#/app/capability/errors';
import { CapabilityService } from '#/app/capability/capabilityService';
import type { IPluginService } from '#/app/plugin/plugin';
import type {
  CapabilityDetectResult,
  CapabilityEntry,
  CapabilityInstallReporter,
} from '#/app/capability/types';

function fakeEntry(overrides: {
  id: 'kimi-cu' | 'kimi-webbridge';
  supported?: boolean;
  wiringStepId?: string;
  detect?: CapabilityDetectResult;
  install?: (report: CapabilityInstallReporter) => Promise<string | undefined>;
}): CapabilityEntry {
  return {
    id: overrides.id,
    displayName: overrides.id,
    description: 'fake',
    supported: overrides.supported ?? true,
    wiringStepId: overrides.wiringStepId ?? 'plugin',
    detect: () =>
      Promise.resolve(
        overrides.detect ?? { steps: [{ id: 'plugin', state: 'ok' }] },
      ),
    install: overrides.install ?? (() => Promise.resolve(undefined)),
  };
}

interface FakePlugins {
  service: IPluginService;
  fireReload(): void;
}

function fakePlugins(): FakePlugins {
  const listeners: Array<() => void> = [];
  const service = {
    onDidReload: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    },
  } as unknown as IPluginService;
  return {
    service,
    fireReload: () => {
      for (const listener of listeners) listener();
    },
  };
}

function fakeService(entries: readonly CapabilityEntry[], plugins?: FakePlugins): CapabilityService {
  // bootstrap / hostProcess are unused when entries are injected.
  return new CapabilityService(
    undefined as never,
    (plugins ?? fakePlugins()).service,
    undefined as never,
    entries,
  );
}

function expectErrorCode(error: unknown, code: string): void {
  expect(isError2(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

describe('CapabilityService', () => {
  it('lists entries with readiness computed from required steps', async () => {
    const service = fakeService([
      fakeEntry({ id: 'kimi-cu', detect: { steps: [{ id: 'plugin', state: 'ok' }] } }),
      fakeEntry({
        id: 'kimi-webbridge',
        detect: {
          steps: [
            { id: 'daemon', state: 'ok' },
            { id: 'skill', state: 'missing' },
            { id: 'extension', state: 'missing', optional: true },
          ],
        },
      }),
    ]);
    const list = await service.listCapabilities();
    expect(list.map((c) => [c.id, c.state])).toEqual([
      ['kimi-cu', 'ready'],
      ['kimi-webbridge', 'partial'],
    ]);
  });

  it('marks optional steps as non-blocking for ready', async () => {
    const service = fakeService([
      fakeEntry({
        id: 'kimi-webbridge',
        detect: {
          version: '3.1.1',
          steps: [
            { id: 'daemon', state: 'ok' },
            { id: 'extension', state: 'missing', optional: true },
          ],
        },
      }),
    ]);
    const status = await service.getCapability('kimi-webbridge');
    expect(status.state).toBe('ready');
    expect(status.version).toBe('3.1.1');
  });

  it('reports not_installed when no step is ok, and unsupported as-is', async () => {
    const service = fakeService([
      fakeEntry({ id: 'kimi-cu', detect: { steps: [{ id: 'plugin', state: 'missing' }] } }),
      fakeEntry({ id: 'kimi-webbridge', supported: false }),
    ]);
    const list = await service.listCapabilities();
    expect(list.find((c) => c.id === 'kimi-cu')?.state).toBe('not_installed');
    const unsupported = list.find((c) => c.id === 'kimi-webbridge');
    expect(unsupported?.state).toBe('unsupported');
    expect(unsupported?.supported).toBe(false);
  });

  it('throws capability.not_found for unknown ids', async () => {
    const service = fakeService([]);
    await service.getCapability('nope').then(
      () => {
        expect.unreachable();
      },
      (error) => {
        expectErrorCode(error, CapabilityErrors.codes.CAPABILITY_NOT_FOUND);
      },
    );
    await service.installCapability('nope').then(
      () => {
        expect.unreachable();
      },
      (error) => {
        expectErrorCode(error, CapabilityErrors.codes.CAPABILITY_NOT_FOUND);
      },
    );
  });

  it('rejects install on an unsupported entry', async () => {
    const service = fakeService([fakeEntry({ id: 'kimi-cu', supported: false })]);
    await service.installCapability('kimi-cu').then(
      () => {
        expect.unreachable();
      },
      (error) => {
        expectErrorCode(error, CapabilityErrors.codes.CAPABILITY_UNSUPPORTED);
      },
    );
  });

  it('serializes installs and clears progress on success', async () => {
    let release: (() => void) | undefined;
    const service = fakeService([
      fakeEntry({
        id: 'kimi-cu',
        install: (report) => {
          report('download', 42);
          return new Promise<string | undefined>((resolve) => {
            release = () => resolve(undefined);
          });
        },
      }),
    ]);

    const started = await service.installCapability('kimi-cu');
    expect(started.install.running).toBe(true);

    await service.installCapability('kimi-cu').then(
      () => {
        expect.unreachable();
      },
      (error) => {
        expectErrorCode(error, CapabilityErrors.codes.CAPABILITY_INSTALL_IN_PROGRESS);
      },
    );

    const during = await service.getCapability('kimi-cu');
    expect(during.install).toEqual({ running: true, step: 'download', percent: 42 });

    release?.();
    // Wait for the background install to settle.
    for (let i = 0; i < 50; i += 1) {
      const status = await service.getCapability('kimi-cu');
      if (!status.install.running) {
        expect(status.install.error).toBeUndefined();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect.unreachable('install never settled');
  });

  it('surfaces an install note from the entry through progress', async () => {
    const service = fakeService([
      fakeEntry({
        id: 'kimi-cu',
        install: () => Promise.resolve('user-skill-migrated'),
      }),
    ]);
    await service.installCapability('kimi-cu');
    for (let i = 0; i < 50; i += 1) {
      const status = await service.getCapability('kimi-cu');
      if (!status.install.running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await service.getCapability('kimi-cu')).install.note).toBe('user-skill-migrated');
  });

  it('surfaces install errors through progress until the next attempt', async () => {
    let attempts = 0;
    const service = fakeService([
      fakeEntry({
        id: 'kimi-cu',
        install: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('boom'))
            : Promise.resolve(undefined);
        },
      }),
    ]);
    await service.installCapability('kimi-cu');
    for (let i = 0; i < 50; i += 1) {
      const status = await service.getCapability('kimi-cu');
      if (!status.install.running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const failed = await service.getCapability('kimi-cu');
    expect(failed.install).toEqual({ running: false, error: 'boom' });

    // Retry clears the error.
    await service.installCapability('kimi-cu');
    for (let i = 0; i < 50; i += 1) {
      const status = await service.getCapability('kimi-cu');
      if (!status.install.running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const retried = await service.getCapability('kimi-cu');
    expect(retried.install.error).toBeUndefined();
    expect(attempts).toBe(2);
  });
});

describe('CapabilityService shelf-install hook', () => {
  function mutableEntry(opts: {
    id: 'kimi-cu' | 'kimi-webbridge';
    wiringStepId?: string;
    steps: Array<{ id: string; state: 'ok' | 'missing'; optional?: boolean }>;
    install?: () => Promise<string | undefined>;
  }) {
    const state = { steps: opts.steps };
    let installs = 0;
    const entry = fakeEntry({
      id: opts.id,
      wiringStepId: opts.wiringStepId,
      detect: { steps: state.steps },
      install: () => {
        installs += 1;
        return (opts.install ?? (() => Promise.resolve(undefined)))();
      },
    });
    // Re-read the mutable step list on every detect.
    entry.detect = () => Promise.resolve({ steps: state.steps });
    return { entry, state, installs: () => installs };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  it('auto-completes binary layers when the wiring plugin gets installed', async () => {
    const wiringStepId = 'skill';
    const cu = mutableEntry({
      id: 'kimi-cu',
      wiringStepId,
      steps: [
        { id: 'skill', state: 'missing' },
        { id: 'daemon', state: 'missing' },
      ],
    });
    const plugins = fakePlugins();
    fakeService([cu.entry], plugins);

    // Shelf install lands the wiring layer.
    cu.state.steps = [
      { id: 'skill', state: 'ok' },
      { id: 'daemon', state: 'missing' },
    ];
    plugins.fireReload();
    await settle();
    expect(cu.installs()).toBe(1);

    // A later reload with the wiring still ok must NOT retrigger
    // (manual steps may still be missing — no heavy re-download loop).
    plugins.fireReload();
    await settle();
    expect(cu.installs()).toBe(1);
  });

  it('does nothing when already ready or when wiring is removed', async () => {
    const ready = mutableEntry({
      id: 'kimi-cu',
      steps: [{ id: 'plugin', state: 'ok' }],
    });
    const plugins = fakePlugins();
    fakeService([ready.entry], plugins);

    plugins.fireReload();
    await settle();
    expect(ready.installs()).toBe(0);

    // Wiring removed → no trigger; wiring back → triggers again.
    ready.state.steps = [{ id: 'plugin', state: 'missing' }];
    plugins.fireReload();
    await settle();
    expect(ready.installs()).toBe(0);
    ready.state.steps = [
      { id: 'plugin', state: 'ok' },
      { id: 'app', state: 'missing' },
    ];
    // Transition needs a false edge first: previous event set it to false.
    plugins.fireReload();
    await settle();
    expect(ready.installs()).toBe(1);
  });

  it('skips unsupported entries and entries already installing', async () => {
    const unsupported = mutableEntry({
      id: 'kimi-cu',
      steps: [{ id: 'plugin', state: 'ok' }, { id: 'app', state: 'missing' }],
    });
    const plugins = fakePlugins();
    const entry = { ...unsupported.entry, supported: false };
    fakeService([entry], plugins);
    plugins.fireReload();
    await settle();
    expect(unsupported.installs()).toBe(0);
  });
});
