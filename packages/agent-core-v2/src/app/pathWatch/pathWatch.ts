/**
 * `pathWatch` domain (L2) — shared absolute-path monitoring contract.
 *
 * Defines the App-scoped factory for disposable path subscriptions that keep
 * raw filesystem changes available to domain projections. Each subscription
 * can replace its candidate set while the shared owner reuses equivalent host
 * watcher handles across App, Session and Agent consumers. Events retain both
 * the requested lexical path and its current canonical target so projections
 * can choose the path namespace their public contract requires.
 */

import type { IDisposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { HostFsChange } from '#/os/interface/hostFsWatch';

export type PathWatchTargetKind = 'file' | 'directory';

export interface PathWatchOptions {
  readonly target: PathWatchTargetKind;
  readonly recursive?: boolean;
  readonly depth?: number;
  readonly followSymlinks?: boolean;
  readonly pollingIntervalMs?: number;
  readonly ignoredPathNames?: readonly string[];
  readonly ignoreDotDirectories?: boolean;
  readonly debounceMs?: number;
}

export interface PathWatchEvent {
  readonly watchedPath: string;
  readonly canonicalPath?: string;
  readonly change?: HostFsChange;
}

export interface IPathWatch extends IDisposable {
  setPaths(paths: readonly string[]): Promise<void>;
}

export interface IPathWatchService {
  readonly _serviceBrand: undefined;

  createWatch(
    options: PathWatchOptions,
    onDidChange: (event: PathWatchEvent) => void,
  ): IPathWatch;
}

export const IPathWatchService: ServiceIdentifier<IPathWatchService> =
  createDecorator<IPathWatchService>('pathWatchService');
