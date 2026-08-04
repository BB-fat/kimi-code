import type { Agent } from '..';

/**
 * CoworkMode — tracks whether this agent (always the main one) is acting as
 * an active cowork tower. The heavy protocol state lives on disk in
 * `.cowork/comms/state.json` via `CoworkStore`; this mode object is only the
 * session-scoped on/off flag, persisted through `cowork_mode.*` records so a
 * resumed session restores it (the cowork tool set is restored by the
 * `tools.set_active_tools` record the same way plan/swarm state is).
 */
export class CoworkMode {
  private active = false;

  constructor(protected readonly agent: Agent) {}

  enter(): void {
    if (this.active) return;
    this.agent.records.logRecord({ type: 'cowork_mode.enter' });
    this.active = true;
    this.agent.emitStatusUpdated();
  }

  restoreEnter(): void {
    this.active = true;
  }

  exit(): void {
    if (!this.active) return;
    this.agent.records.logRecord({ type: 'cowork_mode.exit' });
    this.active = false;
    this.agent.emitStatusUpdated();
  }

  get isActive(): boolean {
    return this.active;
  }
}
