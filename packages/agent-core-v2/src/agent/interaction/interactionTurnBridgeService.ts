/**
 * `interaction` domain (L6) — `IAgentInteractionTurnBridge` implementation.
 *
 * Bridges the owning agent's `turn.ended` to `ISessionInteractionService.
 * cancelPendingForTurn`: a pending interaction whose turn has ended can never
 * be answered, and leaving it parked pins `sessionActivity` at
 * `awaiting_approval` / `awaiting_question` forever (矛盾 c).
 *
 * The reaction has to live on the Agent side: `IEventBus` is bound at Agent
 * scope, and a Session Service cannot inject an Agent Service (the container
 * enforces the scope direction — a parent container never sees a child
 * scope's registrations). An Agent-scope Service sees both the bus (this
 * scope) and the kernel (the parent Session scope). Cancellation matches by
 * `turnId` only — `turn.ended` carries no `agentId`, `question` interactions
 * carry none either, and a parent turn waits for its sub-agents before
 * ending, so a per-agent turn id is unambiguous in practice. No business
 * service injects this; `IAgentLifecycleService.create` force-instantiates it
 * next to the external-hooks adapter so it is alive before the first turn.
 * Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { ISessionInteractionService } from '#/session/interaction/interaction';

import { IAgentInteractionTurnBridge } from './interactionTurnBridge';

export class InteractionTurnBridgeService extends Disposable implements IAgentInteractionTurnBridge {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventBus eventBus: IEventBus,
    @ISessionInteractionService interaction: ISessionInteractionService,
  ) {
    super();
    this._register(
      eventBus.subscribe('turn.ended', (e) => interaction.cancelPendingForTurn(e.turnId)),
    );
  }
}

// `Eager` like the lifecycle's other force-instantiated wirings (external
// hooks, tool registrars): `accessor.get()` must run the constructor now,
// otherwise a `Delayed` proxy would be created — and discarded without ever
// instantiating, since nobody calls a method on a pure subscription wiring.
registerScopedService(
  LifecycleScope.Agent,
  IAgentInteractionTurnBridge,
  InteractionTurnBridgeService,
  InstantiationType.Eager,
  'interaction',
);
