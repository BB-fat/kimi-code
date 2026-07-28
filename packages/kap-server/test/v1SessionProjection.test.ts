/**
 * `v1SessionProjection` — internal `SessionDescriptor` → the index-shaped
 * summary the v1 wire builders consume (plan §6.2). Field-by-field parity
 * with the legacy `ISessionIndex` reads: `cwd` prefers the session's own
 * persisted metadata over the catalog root; a runtime without a workspace
 * registration — or a session with no recoverable cwd — is not projectable.
 * Run with
 * `pnpm --filter @moonshot-ai/kap-server exec vitest run test/v1SessionProjection.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { SessionDescriptor } from '@moonshot-ai/agent-core-v2';

import {
  projectV1Session,
  type V1ProjectionLookups,
} from '../src/app/v1Compatibility/v1SessionProjection';
import type { V1SessionRefResolution } from '../src/app/v1Compatibility/v1SessionRefResolver';

function resolution(metadata: Record<string, unknown>, runtimeId = 'rt-a'): V1SessionRefResolution {
  const descriptor: SessionDescriptor = {
    ref: { runtimeId, sessionId: 's1' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    status: 'active',
    metadata,
  };
  return {
    ref: descriptor.ref,
    runtime: { id: runtimeId } as V1SessionRefResolution['runtime'],
    descriptor,
  };
}

const LOOKUPS: V1ProjectionLookups = {
  workspaceIdByRuntimeId: new Map([['rt-a', 'wd_a']]),
  rootByWorkspaceId: new Map([['wd_a', '/catalog/root']]),
};

describe('projectV1Session (plan §6.2)', () => {
  it('projects every wire field from the descriptor, cwd from session metadata', () => {
    const view = projectV1Session(
      resolution({
        title: 'hello',
        lastPrompt: 'do a thing',
        cwd: '/session/cwd',
        custom: { goal: 'x', other: 1 },
      }),
      LOOKUPS,
    );
    expect(view).toBeDefined();
    expect(view?.workspaceId).toBe('wd_a');
    expect(view?.cwd).toBe('/session/cwd');
    expect(view?.summary).toEqual({
      id: 's1',
      workspaceId: 'wd_a',
      cwd: '/session/cwd',
      title: 'hello',
      lastPrompt: 'do a thing',
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
      updatedAt: Date.parse('2026-01-02T03:04:05.000Z'),
      archived: false,
      custom: { goal: 'x', other: 1 },
    });
    // The wire summary carries no runtime identity.
    expect(JSON.stringify(view?.summary)).not.toContain('rt-a');
  });

  it('falls back to the catalog root when the session never persisted cwd', () => {
    const view = projectV1Session(resolution({ title: 'old' }), LOOKUPS);
    expect(view?.cwd).toBe('/catalog/root');
    // `summary.cwd` stays undefined (only the session's own fact), matching
    // the legacy `summary.cwd ?? roots.get(...)` resolution order.
    expect(view?.summary.cwd).toBeUndefined();
  });

  it('maps archived status and keeps optional fields absent when unset', () => {
    const archived = resolution({ cwd: '/x' });
    const view = projectV1Session(
      { ...archived, descriptor: { ...archived.descriptor, status: 'archived' as const } },
      LOOKUPS,
    );
    expect(view?.summary.archived).toBe(true);
    expect(view?.summary.title).toBeUndefined();
    expect(view?.summary.lastPrompt).toBeUndefined();
    expect(view?.summary.custom).toBeUndefined();
  });

  it('is not projectable without a workspace registration for the runtime', () => {
    expect(projectV1Session(resolution({ cwd: '/x' }, 'rt-unknown'), LOOKUPS)).toBeUndefined();
  });

  it('is not projectable when neither the session nor the catalog has a cwd', () => {
    const lookups: V1ProjectionLookups = {
      workspaceIdByRuntimeId: new Map([['rt-a', 'wd_a']]),
      rootByWorkspaceId: new Map(),
    };
    expect(projectV1Session(resolution({}), lookups)).toBeUndefined();
  });
});
