/**
 *   POST /v1/feedback
 *
 * Wire shapes for the user feedback collection endpoint. The wire uses
 * snake_case (REST convention in this repo); the payload is appended to the
 * server-local JSONL feedback log as-is (see `src/services/feedback/`).
 *
 * The field set mirrors the product feedback form (type / title / content /
 * contact / diagnostics) and keeps `content` / `contact` / `info` aligned
 * with the collection backend's metadata contract, so a future upload
 * pipeline can forward records without remapping.
 */

import { z } from 'zod';

/** 反馈类型:报错 / 疑似 bug、功能许愿、其他。 */
export const feedbackTypeSchema = z.enum(['bug', 'feature', 'other']);
export type FeedbackType = z.infer<typeof feedbackTypeSchema>;

/** 附带诊断信息:不提供、本地日志、本地日志 + 代码仓库。 */
export const feedbackDiagnosticsSchema = z.enum(['none', 'logs', 'logs_and_codebase']);
export type FeedbackDiagnostics = z.infer<typeof feedbackDiagnosticsSchema>;

export const feedbackSubmitBodySchema = z.object({
  type: feedbackTypeSchema.optional(),
  content: z.string().min(1).max(20000),
  title: z.string().min(1).max(256).optional(),
  contact: z.string().min(1).max(256).optional(),
  diagnostics: feedbackDiagnosticsSchema.optional(),
  session_id: z.string().min(1).max(256).optional(),
  agent_id: z.string().min(1).max(256).optional(),
  info: z.record(z.string(), z.unknown()).optional(),
});
export type FeedbackSubmitBody = z.infer<typeof feedbackSubmitBodySchema>;
