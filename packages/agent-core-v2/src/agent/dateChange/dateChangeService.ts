/**
 * `dateChange` domain (L4) — `IAgentDateChangeService` implementation.
 *
 * Owns the `date_change` context-injection provider. The system prompt is only
 * re-rendered at profile (re)bind and after compaction, so a session that runs
 * past midnight keeps a stale date; this provider appends a system-reminder at
 * the next step boundary instead. The baseline is history-derived: the last
 * `date_change` reminder in context, else the date rendered into the current
 * system prompt, else the volatile `seededDate` adopted at first evaluation
 * (custom profiles without a date line). Dedup and resume safety fall out of
 * the ladder — nothing is persisted beyond the reminder messages themselves.
 * The plain-data state (`seededDate`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';

import { IAgentDateChangeService } from './dateChange';

const DATE_CHANGE_INJECTION_VARIANT = 'date_change';

const SYSTEM_PROMPT_NOW_PATTERN = /current date and time in ISO format is `([^`]+)`/;
const REMINDER_DATE_PATTERN = /Today's date is now (\d{4}-\d{2}-\d{2})/;

export const dateChangeSeededDateKey = defineState<string | undefined>(
  'dateChange.seededDate',
  () => undefined,
);

export class AgentDateChangeService extends Disposable implements IAgentDateChangeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(dateChangeSeededDateKey);
    this._register(
      dynamicInjector.register(DATE_CHANGE_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private get seededDate(): string | undefined {
    return this.states.get(dateChangeSeededDateKey);
  }

  private set seededDate(value: string | undefined) {
    this.states.set(dateChangeSeededDateKey, value);
  }

  private reminder({ lastInjectedAt }: ContextInjectionContext): string | undefined {
    const today = localDateKey(new Date());
    const baseline = this.baseline(lastInjectedAt) ?? this.adopt(today);
    if (baseline === today) return undefined;
    return `The date has changed. Today's date is now ${today}. The date and time stated in your system prompt are stale; rely on this reminder for the current date. DO NOT mention this to the user explicitly.`;
  }

  private baseline(lastInjectedAt: number | null): string | undefined {
    return this.dateFromHistory(lastInjectedAt) ?? this.dateFromSystemPrompt() ?? this.seededDate;
  }

  private adopt(today: string): string {
    this.seededDate = today;
    return today;
  }

  private dateFromHistory(lastInjectedAt: number | null): string | undefined {
    if (lastInjectedAt === null) return undefined;
    const message: ContextMessage | undefined = this.context.get()[lastInjectedAt];
    if (message === undefined) return undefined;
    const match = REMINDER_DATE_PATTERN.exec(messageText(message));
    return match?.[1];
  }

  private dateFromSystemPrompt(): string | undefined {
    const match = SYSTEM_PROMPT_NOW_PATTERN.exec(this.profile.getSystemPrompt());
    if (match?.[1] === undefined) return undefined;
    const rendered = new Date(match[1]);
    if (Number.isNaN(rendered.getTime())) return undefined;
    return localDateKey(rendered);
  }
}

function messageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentDateChangeService,
  AgentDateChangeService,
  ScopeActivation.OnScopeCreated,
  'dateChange',
);
