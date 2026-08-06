/**
 * `tower` domain — `IAgentTowerService` implementation.
 *
 * Tracks tower-mode enter/exit in the `wire` `TowerModel` (mutated only
 * through the `tower_mode.enter` / `tower_mode.exit` Ops, read through
 * `wire.getModel`), and derives the `towerMode` slice of
 * `agent.status.updated` from the Ops' `toEvent`. Also carries the
 * tower-mode harness constraints as `onBeforeExecuteTool` veto listeners:
 * while tower mode is active, an `AskUserQuestion` call is vetoed with a
 * `toolApproval.formatDenyMessage`-formatted reason — the tower coordinates
 * a fleet of background agents and must keep it moving, so a
 * blocked-on-human question is a mode violation, not a UX choice. A second
 * listener is the tower-worker write guard (port of v1's
 * `tower-worker-write-guard-deny` policy): a `tower-worker`-profile agent's
 * Write/Edit is confined to the worktree its roster entry records
 * (`.tower/worktrees/<slot>` under the repo root, resolved through the
 * `tower` protocol store from `sessionContext.cwd`); any declared write
 * access outside it is vetoed with the v1 message verbatim. v1 keyed the
 * confinement on the worker's cwd override, which was always set; v2 has no
 * per-agent cwd, so a worker without a roster entry (or with no readable
 * `.tower` state) is simply outside the protocol and the guard abstains.
 * Bound at Agent scope.
 */

import { join } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWireService } from '#/wire/wire';
import {
  TowerStore,
  WORKTREES_DIR,
  resolveTowerRepoRoot,
} from './protocol/index';
import { IAgentTowerService } from './tower';
import { towerEnter, towerExit, TowerModel } from './towerOps';

export class AgentTowerService extends Disposable implements IAgentTowerService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionContext private readonly sessionCtx: ISessionContext,
  ) {
    super();
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.isActive) return;
        if (event.toolCall.name !== 'AskUserQuestion') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'AskUserQuestion is not available while tower mode is active. Make a reasonable decision yourself and continue — surface the choice in your reply (the human reads it later) and record it via the tower tools.',
            ),
          ),
        );
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool(async (event) => {
        if (this.profile.data().profileName !== 'tower-worker') return;
        const toolName = event.toolCall.name;
        if (toolName !== 'Write' && toolName !== 'Edit') return;

        const store = new TowerStore(resolveTowerRepoRoot(this.sessionCtx.cwd));
        const entry = await store
          .load()
          .then(
            (state) =>
              state.roster.agents.find((agent) => agent.agentId === this.agentCtx.agentId),
            () => undefined,
          );
        const slot = entry?.worktree;
        if (slot === undefined) return;
        const worktree = store.abs(join(WORKTREES_DIR, slot));

        const escapes = (event.execution.accesses ?? [])
          .filter(
            (access): access is ToolFileAccess =>
              access.kind === 'file' &&
              (access.operation === 'write' || access.operation === 'readwrite'),
          )
          .filter((access) => !isWithinDirectory(access.path, worktree));
        if (escapes.length === 0) return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
                `${escapes.map((access) => access.path).join(', ')}. ` +
                'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.',
            ),
          ),
        );
      }),
    );
  }

  enter(): void {
    if (this.isActive) return;
    this.wire.dispatch(towerEnter({}));
  }

  exit(): void {
    if (!this.isActive) return;
    this.wire.dispatch(towerExit({}));
  }

  get isActive(): boolean {
    return this.wire.getModel(TowerModel);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTowerService,
  AgentTowerService,
  ScopeActivation.OnScopeCreated,
  'tower',
);
