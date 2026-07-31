import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AgentSwarm',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  // Spine task-tree control tools are receipt-only transitions of the model's
  // own task state (the real tree move is committed by the spine service on
  // observed evidence) and fire once per node boundary; spine_trim is likewise
  // receipt-only (the accepted receipt IS the trim, validated by the host
  // against the derived eligibility window). spine_spawn is receipt-only too:
  // the structured receipt IS the join, and the host validates capacity before
  // forking any child agents. They register only when the relevant flags are set
  // (`registerTool(..., { when })`), so these names are inert with the
  // experiment off; asking per call would make the spine workflow unusable.
  'spine_open',
  'spine_close',
  'spine_next',
  'spine_tree',
  'spine_trim',
  'spine_spawn',
  'select_tools',
]);

export class DefaultToolApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return DEFAULT_APPROVE_TOOLS.has(context.toolCall.name)
      ? { kind: 'approve' }
      : undefined;
  }
}
