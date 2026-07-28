/**
 * Black-box old-vs-new kap-server comparison orchestrator.
 *
 * Runs the SAME scenario (`scenario.mts`) against two server binaries:
 *   - `old`: the baseline commit (BASE_COMMIT) checked out as a git worktree
 *     under `.tmp/blackbox/old-tree`;
 *   - `new`: the current working tree.
 *
 * Each server boots in a child process (`run-server.mts` shim, current tree's
 * tsx, target tree's sources) with a fresh mkdtemp homeDir whose config.toml
 * points the stub provider at a deterministic in-process fake LLM. The two
 * raw records are normalized (`normalize.mts`) and deep-compared; any
 * remaining difference is a wire-surface difference between the trees.
 *
 * Usage: `pnpm --filter @moonshot-ai/kap-server blackbox:compare`
 * Artifacts: `.tmp/blackbox/out/{old,new}.{record,normalized}.json`,
 *            `.tmp/blackbox/out/diff.report.txt` (on mismatch).
 * Exit: 0 = BLACKBOX MATCH, 1 = records differ, 2 = infrastructure failure.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createNormalizeContext,
  normalizeExportContent,
  normalizeValue,
  stableStringify,
} from './normalize.mts';
import { runScenario, type ScenarioRecord } from './scenario.mts';

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const BB_DIR = join(ROOT, '.tmp/blackbox');
const OLD_TREE = join(BB_DIR, 'old-tree');
const OUT_DIR = join(BB_DIR, 'out');
const WORK_DIR = join(BB_DIR, 'workdir');
const BASE_COMMIT = 'f79fde2b9';
const TSX_BIN = join(ROOT, 'node_modules/.bin/tsx');
const RUN_SERVER = join(ROOT, 'packages/kap-server/test/blackbox/run-server.mts');

function log(message: string): void {
  process.stderr.write(`[blackbox] ${message}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Old-tree worktree + install (idempotent, re-runnable).
// ---------------------------------------------------------------------------

async function ensureOldTree(): Promise<void> {
  if (!(await pathExists(OLD_TREE))) {
    log(`creating old-tree worktree at ${OLD_TREE} (${BASE_COMMIT})`);
    await execFileAsync('git', ['-C', ROOT, 'worktree', 'prune']);
    await execFileAsync('git', ['-C', ROOT, 'worktree', 'add', '--force', OLD_TREE, BASE_COMMIT]);
  }
  if (!(await pathExists(join(OLD_TREE, 'node_modules')))) {
    log('installing old-tree dependencies (pnpm install --frozen-lockfile)');
    await runCommand('pnpm', ['install', '--frozen-lockfile'], {
      cwd: OLD_TREE,
      env: { ...process.env, SKIP_SIMPLE_GIT_HOOKS: '1' },
      inherit: true,
    });
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; inherit?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.inherit === true ? 'inherit' : 'pipe',
    });
    let captured = '';
    child.stdout?.on('data', (d: Buffer) => (captured += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (captured += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}\n${captured}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Fake OpenAI provider: deterministic SSE answer for every chat completion.
// ---------------------------------------------------------------------------

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const CHAT_SSE_BODY =
  sseChunk({
    id: 'chatcmpl-blackbox',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'BLACKBOX' }, finish_reason: null }],
  }) +
  sseChunk({
    id: 'chatcmpl-blackbox',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub',
    choices: [{ index: 0, delta: { content: '-REPLY' }, finish_reason: null }],
  }) +
  sseChunk({
    id: 'chatcmpl-blackbox',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  }) +
  'data: [DONE]\n\n';

async function startFakeProvider(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(CHAT_SSE_BODY);
      });
      return;
    }
    req.resume();
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'blackbox fake provider: not found' } }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('fake provider not bound');
  return { port: address.port, server };
}

function configToml(providerPort: number): string {
  return [
    'default_model = "stub"',
    '',
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${String(providerPort)}/v1"`,
    'api_key = "stub"',
    '',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 100000',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Server child process.
// ---------------------------------------------------------------------------

interface BootedServer {
  readonly port: number;
  readonly token: string;
  readonly child: ChildProcess;
  readonly logs: string[];
}

function bootServer(tree: string, home: string, label: string): Promise<BootedServer> {
  return new Promise((resolve, reject) => {
    const logs: string[] = [];
    const child = spawn(
      TSX_BIN,
      ['--import', join(tree, 'build/register-raw-text-loader.mjs'), RUN_SERVER],
      {
        // cwd MUST be the target tree root: tsx discovers the tsconfig from
        // the process cwd at loader-init time, and the engine needs the
        // tree's `experimentalDecorators` transform. `run-server.mts` then
        // chdirs to BB_CWD (the shared workspace dir) before booting, so both
        // servers run with the same process cwd.
        cwd: tree,
        env: { ...process.env, BB_TREE: tree, BB_HOME: home, BB_CWD: WORK_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdoutBuf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} server did not print BB_READY within 180s\n${logs.join('')}`));
    }, 180_000);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logs.push(text);
      stdoutBuf += text;
      const line = stdoutBuf.split('\n').find((l) => l.startsWith('BB_READY '));
      if (line !== undefined) {
        clearTimeout(timer);
        const ready = JSON.parse(line.slice('BB_READY '.length)) as { port: number; token: string };
        resolve({ port: ready.port, token: ready.token, child, logs });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} server exited early with code ${String(code)}\n${logs.join('')}`));
    });
  });
}

async function stopServer(boot: BootedServer): Promise<void> {
  const { child } = boot;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 15_000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    child.kill('SIGTERM');
  });
}

// ---------------------------------------------------------------------------
// One full run against one tree.
// ---------------------------------------------------------------------------

interface RunResult {
  readonly record: ScenarioRecord;
  readonly home: string;
}

async function runOne(label: 'old' | 'new', tree: string, providerPort: number): Promise<RunResult> {
  const home = await mkdtemp(join(tmpdir(), `kimi-blackbox-${label}-`));
  await writeFile(join(home, 'config.toml'), configToml(providerPort));
  log(`${label}: booting server from ${tree} (home ${home})`);
  const boot = await bootServer(tree, home, label);
  try {
    log(`${label}: server on 127.0.0.1:${String(boot.port)}, running scenario`);
    const record = await runScenario({
      baseUrl: `http://127.0.0.1:${String(boot.port)}`,
      token: boot.token,
      cwd: WORK_DIR,
      workDir: WORK_DIR,
    });
    return { record, home };
  } finally {
    await stopServer(boot);
    await writeFile(join(OUT_DIR, `${label}.server.log`), boot.logs.join(''));
    log(`${label}: server stopped`);
  }
}

// ---------------------------------------------------------------------------
// Normalization + structural diff.
// ---------------------------------------------------------------------------

async function normalizeRecord(record: ScenarioRecord, home: string): Promise<ScenarioRecord> {
  const literals = [home];
  try {
    literals.push(await realpath(home));
  } catch {
    // best effort — the non-realpath form is already covered
  }
  const ctx = createNormalizeContext(literals);
  const normalized = normalizeValue(record, ctx) as ScenarioRecord;
  const entries = normalized.export.entries.map((entry) =>
    entry.kind === 'text' && entry.content !== undefined
      ? { ...entry, content: normalizeExportContent(entry.content, ctx) }
      : entry,
  );
  return { ...normalized, export: { ...normalized.export, entries } };
}

interface DiffItem {
  readonly path: string;
  readonly oldValue: string;
  readonly newValue: string;
}

/**
 * Registered wire differences between the baseline and the current tree,
 * each keyed by scenario step + field suffix and carrying its justification.
 * A diff matching an entry is reported as KNOWN (not counted against the
 * match); anything else fails the comparison. Every entry must name the
 * milestone that introduced the difference and why it is accepted — an
 * entry without a living justification gets deleted, never extended.
 */
const KNOWN_DIFFERENCES: readonly { readonly step: string; readonly fieldSuffix: string; readonly reason: string }[] = [
  {
    step: 'err_prompt_unknown_session',
    fieldSuffix: '.response.body.stack',
    reason:
      'M5c (branch, pre-M6): the resolver-mapped 40401 envelope on the prompts route no longer carries ' +
      'the ad-hoc `stack` field. The field leaks absolute server paths/line numbers and its content is ' +
      'inherently unfreezable, so the drop is ratified as an intentional fix; `stack` remains on the ' +
      '50001 catch-all path. Note the sibling step err_transcript_unknown_session never carried it.',
  },
];

/** A diff is known when its step name + field suffix match a registered entry. */
function knownDifferenceReason(diff: DiffItem, record: ScenarioRecord): string | undefined {
  const match = /^\$\.steps\[(\d+)\]/.exec(diff.path);
  if (match === null) return undefined;
  const stepName = record.steps[Number(match[1])]?.name;
  for (const known of KNOWN_DIFFERENCES) {
    if (stepName === known.step && diff.path.endsWith(known.fieldSuffix)) return known.reason;
  }
  return undefined;
}

function preview(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function collectDiffs(a: unknown, b: unknown, path: string, out: DiffItem[]): void {
  if (out.length >= 500) return;
  if (Object.is(a, b)) return;
  const aIsObj = typeof a === 'object' && a !== null;
  const bIsObj = typeof b === 'object' && b !== null;
  if (!aIsObj || !bIsObj || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path, oldValue: preview(a), newValue: preview(b) });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) {
      collectDiffs(a[i], b[i], `${path}[${String(i)}]`, out);
    }
    if (a.length !== b.length) {
      out.push({
        path: `${path}.length`,
        oldValue: String(a.length),
        newValue: String(b.length),
      });
    }
    return;
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  for (const key of Object.keys(aRec)) {
    if (!(key in bRec)) {
      out.push({ path: `${path}.${key}`, oldValue: preview(aRec[key]), newValue: '<missing>' });
      continue;
    }
    collectDiffs(aRec[key], bRec[key], `${path}.${key}`, out);
  }
  for (const key of Object.keys(bRec)) {
    if (!(key in aRec)) {
      out.push({ path: `${path}.${key}`, oldValue: '<missing>', newValue: preview(bRec[key]) });
    }
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  // Default: baseline worktree vs current tree. `BB_TREES=old,old` / `new,new`
  // runs a same-tree stability check (classifies ordering races vs real wire
  // differences); explicit absolute paths are also accepted.
  const treeOverride = process.env['BB_TREES'];
  const trees: [string, string] =
    treeOverride !== undefined
      ? (treeOverride.split(',').map((t) => (t === 'old' ? OLD_TREE : t === 'new' ? ROOT : t)) as [
          string,
          string,
        ])
      : [OLD_TREE, ROOT];
  if (trees[0] === OLD_TREE || trees[1] === OLD_TREE) {
    await ensureOldTree();
  }

  const provider = await startFakeProvider();
  log(`fake provider on 127.0.0.1:${String(provider.port)}`);
  try {
    const oldRun = await runOne('old', trees[0], provider.port);
    await writeFile(join(OUT_DIR, 'old.record.json'), `${stableStringify(oldRun.record)}\n`);
    const newRun = await runOne('new', trees[1], provider.port);
    await writeFile(join(OUT_DIR, 'new.record.json'), `${stableStringify(newRun.record)}\n`);

    const oldNormalized = await normalizeRecord(oldRun.record, oldRun.home);
    const newNormalized = await normalizeRecord(newRun.record, newRun.home);
    await writeFile(join(OUT_DIR, 'old.normalized.json'), `${stableStringify(oldNormalized)}\n`);
    await writeFile(join(OUT_DIR, 'new.normalized.json'), `${stableStringify(newNormalized)}\n`);

    const diffs: DiffItem[] = [];
    collectDiffs(oldNormalized, newNormalized, '$', diffs);
    const known = diffs.map((d) => ({ diff: d, reason: knownDifferenceReason(d, oldNormalized) }));
    const unknown = known.filter((entry) => entry.reason === undefined);
    const registered = known.filter((entry) => entry.reason !== undefined);
    for (const entry of registered) {
      process.stdout.write(
        `BLACKBOX KNOWN-DIFF: ${entry.diff.path}\n  reason: ${entry.reason ?? ''}\n`,
      );
    }
    if (diffs.length === 0 || unknown.length === 0) {
      const suffix =
        registered.length > 0 ? ` (${String(registered.length)} registered known difference(s))` : '';
      process.stdout.write(`BLACKBOX MATCH${suffix}\n`);
      return 0;
    }
    const lines = unknown.slice(0, 100).map(
      (entry) => `${entry.diff.path}\n  old: ${entry.diff.oldValue}\n  new: ${entry.diff.newValue}`,
    );
    const report = [
      `BLACKBOX DIFF: ${String(unknown.length)} unregistered difference(s) (showing ${String(lines.length)})`,
      '',
      ...lines,
      '',
      `normalized records: ${join(OUT_DIR, 'old.normalized.json')} vs ${join(OUT_DIR, 'new.normalized.json')}`,
    ].join('\n');
    await writeFile(join(OUT_DIR, 'diff.report.txt'), `${report}\n`);
    process.stdout.write(`${report}\n`);
    return 1;
  } finally {
    provider.server.close();
  }
}

try {
  process.exit(await main());
} catch (error: unknown) {
  process.stderr.write(
    `[blackbox] infrastructure failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(2);
}
