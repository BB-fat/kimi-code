/**
 * `capability` domain types — built-in product capabilities (kimi-cu,
 * kimi-webbridge) that bundle a binary runtime + agent wiring + manual
 * user steps. A capability is NOT a plugin: plugins are declarative
 * contributions to a session, while capabilities own imperative install
 * orchestration and a layered readiness state machine for product-specific
 * runtimes (macOS app + launchd service + TCC permissions; local HTTP
 * daemon + browser extension).
 */

export type CapabilityId = 'kimi-cu' | 'kimi-webbridge';

export type CapabilityReadiness = 'not_installed' | 'partial' | 'ready' | 'unsupported';

export type CapabilityStepState = 'ok' | 'missing' | 'failed';

/**
 * One readiness check of a capability (e.g. `plugin`, `app`, `service`,
 * `permissions`, `daemon`, `skill`, `extension`). `detail` carries a short
 * machine-oriented hint (detected version, missing path, error message).
 */
export interface CapabilityStep {
  readonly id: string;
  readonly state: CapabilityStepState;
  readonly detail?: string;
  /**
   * Optional steps never block `ready` (e.g. the WebBridge browser
   * extension — a soft gate surfaced as a hint, with official error guidance
   * covering use-time failures).
   */
  readonly optional?: boolean;
}

/** Live install progress, polled by clients (no WS events in v1). */
export interface CapabilityInstallProgress {
  readonly running: boolean;
  /** Current step id while running. */
  readonly step?: string;
  /** 0–100 while a download with a known content-length is in flight. */
  readonly percent?: number;
  /** Set when the last install attempt failed; cleared on the next attempt. */
  readonly error?: string;
  /**
   * Machine-key note from the last completed install (e.g.
   * 'user-skill-migrated' — a pre-existing user-source skill was replaced by
   * the plugin-managed copy). Clients localize it; cleared on the next
   * attempt.
   */
  readonly note?: string;
}

export interface CapabilityDetectResult {
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
}

export interface CapabilityStatus {
  readonly id: CapabilityId;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  readonly state: CapabilityReadiness;
  readonly version?: string;
  readonly steps: readonly CapabilityStep[];
  readonly install: CapabilityInstallProgress;
}

export type CapabilityInstallReporter = (step: string, percent?: number) => void;

/**
 * A built-in capability entry. `install` must be idempotent and re-entrant:
 * every step no-ops when already satisfied, so an interrupted run can be
 * retried by calling `install` again.
 */
export interface CapabilityEntry {
  readonly id: CapabilityId;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  /**
   * The step representing the agent-wiring layer (`plugin` for kimi-cu,
   * `skill` for kimi-webbridge). When that step flips to `ok` through ANY
   * install path (marketplace shelf, TUI, CLI), the capability service
   * auto-completes the missing binary layers — installing the wiring from
   * the shelf is meant to be a complete install, never a half-broken one.
   */
  readonly wiringStepId: string;
  detect(): Promise<CapabilityDetectResult>;
  /**
   * Resolves with an optional machine-key note surfaced through
   * `CapabilityInstallProgress.note` (e.g. 'user-skill-migrated').
   */
  install(report: CapabilityInstallReporter): Promise<string | undefined>;
}
