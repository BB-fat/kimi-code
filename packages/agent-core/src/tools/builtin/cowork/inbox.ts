/**
 * CoworkInboxTool — read messages addressed to the caller (or broadcast),
 * newest first. The tower sees every message.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { callerName, newStore, runCoworkTool } from './support';

export const CoworkInboxToolInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max messages to return (default 20), newest first'),
  })
  .strict();

export type CoworkInboxToolInput = z.infer<typeof CoworkInboxToolInputSchema>;

const DEFAULT_LIMIT = 20;

export class CoworkInboxTool implements BuiltinTool<CoworkInboxToolInput> {
  readonly name = 'CoworkInbox' as const;
  readonly description: string = `Read your cowork inbox: messages addressed to you plus broadcasts, newest first. The tower sees all messages. Full bodies are included — reply with CoworkSend.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CoworkInboxToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: CoworkInboxToolInput): ToolExecution {
    return {
      description: 'Reading cowork inbox',
      approvalRule: this.name,
      execute: () =>
        runCoworkTool(async () => {
          const store = newStore(this.agent);
          const state = await store.load();
          const caller = callerName(this.agent, state);
          const items = await store.readInbox(caller, args.limit ?? DEFAULT_LIMIT);
          if (items.length === 0) {
            return { output: `inbox empty for ${caller}` };
          }
          const sections = items.map((item) =>
            [
              `file: ${item.file}`,
              `from: ${item.from}`,
              `to: ${item.to}`,
              `subject: ${item.subject}`,
              `sent_at: ${item.sentAt}`,
              ...(item.scope !== undefined ? [`scope: ${item.scope}`] : []),
              ...(item.action !== undefined ? [`action: ${item.action}`] : []),
              '',
              item.body,
            ].join('\n'),
          );
          return {
            output: [
              `${String(items.length)} message(s) for ${caller} (newest first):`,
              '',
              sections.join('\n\n---\n\n'),
            ].join('\n'),
          };
        }),
    };
  }
}
