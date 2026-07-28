/**
 * Static guardrails for the multi-runtime refactor (plan §10.1), kap-server side.
 *
 * The kap-server edge has exactly ONE bare-session-id entry point:
 * `IV1SessionRefResolver` (`src/app/v1Compatibility/v1SessionRefResolver.ts`).
 * These tests make that constraint machine-checkable:
 *
 *   1. NO source file may assemble Local session layout paths (`sessions/<wd>`
 *      buckets, `state.json`, `wire.jsonl`) or reference the legacy
 *      layout/index machinery — cold surfaces read through the owner runtime,
 *      never the App home dir (plan §7.6/§9.7). No exemptions.
 *   2. `ISessionIndex` imports are confined to an explicit exemption list
 *      (the not-yet-migrated LIVE routes/WS surface, owned by M5b/M6). The
 *      list may only shrink; every entry states its reason.
 *   3. `ISessionHostRuntimeRegistry` / `IWorkspaceRuntimeManager` may only be
 *      imported inside `src/app/v1Compatibility/` — routes and services must
 *      go through the resolver/projection instead of probing runtimes
 *      themselves (plan §1.3: no per-route runtime scans).
 *
 * Run with
 * `pnpm --filter @moonshot-ai/kap-server exec vitest run test/v1CompatibilityGuard.test.ts`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', 'src');

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** Strip full-line comments so doc references don't trip the literal bans. */
function codeLines(source: string): { line: string; lineNumber: number }[] {
  const lines: { line: string; lineNumber: number }[] = [];
  let inBlock = false;
  source.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    lines.push({ line: raw, lineNumber: index + 1 });
  });
  return lines;
}

/** Rule 1 patterns: Local session layout assembly is banned everywhere. */
const LAYOUT_BANS: { pattern: RegExp; label: string }[] = [
  { pattern: /join\([^)]*'sessions'/, label: "joins a 'sessions' bucket path" },
  { pattern: /'state\.json'/, label: "references the 'state.json' layout file" },
  { pattern: /'wire\.jsonl'/, label: "references the 'wire.jsonl' layout file" },
  { pattern: /SESSIONS_ROOT/, label: 'uses a SESSIONS_ROOT layout constant' },
  { pattern: /bootstrap\.sessionDir|\.sessionDir\(/, label: 'derives a session directory path' },
  { pattern: /LegacyLayoutFileSessionRepository/, label: 'references the legacy layout repository' },
  { pattern: /\bFileSessionIndex\b/, label: 'references the legacy file session index' },
  { pattern: /localWorkspaceLayout|localWorkspaceRuntime/, label: 'imports Local runtime internals' },
];

/**
 * Rule 2 exemptions: files still allowed to import `ISessionIndex` (the LIVE
 * surface M5b/M6 migrates). Anything not listed here must be clean.
 */
const SESSION_INDEX_EXEMPTIONS: Record<string, string> = {
  'routes/sessions.ts':
    'live actions still on the engine lifecycle (undo/fork/profile POST/status/goal/warnings) — M5b',
  'routes/skills.ts': 'live skill surface — M5b',
  'routes/tools.ts': 'live tool surface — M5b',
  'transport/ws/v1/sessionEventBroadcaster.ts': 'WebSocket live surface — M6',
};

/** Rule 3: runtime registry/manager imports are v1Compatibility-only. */
const RUNTIME_IMPORT_BAN = /ISessionHostRuntimeRegistry|IWorkspaceRuntimeManager/;

describe('v1 compatibility guardrails (plan §10.1)', () => {
  it('no source file assembles Local session layout paths or imports legacy layout machinery', async () => {
    const violations: string[] = [];
    for (const file of await listSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      const source = await readFile(file, 'utf8');
      for (const { line, lineNumber } of codeLines(source)) {
        for (const ban of LAYOUT_BANS) {
          if (ban.pattern.test(line)) {
            violations.push(`${rel}:${lineNumber} ${ban.label}: ${line.trim()}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('ISessionIndex imports stay inside the explicit M5b/M6 exemption list', async () => {
    const importers: string[] = [];
    for (const file of await listSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      const source = await readFile(file, 'utf8');
      const importsIndex = codeLines(source).some(
        ({ line }) => line.includes('ISessionIndex') && !line.trimStart().startsWith('type '),
      );
      if (importsIndex) importers.push(rel);
    }
    for (const importer of importers) {
      expect(
        SESSION_INDEX_EXEMPTIONS[importer],
        `${importer} imports ISessionIndex but is not in the exemption list — resolve bare ids through IV1SessionRefResolver instead (plan §1.3)`,
      ).toBeDefined();
    }
    // The list only shrinks: every listed exemption still exists for a reason.
    expect(importers.toSorted()).toEqual(Object.keys(SESSION_INDEX_EXEMPTIONS).toSorted());
  });

  it('runtime registry/manager imports are confined to src/app/v1Compatibility', async () => {
    const violations: string[] = [];
    for (const file of await listSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (rel.startsWith(join('app', 'v1Compatibility'))) continue;
      const source = await readFile(file, 'utf8');
      for (const { line, lineNumber } of codeLines(source)) {
        if (RUNTIME_IMPORT_BAN.test(line)) {
          violations.push(`${rel}:${lineNumber}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
