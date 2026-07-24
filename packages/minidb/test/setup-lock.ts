// test/setup-lock.ts
//
// Vitest setup: install the kernel-backed lock primitive as the process-wide
// default for the whole suite, reproducing the behavior minidb had before the
// lock primitive was inverted (LockFile always used the kernel advisory lock).
// The suite therefore validates minidb's injection contract against one real
// primitive regardless of KIMI_LOCK_IMPL — the experiment's pure-JS variant is
// owned by agent-core-v2, which drives minidb through the injected adapter.
// Child processes spawned by e2e/cluster tests do NOT inherit this file; they
// install the same default at the top of their own entrypoints.

import { tryAcquireKernelFileLock } from '@moonshot-ai/kernel-file-lock';

import { setDefaultTryAcquireFileLock } from '../src/lockfile.js';

setDefaultTryAcquireFileLock(tryAcquireKernelFileLock);
