/**
 * CoworkReviewTool — a reviewer's verdict on a branch. The store assigns the
 * round number, stamps the reviewed branch tip, and enforces that the caller
 * is an assigned reviewer for the target. Only a "clean" review of the exact
 * current tip passes the merge gate.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { callerName, newStore, runCoworkTool } from './support';

export const CoworkReviewToolInputSchema = z
  .object({
    target: z.string().describe('The branch you were assigned to review'),
    status: z
      .string()
      .regex(/^(clean|p[12]-\d+items)$/)
      .describe(
        'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority',
      ),
    merge: z
      .enum(['merge', 'fix-then-merge', 'hold'])
      .describe('Merge recommendation for the tower'),
    findings: z.string().describe('Full findings text (markdown); write "none" when clean'),
    checks: z
      .array(z.string())
      .optional()
      .describe('Checklist items you verified (e.g. "tests pass", "no secrets")'),
    decision: z.string().describe('The reasoning behind your verdict'),
  })
  .strict();

export type CoworkReviewToolInput = z.infer<typeof CoworkReviewToolInputSchema>;

export class CoworkReviewTool implements BuiltinTool<CoworkReviewToolInput> {
  readonly name = 'CoworkReview' as const;
  readonly description: string = `Submit a review verdict for a branch you were assigned to review (via CoworkSpawn review_target).

The review is stamped with the current branch tip — if the branch moves afterwards, the tower must ask for a re-review before merging. Only reviewers assigned to the target (or the tower) may submit; the round number is assigned automatically.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CoworkReviewToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: CoworkReviewToolInput): ToolExecution {
    return {
      description: `Submitting cowork review for ${args.target}: ${args.status}`,
      approvalRule: this.name,
      execute: () =>
        runCoworkTool(async () => {
          const store = newStore(this.agent);
          const state = await store.load();
          const caller = callerName(this.agent, state);
          const rel = await store.submitReview(caller, {
            target: args.target,
            status: args.status,
            merge: args.merge,
            findings: args.findings,
            checks: args.checks,
            decision: args.decision,
          });
          return {
            output: `review submitted: ${rel}\nAlso notify the branch author (or the tower) with CoworkSend so the verdict is seen.`,
          };
        }),
    };
  }
}
