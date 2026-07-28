/**
 * `localWorkspaceRuntime` domain (L6) — `LocalWorkspaceProvider`, the local
 * branch of `IWorkspaceProvider` (plan §4.1, §4.3).
 *
 * `open(descriptor)` establishes the complete long-lived runtime registration
 * in one shot: it resolves the existing cwd → `wd_id` rule
 * (`encodeWorkDirKey`, or a caller-supplied pre-resolved id), enforces the
 * same root-existence contract `IWorkspaceService.createOrTouch` owns today,
 * builds the `LocalWorkspaceRuntime` and returns it beside the workspace id.
 * It never returns a bare OS object for the App to supplement, and callers
 * never re-open per session operation — Workspace registration/runtime
 * management (M3) keeps the registration alive and reuses it.
 *
 * The provider does NOT maintain a workspace catalog or registration
 * manager: catalog persistence (`workspaces.json`), alias folding and
 * createOrTouch bookkeeping stay with the existing `workspace` domain and
 * the M3 registration manager.
 */

import { stat } from 'node:fs/promises';

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { unwrapErrorCause } from '#/_base/errors/errors';

import type {
  IWorkspaceProvider,
  IWorkspaceRuntimeRegistration,
  WorkspaceDescriptor,
} from '#/app/workspace/workspaceRuntime';
import { ErrorCodes, Error2 } from '#/errors';
import { jsonDocumentCodec } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

import { LocalWorkspaceRuntime } from './localWorkspaceRuntime';
import { isValidIdSegment } from './localWorkspaceLayout';

/**
 * One locally discoverable session bucket (`sessions/<wd_id>`): the workspace
 * id spelling that owns the bucket, plus the workspace root recovered from a
 * readable session metadata document when present (the same
 * `cwd` / `workDir` / `custom.cwd` recovery the session index applies). A
 * bucket with no readable metadata yields no root — the caller decides
 * whether a catalog entry can supply one.
 */
export interface LocalWorkspaceDiscovery {
  readonly workspaceId: string;
  readonly root?: string;
}

export interface LocalWorkspaceProviderOptions {
  /** App home dir the legacy session layout is rooted at. */
  readonly homeDir: string;
  /**
   * Shared storage backend; when absent the provider creates one node-fs
   * `FileStorageService` (rooted at `homeDir`) per opened runtime.
   */
  readonly storage?: IFileSystemStorageService;
}

export class LocalWorkspaceProvider implements IWorkspaceProvider {
  private readonly homeDir: string;
  private readonly storage: IFileSystemStorageService | undefined;

  constructor(options: LocalWorkspaceProviderOptions) {
    this.homeDir = options.homeDir;
    this.storage = options.storage;
  }

  async open(descriptor: WorkspaceDescriptor): Promise<IWorkspaceRuntimeRegistration> {
    await assertExistingDirectory(descriptor.root);
    return this.buildRegistration(descriptor);
  }

  /**
   * Open a runtime over a bucket `discover()` found, WITHOUT the root-existence
   * contract: the bucket already holds sessions, and the v1 rules keep them
   * readable even after the workspace root directory itself was deleted from
   * the host. Session creation through such a runtime is still gated upstream
   * (the v1 create adapter's `createOrTouch` owns root existence).
   */
  async openExisting(descriptor: WorkspaceDescriptor): Promise<IWorkspaceRuntimeRegistration> {
    return this.buildRegistration(descriptor);
  }

  private async buildRegistration(
    descriptor: WorkspaceDescriptor,
  ): Promise<IWorkspaceRuntimeRegistration> {
    const workspaceId = descriptor.workspaceId ?? encodeWorkDirKey(descriptor.root);
    const runtime = new LocalWorkspaceRuntime({
      workspaceId,
      cwd: descriptor.root,
      homeDir: this.homeDir,
      storage: this.storage ?? new FileStorageService(this.homeDir, 0o700, 0o600),
    });
    return {
      workspaceId,
      runtime,
      dispose: () => runtime.close('unregistered'),
    };
  }

  /**
   * Enumerate the local session buckets (`sessions/<wd_id>`) this provider's
   * home dir holds — INCLUDING buckets whose workspace is not (or no longer)
   * in the catalog, since their sessions stay readable under the v1 rules.
   * This is a read-only discovery pass: it registers nothing and opens no
   * runtime; composition/registration management decides what to open.
   */
  async discover(): Promise<readonly LocalWorkspaceDiscovery[]> {
    const storage = this.storage ?? new FileStorageService(this.homeDir, 0o700, 0o600);
    const workspaceIds = await storage.list('sessions').catch(() => [] as string[]);
    const discovered: LocalWorkspaceDiscovery[] = [];
    for (const workspaceId of workspaceIds) {
      // Bucket names feed storage scopes and runtime ids; foreign directory
      // names (not minted by `encodeWorkDirKey`) are defensively skipped.
      if (!isValidIdSegment(workspaceId)) continue;
      discovered.push({
        workspaceId,
        root: await this.recoverBucketRoot(storage, workspaceId),
      });
    }
    return discovered;
  }

  /**
   * Best-effort root recovery for one bucket: the first readable session
   * metadata document's `cwd` / `workDir` / `custom.cwd` (mirrors the session
   * index's `recoverCwd`). Tolerant per session — a missing/corrupt document
   * is simply not a root source, exactly like the index's tolerant reads.
   */
  private async recoverBucketRoot(
    storage: IFileSystemStorageService,
    workspaceId: string,
  ): Promise<string | undefined> {
    const scope = `sessions/${workspaceId}`;
    const sessionIds = await storage.list(scope).catch(() => [] as string[]);
    for (const sessionId of sessionIds) {
      const bytes = await storage.read(`${scope}/${sessionId}`, 'state.json').catch(() => undefined);
      if (bytes === undefined) continue;
      let meta: Record<string, unknown>;
      try {
        const decoded = jsonDocumentCodec.decode(bytes);
        if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) continue;
        meta = decoded as Record<string, unknown>;
      } catch {
        continue;
      }
      const root = recoverCwd(meta);
      if (root !== undefined) return root;
    }
    return undefined;
  }
}

/**
 * The root-existence contract of `createOrTouch`: the root must be an
 * existing directory on the host filesystem, otherwise `fs.path_not_found`.
 */
async function assertExistingDirectory(root: string): Promise<void> {
  let stats;
  try {
    stats = await stat(root);
  } catch (error) {
    const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} does not exist`);
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${root} is not a directory`);
  }
}

/** Mirror of the session index's `recoverCwd` (cwd → workDir → custom.cwd). */
function recoverCwd(meta: Record<string, unknown>): string | undefined {
  if (typeof meta['cwd'] === 'string' && meta['cwd'].length > 0) return meta['cwd'];
  if (typeof meta['workDir'] === 'string' && meta['workDir'].length > 0) {
    return meta['workDir'];
  }
  const custom = meta['custom'];
  if (custom !== null && typeof custom === 'object' && !Array.isArray(custom)) {
    const fromCustom = (custom as Record<string, unknown>)['cwd'];
    if (typeof fromCustom === 'string' && fromCustom.length > 0) return fromCustom;
  }
  return undefined;
}
