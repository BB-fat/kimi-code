/**
 * `FeedbackService` — forwards feedback to the managed collection backend,
 * mirroring the CLI's `/feedback` implementation (`apps/kimi-code/src/feedback/`
 * on top of `@moonshot-ai/kimi-code-oauth`): the submission is POSTed to
 * `{kimiCodeBaseUrl}/feedback` with the managed provider's OAuth access token,
 * stamped with the host version, server OS, and default model. Form-only
 * fields (`type` / `title` / `diagnostics` / `agent_id`) fold into the
 * backend's structured `info` bag.
 */

import { release as osRelease, type as osType } from 'node:os';

import { IOAuthService, IModelService } from '@moonshot-ai/agent-core-v2';
import {
  fetchCompleteFeedbackUpload,
  fetchCreateFeedbackUploadUrl,
  fetchSubmitFeedback,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeFeedbackUrl,
} from '@moonshot-ai/kimi-code-oauth';

import {
  FeedbackError,
  IFeedbackService,
  type FeedbackEntry,
  type FeedbackUploadCompleteInput,
  type FeedbackUploadUrlInput,
  type FeedbackUploadUrlResult,
} from './feedback';

/**
 * Sent in the feedback `version` field so the backend can distinguish this
 * TypeScript client from clients that send a bare version (mirrors the CLI).
 */
const FEEDBACK_VERSION_PREFIX = 'kimi-code-';

export interface FeedbackServiceDeps {
  readonly oauth: IOAuthService;
  readonly model: IModelService;
  readonly version: string;
}

export class FeedbackService implements IFeedbackService {
  readonly _serviceBrand: undefined;

  constructor(private readonly deps: FeedbackServiceDeps) {}

  async submit(entry: FeedbackEntry): Promise<{ feedbackId: number }> {
    const accessToken = await this.accessToken();
    const info: Record<string, unknown> = {
      type: entry.type,
      title: entry.title,
      diagnostics: entry.diagnostics,
      agent_id: entry.agent_id,
      ...entry.info,
    };
    const result = await fetchSubmitFeedback(kimiCodeFeedbackUrl(), accessToken, {
      session_id: entry.session_id,
      content: entry.content,
      version: `${FEEDBACK_VERSION_PREFIX}${this.deps.version}`,
      os: `${osType()} ${osRelease()}`,
      model: this.deps.model.getDefaultModel() ?? null,
      contact: entry.contact,
      info: Object.values(info).some((value) => value !== undefined) ? info : undefined,
    });
    if (result.kind === 'error') {
      throw new FeedbackError('backend_error', result.message, result.status);
    }
    return { feedbackId: result.feedbackId };
  }

  async createUploadUrl(input: FeedbackUploadUrlInput): Promise<FeedbackUploadUrlResult> {
    const accessToken = await this.accessToken();
    const result = await fetchCreateFeedbackUploadUrl(accessToken, {
      file_hash: input.file_hash,
      file_name: input.file_name,
      file_size: input.file_size,
      feedback_id: input.feedback_id,
    });
    if (result.kind === 'error') {
      throw new FeedbackError('backend_error', result.message, result.status);
    }
    return { upload_id: result.upload_id, parts: result.parts };
  }

  async completeUpload(input: FeedbackUploadCompleteInput): Promise<void> {
    const accessToken = await this.accessToken();
    const result = await fetchCompleteFeedbackUpload(accessToken, {
      upload_id: input.upload_id,
      parts: input.parts.map((part) => ({ part_number: part.part_number, etag: part.etag })),
    });
    if (result.kind === 'error') {
      throw new FeedbackError('backend_error', result.message, result.status);
    }
  }

  private async accessToken(): Promise<string> {
    const status = await this.deps.oauth
      .status(KIMI_CODE_PROVIDER_NAME)
      .catch(() => ({ loggedIn: false }) as { loggedIn: boolean });
    if (!status.loggedIn) {
      throw new FeedbackError(
        'not_signed_in',
        'not signed in to the managed Kimi Code provider; sign in before submitting feedback',
      );
    }
    const tokenProvider = this.deps.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME);
    if (tokenProvider === undefined) {
      throw new FeedbackError(
        'not_signed_in',
        'the managed Kimi Code provider is not configured; sign in before submitting feedback',
      );
    }
    try {
      return await tokenProvider.getAccessToken();
    } catch (error) {
      throw new FeedbackError(
        'not_signed_in',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
