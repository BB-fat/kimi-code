import { createDecorator } from '@moonshot-ai/agent-core-v2';

import type { FeedbackDiagnostics, FeedbackType } from '../../protocol/rest-feedback';

/**
 * `IFeedbackService` — append-only sink for user feedback submitted over
 * `POST /api/v1/feedback`. Each submission is persisted as one JSON line in
 * `<homeDir>/feedback/feedback.jsonl`, stamped with a server-generated `id`
 * (ULID) and `time` (epoch ms). Record fields keep the wire's snake_case
 * naming so the log can be shipped to a collection backend unchanged.
 */
export interface FeedbackEntry {
  readonly type?: FeedbackType;
  readonly content: string;
  readonly title?: string;
  readonly contact?: string;
  readonly diagnostics?: FeedbackDiagnostics;
  readonly session_id?: string;
  readonly agent_id?: string;
  readonly info?: Record<string, unknown>;
}

export interface FeedbackRecord extends FeedbackEntry {
  readonly id: string;
  readonly time: number;
}

export interface IFeedbackService {
  readonly _serviceBrand: undefined;
  submit(entry: FeedbackEntry): Promise<FeedbackRecord>;
}

export const IFeedbackService = createDecorator<IFeedbackService>('feedbackService');
