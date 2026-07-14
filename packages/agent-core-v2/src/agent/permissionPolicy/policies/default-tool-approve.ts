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
  'AskUserQuestion',
  'Skill',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  // Spine task-tree control tools are receipt-only transitions of the model's
  // own task state (the real tree move is committed by the spine service on
  // observed evidence) and fire once per node boundary. They register only
  // when `KIMI_CODE_SPINE` is set (`registerTool(..., { when })`), so these
  // names are inert with the experiment off; asking per call would make the
  // spine workflow unusable.
  'spine_open',
  'spine_close',
  'spine_next',
  'spine_tree',
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
