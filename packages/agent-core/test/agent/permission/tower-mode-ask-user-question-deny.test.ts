import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { TowerModeAskUserQuestionDenyPermissionPolicy } from '../../../src/agent/permission/policies/tower-mode-ask-user-question-deny';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function fakeAgent(towerActive: boolean) {
  return { towerMode: { isActive: towerActive } } as never;
}

function askContext(toolName: string): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args: {},
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: '{}',
    } satisfies ToolCall,
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('TowerModeAskUserQuestionDenyPermissionPolicy', () => {
  it('ignores AskUserQuestion when tower mode is off', () => {
    const policy = new TowerModeAskUserQuestionDenyPermissionPolicy(fakeAgent(false));
    expect(policy.evaluate(askContext('AskUserQuestion'))).toBeUndefined();
  });

  it('ignores other tools when tower mode is on', () => {
    const policy = new TowerModeAskUserQuestionDenyPermissionPolicy(fakeAgent(true));
    expect(policy.evaluate(askContext('Bash'))).toBeUndefined();
    expect(policy.evaluate(askContext('TowerSpawn'))).toBeUndefined();
  });

  it('denies AskUserQuestion while tower mode is active, with proceed guidance', () => {
    const policy = new TowerModeAskUserQuestionDenyPermissionPolicy(fakeAgent(true));
    const result = policy.evaluate(askContext('AskUserQuestion'));
    expect(result?.kind).toBe('deny');
    if (result?.kind === 'deny') {
      expect(result.message).toContain('tower mode is active');
      expect(result.message).toContain('Make a reasonable decision');
    }
  });
});
