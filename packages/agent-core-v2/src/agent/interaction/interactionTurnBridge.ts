/**
 * `interaction` domain (L6) — the Agent-scope turn-bridge token.
 *
 * The bridge carries no callable surface; it exists purely so DI can create
 * the per-agent subscription wiring. See `InteractionTurnBridgeService` for
 * the scope-direction rationale.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * Pure subscription wiring between the owning agent's `IEventBus`
 * (`turn.ended`) and the Session interaction kernel. No methods — consumers
 * never call it; `IAgentLifecycleService.create` force-instantiates one per
 * agent so the reaction exists for the agent's lifetime.
 */
export interface IAgentInteractionTurnBridge {
  readonly _serviceBrand: undefined;
}

export const IAgentInteractionTurnBridge: ServiceIdentifier<IAgentInteractionTurnBridge> =
  createDecorator<IAgentInteractionTurnBridge>('agentInteractionTurnBridge');
