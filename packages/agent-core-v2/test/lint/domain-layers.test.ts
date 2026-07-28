import { describe, expect, it } from 'vitest';

import { SRC_ROOT, checkSource } from '../../scripts/check-domain-layers.mjs';

const at = (domain: string, file: string): string => `${SRC_ROOT}/${domain}/${file}`;

const V1 = ['@moonshot-ai', 'agent-core'].join('/');

describe('check-domain-layers', () => {
  it('flags a direct import of v1 (@moonshot-ai/agent-core)', () => {
    const violations = checkSource(
      `import { KimiCore } from '${V1}';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('flags a v1 subpath import', () => {
    const violations = checkSource(
      `import { Session } from '${V1}/session';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/v2 must not import v1/);
  });

  it('allows a domain to import a lower layer', () => {
    const violations = checkSource(
      `import { createDecorator } from '#/_base/di/instantiation';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('flags a lower layer importing a higher layer', () => {
    const violations = checkSource(
      `import { IAgentLoopService } from '#/agent/loop/loop';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/layer violation/);
    expect(violations[0]?.message).toMatch(/log.*L1.*loop.*L4/s);
  });

  it('allows same-domain relative imports', () => {
    const violations = checkSource(
      `import { helper } from './helper';`,
      at('loop', 'loop.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows sibling-package imports (out of scope for layering)', () => {
    const violations = checkSource(
      `import { something } from '@moonshot-ai/kaos';`,
      at('log', 'log.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('exempts the top-level package barrel from layering', () => {
    const violations = checkSource(
      `export * from './_base/di/index';`,
      `${SRC_ROOT}/index.ts`,
    );
    expect(violations).toHaveLength(0);
  });

  it('flags sessionHostRuntime importing the Workspace domain', () => {
    const violations = checkSource(
      `import { IWorkspaceService } from '#/app/workspace/workspaceService';`,
      at('sessionHostRuntime', 'sessionService.ts'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/sessionHostRuntime.*must not import domain 'workspace'/);
    expect(violations[0]?.message).toMatch(/pathless and workspace-free/);
  });

  it('flags sessionHostRuntime importing node builtins and backends', () => {
    const fromNode = checkSource(
      `import { readFileSync } from 'node:fs';`,
      at('sessionHostRuntime', 'sessionRuntimeContext.ts'),
    );
    expect(fromNode).toHaveLength(1);
    expect(fromNode[0]?.message).toMatch(/must not import 'node:fs'/);

    const fromBackend = checkSource(
      `import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';`,
      at('sessionHostRuntime', 'sessionRuntimeContext.ts'),
    );
    expect(fromBackend).toHaveLength(1);
    expect(fromBackend[0]?.message).toMatch(/must not import domain 'persistence\/backends'/);

    const fromIndex = checkSource(
      `import { something } from '#/app/sessionIndex/sessionIndex';`,
      at('sessionHostRuntime', 'sessionService.ts'),
    );
    expect(fromIndex).toHaveLength(1);
    expect(fromIndex[0]?.message).toMatch(/must not import domain 'sessionIndex'/);
  });

  it('flags sessionHostRuntime bans through re-exports and dynamic import', () => {
    const reExport = checkSource(
      `export { IWorkspaceService } from '#/app/workspace/workspace';`,
      at('sessionHostRuntime', 'index.ts'),
    );
    expect(reExport).toHaveLength(1);

    const dynamic = checkSource(
      `const m = await import('#/app/workspace/workspaceService');`,
      at('sessionHostRuntime', 'sessionService.ts'),
    );
    expect(dynamic).toHaveLength(1);
  });

  it('allows sessionHostRuntime to import _base and persistence/interface', () => {
    const violations = checkSource(
      [
        `import { createDecorator } from '#/_base/di/instantiation';`,
        `import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';`,
      ].join('\n'),
      at('sessionHostRuntime', 'sessionRuntimeContext.ts'),
    );
    expect(violations).toHaveLength(0);
  });

  it('does not apply the sessionHostRuntime bans to other domains', () => {
    const violations = checkSource(
      `import { IWorkspaceService } from '#/app/workspace/workspaceService';`,
      at('sessionLifecycle', 'sessionLifecycleService.ts'),
    );
    expect(violations).toHaveLength(0);
  });
});
