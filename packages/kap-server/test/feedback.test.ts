import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
}

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${r.authTokenService.getToken()}`,
        },
      });
    },
  };
}

function envelopeOf<T>(body: unknown): Envelope<T> {
  return body as Envelope<T>;
}

function submit(api: AppLike, payload: unknown) {
  return api.inject({ method: 'POST', url: '/api/v1/feedback', payload });
}

interface StoredRecord {
  id: string;
  time: number;
  message: string;
  rating?: string;
  session_id?: string;
  agent_id?: string;
}

async function readRecords(home: string): Promise<StoredRecord[]> {
  const text = await readFile(join(home, 'feedback', 'feedback.jsonl'), 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StoredRecord);
}

describe('server-v2 feedback routes', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-feedback-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('accepts feedback and appends a stamped JSON line to feedback.jsonl', async () => {
    const res = await submit(appOf(server as RunningServer), { message: 'great session' });
    expect(res.statusCode).toBe(200);
    expect(envelopeOf<null>(res.json()).code).toBe(0);

    const records = await readRecords(home as string);
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe('great session');
    expect(typeof records[0]?.id).toBe('string');
    expect(typeof records[0]?.time).toBe('number');
  });

  it('persists the optional rating / session_id / agent_id fields', async () => {
    await submit(appOf(server as RunningServer), {
      message: 'wrong result',
      rating: 'down',
      session_id: 's-1',
      agent_id: 'a-1',
    });

    const records = await readRecords(home as string);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      message: 'wrong result',
      rating: 'down',
      session_id: 's-1',
      agent_id: 'a-1',
    });
  });

  it('appends multiple submissions as separate lines in submission order', async () => {
    const api = appOf(server as RunningServer);
    await Promise.all([submit(api, { message: 'first' }), submit(api, { message: 'second' })]);

    const records = await readRecords(home as string);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.message).toSorted()).toEqual(['first', 'second']);
  });

  it('rejects an empty message', async () => {
    const res = await submit(appOf(server as RunningServer), { message: '' });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });

  it('rejects a missing message', async () => {
    const res = await submit(appOf(server as RunningServer), { rating: 'up' });
    expect(envelopeOf(res.json()).code).toBe(40001);
  });

  it.skipIf(process.platform === 'win32')('writes feedback.jsonl with 0600 permissions', async () => {
    await submit(appOf(server as RunningServer), { message: 'perm check' });
    const mode = (await stat(join(home as string, 'feedback', 'feedback.jsonl'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
