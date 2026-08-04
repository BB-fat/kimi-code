import { describe, expect, it } from 'vitest';

import { resolveCoworkRepoRoot } from '../../src/tools/builtin/cowork/support';

describe('resolveCoworkRepoRoot', () => {
  it('returns the cwd unchanged when it is the main checkout', () => {
    expect(resolveCoworkRepoRoot('/repo')).toBe('/repo');
    expect(resolveCoworkRepoRoot('/repo/src/layer')).toBe('/repo/src/layer');
  });

  it('maps a cowork worktree cwd back to the main checkout', () => {
    expect(resolveCoworkRepoRoot('/repo/.cowork/worktrees/wt-1')).toBe('/repo');
    expect(resolveCoworkRepoRoot('/repo/.cowork/worktrees/wt-12/src')).toBe('/repo');
  });

  it('does not mangle lookalike paths', () => {
    // No trailing slash after the slot marker → not a cowork worktree anchor.
    expect(resolveCoworkRepoRoot('/repo/.cowork/worktrees')).toBe('/repo/.cowork/worktrees');
    // A project that happens to be named worktrees is left alone.
    expect(resolveCoworkRepoRoot('/repo/.cowork/worktreesmith/x')).toBe(
      '/repo/.cowork/worktreesmith/x',
    );
  });

  it('handles windows separators', () => {
    expect(resolveCoworkRepoRoot('C:\\repo\\.cowork\\worktrees\\wt-1')).toBe('C:\\repo');
  });
});
