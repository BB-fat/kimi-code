/**
 *   POST /v1/feedback
 *
 * Wire shapes for the user feedback collection endpoint. The wire uses
 * snake_case (REST convention in this repo); the payload is appended to the
 * server-local JSONL feedback log as-is (see `src/services/feedback/`).
 */

import { z } from 'zod';

export const feedbackSubmitBodySchema = z.object({
  message: z.string().min(1).max(20000),
  rating: z.enum(['up', 'down']).optional(),
  session_id: z.string().min(1).max(256).optional(),
  agent_id: z.string().min(1).max(256).optional(),
});
export type FeedbackSubmitBody = z.infer<typeof feedbackSubmitBodySchema>;
