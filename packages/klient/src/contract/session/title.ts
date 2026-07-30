/**
 * `sessionTitleService` — on-demand session title generation. Mirrors
 * `agent-core-v2/session/sessionTitle/sessionTitle.ts`.
 */

import { z } from 'zod';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const generateTitleOptionsSchema = z.object({ force: z.boolean().optional() });

export const sessionTitleContract = {
  generateTitle: {
    input: z.tuple([generateTitleOptionsSchema.optional()]),
    output: maybe(z.string()),
  },
} satisfies ServiceContract;
