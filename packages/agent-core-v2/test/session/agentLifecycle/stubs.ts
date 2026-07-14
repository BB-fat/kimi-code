import { Emitter } from '#/_base/event';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

export interface LifecycleStub {
  readonly service: IAgentLifecycleService;
  readonly fireCreate: (handle: IAgentScopeHandle) => void;
  readonly fireDispose: (agentId: string) => void;
}

export function makeLifecycleStub(handles: readonly IAgentScopeHandle[] = []): LifecycleStub {
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const onDidDispose = new Emitter<string>();
  const byId = new Map(handles.map((h) => [h.id, h]));

  const service: IAgentLifecycleService = {
    _serviceBrand: undefined,
    onDidCreate: onDidCreate.event,
    onDidDispose: onDidDispose.event,
    create: async () => {
      throw new Error('not implemented');
    },
    fork: async () => {
      throw new Error('not implemented');
    },
    get: (id: string) => byId.get(id),
    list: () => [...byId.values()],
    remove: async () => {},
  };

  return {
    service,
    fireCreate: (h) => {
      byId.set(h.id, h);
      onDidCreate.fire(h);
    },
    fireDispose: (id) => {
      byId.delete(id);
      onDidDispose.fire(id);
    },
  };
}
