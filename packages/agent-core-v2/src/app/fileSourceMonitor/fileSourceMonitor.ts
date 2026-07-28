/**
 * `fileSourceMonitor` domain (L2) — shared live-file-source monitoring contract.
 *
 * Defines the App-scoped factory for disposable path subscriptions. Each
 * subscription can replace its candidate set while the shared owner reuses
 * equivalent host watcher handles across Session and Agent consumers.
 */

import type { IDisposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type FileSourceTargetKind = 'file' | 'directory';

export interface FileSourceWatchOptions {
  readonly target: FileSourceTargetKind;
  readonly recursive?: boolean;
  readonly depth?: number;
  readonly followSymlinks?: boolean;
  readonly pollingIntervalMs?: number;
  readonly ignoredPathNames?: readonly string[];
  readonly ignoreDotDirectories?: boolean;
  readonly debounceMs?: number;
}

export interface IFileSourceWatch extends IDisposable {
  setPaths(paths: readonly string[]): Promise<void>;
}

export interface IFileSourceMonitor {
  readonly _serviceBrand: undefined;

  createWatch(
    options: FileSourceWatchOptions,
    onDidChange: () => void,
  ): IFileSourceWatch;
}

export const IFileSourceMonitor: ServiceIdentifier<IFileSourceMonitor> =
  createDecorator<IFileSourceMonitor>('fileSourceMonitor');
