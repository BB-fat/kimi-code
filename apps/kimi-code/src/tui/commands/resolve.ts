import {
  findBuiltInSlashCommand,
  resolveSlashCommandAvailability,
  type BuiltinSlashCommand,
  type BuiltinSlashCommandName,
} from './registry';
import { isExperimentalFlagEnabled } from './experimental-flags';
import { findInlineSlashTokens, parseSlashInput } from './parse';
import type {
  KimiSlashCommand,
  SlashCommandBusyReason,
  SlashCommandInvalidReason,
} from './types';

export type SlashCommandIntent =
  | { readonly kind: 'not-command' }
  | {
      readonly kind: 'builtin';
      readonly command: BuiltinSlashCommand;
      readonly name: BuiltinSlashCommandName;
      readonly args: string;
    }
  | {
      readonly kind: 'skill';
      readonly commandName: string;
      readonly skillName: string;
      readonly args: string;
    }
  | {
      readonly kind: 'plugin-command';
      readonly commandName: string;
      readonly pluginId: string;
      readonly args: string;
    }
  | { readonly kind: 'message'; readonly input: string }
  | {
      readonly kind: 'blocked';
      readonly commandName: string;
      readonly reason: SlashCommandBusyReason;
    }
  | {
      readonly kind: 'invalid';
      readonly commandName: string;
      readonly reason: SlashCommandInvalidReason;
    };

export interface ResolveSlashCommandInput {
  readonly input: string;
  readonly skillCommandMap: ReadonlyMap<string, string>;
  readonly pluginCommandMap: ReadonlyMap<string, string>;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
}

/**
 * Resolve a submitted editor string. Leading slash commands (optional indent)
 * use the existing path; free text may embed a mid-prompt skill/plugin token
 * whose surrounding words become the skill/plugin args.
 */
export function resolveSlashCommandInput(options: ResolveSlashCommandInput): SlashCommandIntent {
  const leadingInput = options.input.trimStart();
  const parsed = parseSlashInput(leadingInput);
  if (parsed !== null) {
    return resolveParsedSlashCommand(parsed, options, leadingInput);
  }

  // Scan every mid-prompt `/token`; skip unknowns so an earlier `/tmp` or
  // `/yolo` does not hide a later skill/plugin activation.
  for (const inline of findInlineSlashTokens(options.input)) {
    // Exact map key only (no bare→`skill:` fallback). Mid-prompt bare names
    // like `/tmp` would otherwise hijack common path segments whenever a
    // skill happens to share that name. Autocomplete inserts the registered
    // name (`skill:foo` or builtin bare name) for external skills.
    const skillName = options.skillCommandMap.get(inline.name);
    if (skillName !== undefined) {
      const busyReason = slashCommandBusyReason(options);
      if (busyReason !== undefined) {
        return {
          kind: 'blocked',
          commandName: inline.name,
          reason: busyReason,
        };
      }
      return {
        kind: 'skill',
        commandName: inline.name,
        skillName,
        args: inline.surroundingText,
      };
    }

    if (options.pluginCommandMap.has(inline.name)) {
      const busyReason = slashCommandBusyReason(options);
      if (busyReason !== undefined) {
        return {
          kind: 'blocked',
          commandName: inline.name,
          reason: busyReason,
        };
      }
      const separator = inline.name.indexOf(':');
      const pluginId = separator === -1 ? inline.name : inline.name.slice(0, separator);
      const commandName = separator === -1 ? '' : inline.name.slice(separator + 1);
      return {
        kind: 'plugin-command',
        commandName,
        pluginId,
        args: inline.surroundingText,
      };
    }
  }

  return { kind: 'not-command' };
}

function resolveParsedSlashCommand(
  parsed: { name: string; args: string },
  options: ResolveSlashCommandInput,
  leadingInput: string,
): SlashCommandIntent {
  const command = findBuiltInSlashCommand(parsed.name);
  // `command` is a literal union where only some members carry `experimentalFlag`; widen to read it.
  if (
    command !== undefined &&
    isExperimentalFlagEnabled((command as KimiSlashCommand).experimentalFlag)
  ) {
    const busyReason = slashCommandBusyReason(options);
    if (
      busyReason !== undefined &&
      resolveSlashCommandAvailability(command, parsed.args) === 'idle-only'
    ) {
      return {
        kind: 'blocked',
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    return {
      kind: 'builtin',
      command,
      name: command.name,
      args: parsed.args,
    };
  }

  const skillName = resolveSkillCommand(options.skillCommandMap, parsed.name);
  if (skillName !== undefined) {
    // Skill activations are never blocked by a busy session: the TUI queues
    // them behind the running turn exactly like normal messages (see
    // sendSkillActivation), so commands like /tower can be issued any time.
    return {
      kind: 'skill',
      commandName: parsed.name,
      skillName,
      args: parsed.args.trim(),
    };
  }

  if (options.pluginCommandMap.has(parsed.name)) {
    const busyReason = slashCommandBusyReason(options);
    if (busyReason !== undefined) {
      return {
        kind: 'blocked',
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    const separator = parsed.name.indexOf(':');
    const pluginId = separator === -1 ? parsed.name : parsed.name.slice(0, separator);
    const commandName = separator === -1 ? '' : parsed.name.slice(separator + 1);
    return {
      kind: 'plugin-command',
      commandName,
      pluginId,
      args: parsed.args.trim(),
    };
  }

  return {
    kind: 'message',
    input: leadingInput,
  };
}

export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

export function slashCommandBusyReason(
  options: Pick<ResolveSlashCommandInput, 'isStreaming' | 'isCompacting'>,
): SlashCommandBusyReason | undefined {
  if (options.isStreaming) return 'streaming';
  if (options.isCompacting) return 'compacting';
  return undefined;
}

export function slashBusyMessage(
  commandName: string,
  reason: SlashCommandBusyReason,
): string {
  if (reason === 'streaming') {
    return `Cannot /${commandName} while streaming — press Esc or Ctrl-C first.`;
  }
  return `Cannot /${commandName} while compacting — wait for compaction to finish first.`;
}
