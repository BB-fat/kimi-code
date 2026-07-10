/**
 * `replayBuilder` domain — `IAgentReplayService`, the agent-scope owner of
 * the `ReplayTimelineModel` derived-model attachment.
 *
 * A derived model only folds Ops that pass through the wire *after* it is
 * attached (`IWireService.attach` starts from `initial`), so the attach must
 * land before session resume replays the persisted wire log — otherwise a
 * resumed session's timeline stays empty and the TUI cannot rehydrate screen
 * history. This service is force-instantiated from
 * `IAgentLifecycleService.create` (with the other Eager agent services),
 * which runs before `sessionLifecycleService` replays records on
 * resume/fork, and before any live dispatch on fresh sessions.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentWireService } from '#/wire/tokens';
import { type IWireService } from '#/wire/wireService';

import { ReplayTimelineModel, type ReplayTimeline } from './replayTimelineModel';
import { projectReplayTimeline } from './replayProjection';
import type { AgentReplayRecord } from './types';

export interface IAgentReplayService {
  readonly _serviceBrand: undefined;

  /** The op-native folded timeline (raw form). */
  getReplayTimeline(): ReplayTimeline;

  /** v1-shaped replay DTO records for SDK/TUI resume hydration. */
  getReplayRecords(): readonly AgentReplayRecord[];
}

export const IAgentReplayService: ServiceIdentifier<IAgentReplayService> =
  createDecorator<IAgentReplayService>('agentReplayService');

export class AgentReplayService extends Disposable implements IAgentReplayService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentWireService private readonly wire: IWireService) {
    super();
    this._register(this.wire.attach(ReplayTimelineModel));
  }

  getReplayTimeline(): ReplayTimeline {
    return this.wire.getModel(ReplayTimelineModel) as ReplayTimeline;
  }

  getReplayRecords(): readonly AgentReplayRecord[] {
    return projectReplayTimeline(this.getReplayTimeline());
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentReplayService,
  AgentReplayService,
  InstantiationType.Eager,
  'replayBuilder',
);
