/**
 * Server telemetry bootstrap — wires agent-core-v2's `CloudAppender` into the
 * App-scoped `ITelemetryService` so engine events emitted inside the server
 * process (`session_started`, turn / tool / permission events, `image_compress`,
 * …) actually leave the process. Mirrors the v1 `kimi web` host
 * (`initializeServerTelemetry` in apps/kimi-code): same product app name, the
 * surface distinguished by `ui_mode = "web"`, the config `telemetry` toggle
 * honored at startup (a change takes effect on restart).
 */

import {
  createCloudAppender,
  IBootstrapService,
  IConfigService,
  type ITelemetryAppenderRegistration,
  IOAuthToolkit,
  ITelemetryService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { createKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';

// Same product as the CLI; the surface is distinguished by ui_mode (v1
// convention: CLI_USER_AGENT_PRODUCT / WEB_UI_MODE in apps/kimi-code).
const SERVER_TELEMETRY_APP_NAME = 'kimi-code-cli';
const SERVER_TELEMETRY_UI_MODE = 'web';
const TELEMETRY_DISABLE_ENV = 'KIMI_DISABLE_TELEMETRY';
const TELEMETRY_DISABLE_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);

/**
 * Cap on how long server close waits for its best-effort final flush. A wedged
 * telemetry endpoint must not hold shutdown hostage.
 */
const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 3_000;
const TELEMETRY_SHUTDOWN_HARD_CAP_GRACE_MS = 1_000;

export interface ServerTelemetry {
  readonly registration?: ITelemetryAppenderRegistration;
}

function isTelemetryDisabledByEnv(core: Scope): boolean {
  const value = core.accessor.get(IBootstrapService).getEnv(TELEMETRY_DISABLE_ENV);
  return value !== undefined && TELEMETRY_DISABLE_ENV_VALUES.has(value.trim().toLowerCase());
}

export async function initializeServerTelemetry(
  core: Scope,
  homeDir: string,
): Promise<ServerTelemetry> {
  const service = core.accessor.get(ITelemetryService);
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const enabled = config.get('telemetry') !== false;
  if (!enabled || isTelemetryDisabledByEnv(core)) return {};

  const auth = core.accessor.get(IOAuthToolkit);
  const appender = createCloudAppender(core.accessor, {
    deviceId: createKimiDeviceId(homeDir),
    appName: SERVER_TELEMETRY_APP_NAME,
    uiMode: SERVER_TELEMETRY_UI_MODE,
    model: config.get<string>('defaultModel') ?? undefined,
    getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
  });
  const registration = service.addAppender(appender);
  return { registration };
}

export async function shutdownServerTelemetry(
  telemetry: ServerTelemetry,
  deadlineMs = Date.now() + TELEMETRY_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (telemetry.registration === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      telemetry.registration.shutdown({ deadlineMs }),
      new Promise<void>((resolve) => {
        timer = setTimeout(
          resolve,
          Math.max(0, deadlineMs - Date.now()) + TELEMETRY_SHUTDOWN_HARD_CAP_GRACE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
