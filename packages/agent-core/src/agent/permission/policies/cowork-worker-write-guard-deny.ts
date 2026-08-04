import type { Agent } from '../..';
import { isWithinDirectory } from '../../../tools/policies/path-access';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';
import { writeFileAccesses } from './file-access-ask';

/**
 * cowork-worker agents are confined to their own worktree: CoworkSpawn sets
 * the agent's cwd to the worktree, and this guard denies any Write/Edit whose
 * target escapes it — including absolute paths, which the workspace guard
 * otherwise lets through to the ask fallback. The main checkout and sibling
 * agents' slots are therefore unreachable for edits; out-of-scope changes go
 * through CoworkFinding / the tower instead.
 *
 * Bash commands with absolute escape paths remain a briefing-level rule (the
 * Bash tool reports no file accesses to match against).
 */
export class CoworkWorkerWriteGuardPermissionPolicy implements PermissionPolicy {
  readonly name = 'cowork-worker-write-guard-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (this.agent.config.profileName !== 'cowork-worker') return;
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;

    const cwd = this.agent.config.cwd;
    const escapes = writeFileAccesses(context).filter(
      (access) => !isWithinDirectory(access.path, cwd),
    );
    if (escapes.length === 0) return;
    return {
      kind: 'deny',
      message:
        `cowork workers may only write inside their own worktree (${cwd}) — denied: ` +
        `${escapes.map((access) => access.path).join(', ')}. ` +
        'Out-of-scope changes are not yours to make: file them with CoworkFinding or ask the tower via CoworkSend.',
    };
  }
}
