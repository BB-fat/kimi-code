/**
 * Black-box server launcher shim.
 *
 * Spawned BY `compare.mts` as a child process (via the CURRENT tree's tsx) but
 * dynamically imports `startServer` from the tree named by `BB_TREE` — which
 * may be the old-baseline git worktree. This file must therefore stay free of
 * any imports from the hosting repo: the ONLY module it loads is the target
 * tree's `packages/kap-server/src/start.ts`.
 *
 * Env:
 *   BB_TREE — absolute path of the repo tree to boot (old worktree or current).
 *   BB_HOME — server homeDir (config.toml already written there by compare).
 *   BB_CWD  — workspace directory; used as the process cwd.
 *
 * Protocol: prints one `BB_READY {"port":N,"token":"..."}` line on stdout once
 * listening, then stays alive until SIGTERM/SIGINT, which triggers
 * `server.close()`. Anything else on stdout/stderr is diagnostic only.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface RunningServerLike {
  readonly port: number;
  readonly authTokenService: { getToken(): string | Promise<string> };
  close(): Promise<void>;
}

interface StartModule {
  startServer(opts: {
    host: string;
    port: number;
    homeDir: string;
    logLevel: string;
    version: string;
  }): Promise<RunningServerLike>;
}

const BB_TREE = process.env['BB_TREE'];
const BB_HOME = process.env['BB_HOME'];
const BB_CWD = process.env['BB_CWD'];

if (BB_TREE === undefined || BB_HOME === undefined) {
  process.stderr.write('run-server: BB_TREE and BB_HOME env vars are required\n');
  process.exit(2);
}
if (BB_CWD !== undefined) {
  process.chdir(BB_CWD);
}

const startUrl = pathToFileURL(join(BB_TREE, 'packages/kap-server/src/start.ts')).href;
const startModule = (await import(startUrl)) as StartModule;

const server = await startModule.startServer({
  host: '127.0.0.1',
  port: 0,
  homeDir: BB_HOME,
  logLevel: 'silent',
  version: 'blackbox',
});
const token = await server.authTokenService.getToken();
process.stdout.write(`BB_READY ${JSON.stringify({ port: server.port, token })}\n`);

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  void server
    .close()
    .catch(() => undefined)
    .then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
