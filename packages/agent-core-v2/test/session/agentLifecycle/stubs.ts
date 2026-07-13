import { Emitter } from '#/_base/event';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { createHooks } from '#/hooks';
import {
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';

export interface LifecycleStub {
  readonly service: IAgentLifecycleService;
  readonly fireCreate: (handle: IAgentScopeHandle) => void;
  readonly fireCreateMain: (handle: IAgentScopeHandle) => void;
  readonly fireDispose: (agentId: string) => void;
}

export function makeLifecycleStub(handles: readonly IAgentScopeHandle[] = []): LifecycleStub {
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const onDidCreateMain = new Emitter<IAgentScopeHandle>();
  const onDidDispose = new Emitter<string>();
  const onDidStopAgentTask = new Emitter<AgentTaskStopHookContext>();
  const byId = new Map(handles.map((h) => [h.id, h]));

  const service: IAgentLifecycleService = {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
    onDidStopAgentTask: onDidStopAgentTask.event,
    onDidCreate: onDidCreate.event,
    onDidCreateMain: onDidCreateMain.event,
    onDidDispose: onDidDispose.event,
    getHandle: (id: string) => byId.get(id),
    list: () => [...byId.values()],
    create: async () => {
      throw new Error('not implemented');
    },
    ensureMcpReady: () => Promise.resolve(),
    notifyMainCreated: () => {},
    notifyAgentTaskStopped: () => {},
    fork: async () => {
      throw new Error('not implemented');
    },
    run: () => {
      throw new Error('not implemented');
    },
    remove: async () => {},
  };

  return {
    service,
    fireCreate: (h) => {
      byId.set(h.id, h);
      onDidCreate.fire(h);
    },
    fireCreateMain: (h) => {
      byId.set(h.id, h);
      onDidCreateMain.fire(h);
    },
    fireDispose: (id) => {
      byId.delete(id);
      onDidDispose.fire(id);
    },
  };
}
