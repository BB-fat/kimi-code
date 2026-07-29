/**
 * `FeedbackService` — JSONL-backed implementation of `IFeedbackService`.
 * Writes are serialized through a promise queue (same pattern as
 * `GuiStoreService`) so concurrent submissions never interleave a line.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ulid } from 'ulid';

import { IFeedbackService, type FeedbackEntry, type FeedbackRecord } from './feedback';

export class FeedbackService implements IFeedbackService {
  readonly _serviceBrand: undefined;

  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(homeDir: string) {
    this.filePath = join(homeDir, 'feedback', 'feedback.jsonl');
  }

  async submit(entry: FeedbackEntry): Promise<FeedbackRecord> {
    const record: FeedbackRecord = { id: ulid(), time: Date.now(), ...entry };
    const line = `${JSON.stringify(record)}\n`;
    await this.withLock(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, line, { encoding: 'utf-8', mode: 0o600 });
    });
    return record;
  }

  private withLock(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
