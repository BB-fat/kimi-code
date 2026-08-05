import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Tower mode never asks: the tower coordinates a fleet of background agents
 * and must keep it moving, so a blocked-on-human question is a mode
 * violation, not a UX choice. This is the code guarantee behind the skill
 * rule — active in every permission mode, for as long as tower mode is on.
 */
export class TowerModeAskUserQuestionDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'tower-mode-ask-user-question-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.towerMode?.isActive) return;
    if (context.toolCall.name !== 'AskUserQuestion') return;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is not available while tower mode is active. Make a reasonable decision yourself and continue — surface the choice in your reply (the human reads it later) and record it via the tower tools.',
    };
  }
}
