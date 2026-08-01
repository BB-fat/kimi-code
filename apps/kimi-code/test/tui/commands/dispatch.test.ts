import { describe, expect, it, vi } from 'vitest';

import { triggerImmediateSlashCommand } from '#/tui/commands/dispatch';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost(overrides: { streaming?: boolean } = {}) {
  const host = {
    state: {
      appState: {
        streamingPhase: overrides.streaming === true ? 'thinking' : 'idle',
        isCompacting: false,
      },
    },
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    track: vi.fn(),
    showError: vi.fn(),
    showHelpPanel: vi.fn(),
  } as unknown as SlashCommandHost & {
    track: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showHelpPanel: ReturnType<typeof vi.fn>;
  };
  return host;
}

describe('triggerImmediateSlashCommand', () => {
  it('executes a builtin command in place', () => {
    const host = makeHost();
    triggerImmediateSlashCommand(host, 'help');

    expect(host.track).toHaveBeenCalledWith('input_command', { command: 'help' });
    expect(host.showHelpPanel).toHaveBeenCalledOnce();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('reports a busy error without executing when the command is blocked', () => {
    // `/undo` is idle-only, so streaming blocks it. The draft is owned by the
    // editor here, so nothing is restored or cleared — only the error shows.
    const host = makeHost({ streaming: true });
    triggerImmediateSlashCommand(host, 'undo');

    expect(host.track).toHaveBeenCalledWith('input_command_invalid', {
      reason: 'blocked',
      command: 'undo',
    });
    expect(host.showError).toHaveBeenCalledOnce();
  });

  it('ignores names that do not resolve to a builtin', () => {
    const host = makeHost();
    triggerImmediateSlashCommand(host, 'not-a-command');

    expect(host.track).not.toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showHelpPanel).not.toHaveBeenCalled();
  });
});
