/**
 * API surface snapshot guardrail (ported from v1 ROADMAP M0.1).
 *
 * Boots `startServer` on port 0 with an isolated home dir, then records a
 * stable, sorted snapshot of the documented API surface:
 *
 *   - `routes`: every `[METHOD, path]` pair derived from `/openapi.json`
 *     `paths` (the documented REST surface). This is the guardrail's target:
 *     route additions / removals / renames show an intentional diff.
 *   - `meta`: the `(method, url, status)` of doc/meta endpoints that sit
 *     outside `paths` (`/openapi.json`, `/asyncapi.json`, `/`). Status codes
 *     prove reachability (or, for `/`, the deliberate absence of a root
 *     handler).
 *
 * The surface is read through the public `/openapi.json` endpoint rather than
 * by inspecting Fastify's route table directly — keeping this a behavior-only
 * guardrail over the wire contract.
 *
 * The second test is the multi-runtime refactor's frozen v1 wire baseline
 * (plan §9.8/§10.2): the FULL normalized OpenAPI `paths` + `components` (so
 * any request/response schema, error-envelope or pagination change diffs),
 * the full AsyncAPI `channels` + `operations` + `components` (every WS
 * control/system/event frame with its payload schema), and the WS
 * `protocol_version`. Any v1 surface addition/removal or wire change fails
 * this snapshot. Regenerate intentionally with `pnpm vitest run -u`.
 *
 * The baseline snapshots one JSON STRING per shard (per route, per schema,
 * per WS frame) rather than one large object: @vitest/pretty-format's
 * per-depth output budget silently prints composites past the budget as
 * `[Object]`/`[Array]`, which once truncated the whole WS section and the
 * tail routes out of the snapshot. Do not collapse the shards back into a
 * single object snapshot.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src';
import { WS_PROTOCOL_VERSION } from '../src/protocol/ws-control';
import { authHeaders } from './helpers/auth';

/** OpenAPI path-item keys that are HTTP methods (skip `parameters`, etc.). */
const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

/** Doc/meta endpoints outside the OpenAPI `paths` map to probe for reachability. */
const META_ENDPOINTS = ['/openapi.json', '/asyncapi.json', '/'];

describe('API surface snapshot', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      try {
        await server.close();
      } catch {
        // ignore — best-effort teardown
      }
      server = undefined;
    }
    if (home !== undefined) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('matches the documented v2 route table and meta endpoints', async () => {
    home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-api-surface-'));

    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });

    const base = `http://${server.host}:${server.port}`;

    // 1) Documented REST surface, derived from /openapi.json `paths`.
    const openApiRes = await fetch(`${base}/openapi.json`, { headers: authHeaders(server) } as never);
    expect(openApiRes.status).toBe(200);
    const openApi = (await openApiRes.json()) as {
      paths?: Record<string, Record<string, unknown>>;
    };
    const paths = openApi.paths ?? {};
    expect(Object.keys(paths).length).toBeGreaterThan(0);

    const routes: Array<[string, string]> = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const key of Object.keys(item)) {
        if (HTTP_METHODS.has(key.toLowerCase())) {
          routes.push([key.toUpperCase(), path]);
        }
      }
    }
    routes.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

    // 2) Doc/meta endpoints that are not part of the OpenAPI `paths` map.
    const meta: Array<[string, string, number]> = [];
    for (const endpoint of META_ENDPOINTS) {
      const res = await fetch(`${base}${endpoint}`, { headers: authHeaders(server) } as never);
      meta.push(['GET', endpoint, res.status]);
    }
    meta.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);

    expect({ routes, meta }).toMatchSnapshot();
  });

  it('matches the frozen v1 wire baseline (OpenAPI + AsyncAPI + protocol version)', async () => {
    home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-wire-baseline-'));

    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });

    const base = `http://${server.host}:${server.port}`;

    // Full documented REST wire: every operation's parameters, request body,
    // responses and shared schemas. `info`/doc-level metadata is excluded
    // (version churn is not a wire change).
    const openApiRes = await fetch(`${base}/openapi.json`, { headers: authHeaders(server) } as never);
    expect(openApiRes.status).toBe(200);
    const openApi = (await openApiRes.json()) as Record<string, unknown>;

    // Full documented WebSocket wire: every control/system/event frame with
    // its payload schema, derived from the same `wsOperations` manifest the
    // connection handler enforces.
    const asyncApiRes = await fetch(`${base}/asyncapi.json`, { headers: authHeaders(server) } as never);
    expect(asyncApiRes.status).toBe(200);
    const asyncApi = (await asyncApiRes.json()) as Record<string, unknown>;

    // Sharding & stringification are load-bearing, do NOT "simplify" this
    // into one big object snapshot: @vitest/pretty-format enforces a per-
    // depth output budget (maxOutputLength) and silently prints every
    // composite value past the budget as `[Object]`/`[Array]`. A whole-
    // document object snapshot truncated the entire WS section and the tail
    // routes that way (review finding B1). Snapshotting one JSON STRING per
    // shard keeps every byte in the snapshot (strings are primitives and
    // bypass the budget), and one named snapshot per shard keeps keys stable
    // when unrelated shards change.
    const snap = (name: string, value: unknown): void => {
      expect(`${name}\n${JSON.stringify(value, null, 2)}`).toMatchSnapshot(name);
    };
    const sortedEntries = (obj: unknown): Array<[string, unknown]> =>
      Object.entries((obj ?? {}) as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      );

    snap('WS protocol_version', WS_PROTOCOL_VERSION);

    // REST: one snapshot per route path-item, then one per OpenAPI component.
    for (const [path, pathItem] of sortedEntries(openApi['paths'])) {
      snap(`REST ${path}`, pathItem);
    }
    for (const [section, sectionValue] of sortedEntries(openApi['components'])) {
      if (section === 'schemas') {
        for (const [name, schema] of sortedEntries(sectionValue)) {
          snap(`REST schema ${name}`, schema);
        }
      } else {
        snap(`REST components.${section}`, sectionValue);
      }
    }

    // WS: channels/operations wholesale, then one snapshot per frame message
    // (control + ack + system + session_event payload schemas).
    snap('WS channels', asyncApi['channels']);
    snap('WS operations', asyncApi['operations']);
    const wsComponents = (asyncApi['components'] ?? {}) as Record<string, unknown>;
    for (const [id, message] of sortedEntries(wsComponents['messages'])) {
      snap(`WS frame ${id}`, message);
    }
  });
});
