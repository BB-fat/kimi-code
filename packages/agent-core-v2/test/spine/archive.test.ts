import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASTER_ENV } from '#/app/flag/flagService';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentSpineService,
  IAgentWireService,
  SpineModel,
  spineClose,
  spineOpen,
  type PersistedWireRecord,
} from '#/index';

import {
  execEnvServices,
  InMemoryWireRecordPersistence,
  testAgent,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../harness';

const SPINE_ENV = 'KIMI_CODE_SPINE';

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'kimi-code',
  baseUrl: 'http://127.0.0.1',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

describe('Spine archive + resume', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes a trajectory archive on close and publishes its path', async () => {
    const writes = new Map<string, string>();
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs(writes) }));
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('c_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const node = readSpine(ctx).nodes['1.1.1'];
    expect(node?.archivePath).toBeDefined();
    const archivePath = node?.archivePath as string;
    expect(writes.has(archivePath)).toBe(true);
    const content = writes.get(archivePath) ?? '';
    expect(content).toContain('did A');
    expect(content).toContain('task A');
    expect(content).toContain('## Trajectory');

    expect(ctx.get(IAgentSpineService).renderTree()).toContain(archivePath);
  });

  it('replays the tree (with memory and archive path) from persisted wire records', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = testAgent(
      execEnvServices({ hostFs: recordingHostFs(new Map()) }),
      wireRecordPersistenceServices(persistence),
    );

    const wire = ctx.get(IAgentWireService);
    wire.dispatch(spineOpen({ id: '1.1.1', summary: 'task A', parentId: '1.1', openedAt: 0 }));
    wire.dispatch(
      spineClose({
        id: '1.1.1',
        closedAt: 5,
        memory: 'did A',
        archivePath: '/ws/spine/main/1-1-1.md',
      }),
    );
    await ctx.wireRecord.flush();

    const before = readSpine(ctx);
    const resumed = testAgent(
      execEnvServices({ hostFs: recordingHostFs(new Map()) }),
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence(withMetadata(cloneRecords(persistence.records))),
      ),
    );
    await resumed.restorePersisted();

    const after = readSpine(resumed);
    expect(after.openStack).toEqual(before.openStack);
    expect(after.rootEpoch).toBe(before.rootEpoch);
    expect(after.nodes['1.1.1']).toMatchObject({
      summary: 'task A',
      memory: 'did A',
      closedAt: 5,
      archivePath: '/ws/spine/main/1-1-1.md',
    });
  });
});

async function configureLoop(ctx: TestAgentContext): Promise<void> {
  ctx.configure({ provider: CATALOGUED_PROVIDER, modelCapabilities: CATALOGUED_MODEL_CAPABILITIES });
  await ctx.rpc.setPermission({ mode: 'yolo' });
}

function readSpine(ctx: TestAgentContext) {
  return ctx.get(IAgentWireService).getModel(SpineModel);
}

function recordingHostFs(writes: Map<string, string>) {
  return {
    writeText: async (path: string, data: string) => {
      writes.set(path, data);
    },
    mkdir: async () => {},
  };
}

function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): { readonly type: 'function'; readonly id: string; readonly name: string; readonly arguments: string } {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

function cloneRecords<T>(records: readonly T[]): T[] {
  return records.map((record) => structuredClone(record));
}

function withMetadata(records: readonly PersistedWireRecord[]): PersistedWireRecord[] {
  if (records[0]?.type === 'metadata') return [...records];
  return [
    { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
    ...records,
  ];
}
