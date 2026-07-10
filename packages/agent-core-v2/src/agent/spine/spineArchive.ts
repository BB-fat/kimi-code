/**
 * `spine` domain (L4) — persists a closed node's full trajectory as a
 * model-readable markdown archive and renders its content.
 *
 * Folding a node out of the projected view must not mean losing its work: every
 * closed node is serialized to `<workDir>/spine/<agentId>/<node-id>.md` through
 * the `hostFs` bridge, and the absolute path is published back into the tree so
 * the model can `Read` the original trace on demand. A root compaction gets the
 * same treatment at epoch granularity: the history the new epoch boundary folds
 * out of the projection is serialized to `<workDir>/spine/<agentId>/<epoch>.md`
 * with the epoch summary on top, so details the summary dropped stay one `Read`
 * away. Writes go through the host filesystem bridge (no direct `node:fs`);
 * content rendering is a pure function. Consumed by the `spine` service's
 * close / next commit path and its root-compact archive path.
 */

import { dirname, resolve } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ContextMessage } from '#/agent/contextMemory/types';

import type { SpineNode } from './spineOps';

export function spineArchivePath(workDir: string, agentId: string, nodeId: string): string {
  return resolve(workDir, 'spine', agentId, `${nodeId.replaceAll('.', '-')}.md`);
}

export interface SpineArchiveContentInput {
  readonly node: SpineNode;
  readonly messages: readonly ContextMessage[];
}

export interface SpineEpochArchiveInput {
  readonly epoch: number;
  readonly epochStartAt: number;
  readonly epochMemoryAt: number;
  readonly summary: string;
  readonly messages: readonly ContextMessage[];
}

export function buildEpochArchiveContent(input: SpineEpochArchiveInput): string {
  const lines: string[] = [
    `# Spine Root Epoch ${String(input.epoch)}`,
    '',
    `- epoch_start_at: ${String(input.epochStartAt)}`,
    `- epoch_memory_at: ${String(input.epochMemoryAt)}`,
    '',
    '## Epoch Summary',
    '',
    input.summary,
    '',
    '## Trajectory',
    '',
  ];
  for (const message of input.messages) {
    lines.push(...renderMessage(message));
  }
  return lines.join('\n');
}

export function buildArchiveContent(input: SpineArchiveContentInput): string {
  const { node, messages } = input;
  const lines: string[] = [
    `# Spine Node ${node.id}`,
    '',
    `- summary: ${node.summary}`,
    `- opened_at: ${String(node.openedAt)}`,
    `- closed_at: ${String(node.closedAt ?? '')}`,
    '',
    '## Memory',
    '',
    node.memory ?? '',
    '',
    '## Trajectory',
    '',
  ];
  for (const message of messages) {
    lines.push(...renderMessage(message));
  }
  return lines.join('\n');
}

export async function writeNodeArchive(
  hostFs: IHostFileSystem,
  path: string,
  content: string,
): Promise<void> {
  await hostFs.mkdir(dirname(path), { recursive: true });
  await hostFs.writeText(path, content);
}

function renderMessage(message: ContextMessage): readonly string[] {
  const header = `### ${message.role}`;
  const body = message.content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'think') return `<think>${part.think}</think>`;
      return `[${part.type}]`;
    })
    .join('\n');
  const calls = message.toolCalls.map(
    (call) => `tool_call: ${call.name}(${call.arguments ?? ''}) [id=${call.id}]`,
  );
  const result = message.toolCallId === undefined ? undefined : `tool_result_for: ${message.toolCallId}`;
  return [header, result, ...calls, body, '']
    .filter((line): line is string => line !== undefined);
}
