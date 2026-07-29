/**
 * `/feedback` route handler — user feedback collection.
 *
 * Thin adapter over the hand-constructed `IFeedbackService` (see
 * `src/services/feedback/`): the validated wire body is appended to the
 * server-local JSONL feedback log; storage failures map to `50000`.
 *
 *   POST /feedback   body: FeedbackSubmitBody   data: null
 */

import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { feedbackSubmitBodySchema } from '../protocol/rest-feedback';
import type { IFeedbackService } from '../services/feedback/feedback';

interface FeedbackRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerFeedbackRoutes(app: FeedbackRouteHost, feedback: IFeedbackService): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/feedback',
      body: feedbackSubmitBodySchema,
      success: { data: z.null() },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'Submit user feedback; appended to the server-local feedback log',
      tags: ['feedback'],
    },
    async (req, reply) => {
      try {
        await feedback.submit(req.body);
        reply.send(okEnvelope(null, req.id));
      } catch (error) {
        requestLog(req)?.error({ err: error }, 'feedback submit failed');
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error),
            req.id,
            error instanceof Error ? error.stack : undefined,
          ),
        );
      }
    },
  );
  app.post(route.path, route.options, route.handler as Parameters<FeedbackRouteHost['post']>[2]);
}
