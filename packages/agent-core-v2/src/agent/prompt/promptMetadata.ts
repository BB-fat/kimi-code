/**
 * `prompt` domain (L4) — v1-compatible prompt metadata helpers.
 *
 * Derives title and last-prompt text from prompt content, persists metadata
 * through `sessionMetadata`, and publishes live updates through `event`.
 * Applied by the `IAgentPromptService.enqueue` sink for every user-origin
 * prompt, and directly by the rpc skill / plugin-command paths, so every
 * entry surface keeps the same easy-title behavior.
 */

import type { ContentPart } from '#/kosong/contract/message';
import type { IEventService } from '#/app/event/event';
import type { ISessionMetadata, SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import { extractImageCompressionCaptions } from '#/agent/media/image-compress';

const MAX_TITLE_LENGTH = 200;
const MAX_LAST_PROMPT_LENGTH = 4000;

export function titleFromPromptMetadataText(text: string): string {
  return text.slice(0, MAX_TITLE_LENGTH);
}

export function promptMetadataTextFromPayload(payload: {
  readonly input: readonly ContentPart[];
}): string | undefined {
  return promptMetadataTextFromContentParts(payload.input);
}

export function promptMetadataTextFromContentParts(
  parts: readonly ContentPart[],
): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    const text = promptPartText(part);
    if (text !== undefined) texts.push(text);
  }
  return sanitizeAndTruncatePromptText(texts.join('\n'), MAX_LAST_PROMPT_LENGTH);
}

export function promptMetadataTextFromSkill(payload: {
  readonly name: string;
  readonly args?: string | undefined;
}): string | undefined {
  const args = payload.args?.trim();
  return sanitizeAndTruncatePromptText(
    args === undefined || args.length === 0 ? `/${payload.name}` : `/${payload.name} ${args}`,
    MAX_LAST_PROMPT_LENGTH,
  );
}

export function promptMetadataTextFromPluginCommand(payload: {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}): string | undefined {
  const args = payload.args?.trim();
  const command = `/${payload.pluginId}:${payload.commandName}`;
  return sanitizeAndTruncatePromptText(
    args === undefined || args.length === 0 ? command : `${command} ${args}`,
    MAX_LAST_PROMPT_LENGTH,
  );
}

export function isUntitled(title: string | undefined): boolean {
  return title === undefined || title.trim().length === 0 || title === 'New Session';
}

export interface PromptMetadataUpdateTarget {
  readonly metadata: ISessionMetadata;
  readonly eventService: IEventService;
  readonly sessionId: string;
}

export interface PromptMetadataPatch {
  readonly lastPrompt: string;
  readonly title?: string;
  readonly isCustomTitle?: boolean;
}

/**
 * Computes the metadata patch for a prompt text, or `undefined` when nothing
 * would change — so sinks and rpc callers racing the same prompt never
 * double-write or bump `updatedAt`.
 */
export function promptMetadataPatchFromText(
  current: Pick<SessionMeta, 'title' | 'isCustomTitle' | 'lastPrompt'>,
  text: string | undefined,
): PromptMetadataPatch | undefined {
  if (text === undefined) return undefined;
  const patch: { lastPrompt: string; title?: string; isCustomTitle?: boolean } = {
    lastPrompt: text,
  };
  if (!current.isCustomTitle && isUntitled(current.title)) {
    patch.title = titleFromPromptMetadataText(text);
    patch.isCustomTitle = false;
  }
  if (patch.title === undefined && patch.lastPrompt === current.lastPrompt) return undefined;
  return patch;
}

export async function applyPromptMetadataUpdate(
  target: PromptMetadataUpdateTarget,
  text: string | undefined,
): Promise<void> {
  const patch = promptMetadataPatchFromText(await target.metadata.read(), text);
  if (patch === undefined) return;
  await target.metadata.update(patch);
  target.eventService.publish({
    type: 'session.meta.updated',
    payload: {
      agentId: 'main',
      sessionId: target.sessionId,
      title: patch.title,
      patch: {
        title: patch.title,
        isCustomTitle: patch.isCustomTitle,
        lastPrompt: patch.lastPrompt,
      },
    },
  });
}

function promptPartText(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'text': {
      const { text } = extractImageCompressionCaptions(part.text);
      return text.trim().length === 0 ? undefined : text;
    }
    case 'image_url':
      return '[image]';
    case 'audio_url':
      return '[audio]';
    case 'video_url':
      return '[video]';
    case 'think':
      return undefined;
  }
}

function sanitizeAndTruncatePromptText(text: string, maxLength: number): string | undefined {
  const sanitized = text
    .replaceAll(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[redacted]',
    )
    .replaceAll(/\b(authorization)\s*:\s*bearer\s+\S+/gi, '$1: Bearer [redacted]')
    .replaceAll(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=[redacted]',
    )
    .replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replaceAll(/\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g, '[redacted]')
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, maxLength);
}
