import type { ParsedSlashInput } from './types';

export function parseSlashInput(input: string): ParsedSlashInput | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  // Reject file paths (e.g. `/usr/local/bin`), but allow namespaced plugin
  // commands whose name itself contains `/` (e.g. `plugin:frontend/component`).
  if (name.includes('/') && !name.includes(':')) return null;
  return { name, args };
}

export interface SlashTokenAtCursor {
  /** The `/partial` token including the leading slash (name portion only). */
  readonly token: string;
  /** Index of `/` in `textBeforeCursor`. */
  readonly startIndex: number;
  /**
   * True when only whitespace precedes the token — i.e. the input is still a
   * leading slash command (with optional indent), not a mid-prompt embed.
   */
  readonly isLeading: boolean;
}

/**
 * If `textBeforeCursor` ends inside a slash-command name token (started at a
 * token boundary), return that token. Does not match once a space has been
 * typed after the command name (argument completion uses a different path).
 */
export function extractSlashTokenAtCursor(textBeforeCursor: string): SlashTokenAtCursor | null {
  let tokenStart = 0;
  for (let i = textBeforeCursor.length - 1; i >= 0; i -= 1) {
    const ch = textBeforeCursor[i];
    if (ch === ' ' || ch === '\t') {
      tokenStart = i + 1;
      break;
    }
  }
  if (textBeforeCursor[tokenStart] !== '/') return null;
  const before = textBeforeCursor.slice(0, tokenStart);
  // Already inside a leading slash command's arguments (e.g. `/add-dir /tmp`).
  // The trailing `/…` is a path, not a new command name token.
  const leading = before.trimStart();
  if (leading.startsWith('/') && /\s/.test(leading)) return null;

  const token = textBeforeCursor.slice(tokenStart);
  if (token.length === 0) return null;
  const name = token.slice(1);
  // Incomplete bare `/` is a valid slash-command prefix.
  if (name.includes('/') && !name.includes(':')) return null;
  const isLeading = before.trim().length === 0;
  return { token, startIndex: tokenStart, isLeading };
}

export interface InlineSlashMatch {
  readonly name: string;
  /** Text before the `/name` token, trimmed on the right. */
  readonly before: string;
  /** Text after the `/name` token, trimmed on the left. */
  readonly after: string;
  /** `before` and `after` joined with a single space (empty parts dropped). */
  readonly surroundingText: string;
}

/**
 * Enumerate mid-prompt `/name` tokens that are not the leading command of the
 * whole input. Callers decide which names are real skill/plugin commands.
 */
export function findInlineSlashTokens(input: string): readonly InlineSlashMatch[] {
  if (parseSlashInput(input.trimStart()) !== null) {
    // Whole input is already a leading slash command (optional indent).
    return [];
  }
  const matches: InlineSlashMatch[] = [];
  const re = /(^|\s)\/(\S+)/g;
  for (const match of input.matchAll(re)) {
    const name = match[2] ?? '';
    if (name.length === 0) continue;
    if (name.includes('/') && !name.includes(':')) continue;
    const fullIndex = (match.index ?? 0) + (match[1]?.length ?? 0);
    const tokenLength = 1 + name.length;
    const before = input.slice(0, fullIndex).trimEnd();
    const after = input.slice(fullIndex + tokenLength).trimStart();
    const surroundingText = [before, after].filter((part) => part.length > 0).join(' ');
    matches.push({ name, before, after, surroundingText });
  }
  return matches;
}
