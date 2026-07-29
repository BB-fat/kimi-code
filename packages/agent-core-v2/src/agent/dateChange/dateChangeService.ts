/**
 * `dateChange` domain (L4) — `IAgentDateChangeService` implementation.
 *
 * Owns the `date_change` context-injection provider. The system prompt is only
 * re-rendered at profile (re)bind and after compaction, so a session that runs
 * past midnight keeps a stale date; this provider appends a system-reminder at
 * the next step boundary instead. Baselines come from typed reminder metadata
 * or the latest persisted prompt disclosure, ordered by render generation.
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';

import { IAgentDateChangeService } from './dateChange';

const DATE_CHANGE_INJECTION_VARIANT = 'date_change';

export class AgentDateChangeService extends Disposable implements IAgentDateChangeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    super();
    this._register(
      dynamicInjector.register(DATE_CHANGE_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private reminder({ lastInjectedAt }: ContextInjectionContext): ContextInjectionResult | undefined {
    const profileData = this.profile.data();
    if (profileData.environmentDisclosure?.cwd !== profileData.cwd) return undefined;
    const current = currentDateDisclosure();
    const baseline = this.baseline(lastInjectedAt);
    if (baseline === undefined || baseline.localDate === current.localDate) return undefined;
    return {
      content: `The date has changed. Today's date is now ${current.localDate}. The date and time stated in your system prompt are stale; rely on this reminder for the current date. DO NOT mention this to the user explicitly.`,
      disclosure: {
        kind: 'date',
        renderGeneration: profileData.renderGeneration ?? 0,
        localDate: current.localDate,
        timeZone: current.timeZone,
      },
    };
  }

  private baseline(lastInjectedAt: number | null): DateDisclosure | undefined {
    const history = this.dateFromHistory(lastInjectedAt);
    const persisted = this.dateFromProfile();
    if (history !== undefined && (persisted === undefined || history.renderGeneration >= persisted.renderGeneration)) {
      return history;
    }
    return persisted;
  }

  private dateFromHistory(lastInjectedAt: number | null): DateDisclosure | undefined {
    const history = this.context.get();
    const start = lastInjectedAt === null ? history.length - 1 : Math.min(lastInjectedAt, history.length - 1);
    for (let index = start; index >= 0; index--) {
      const message: ContextMessage | undefined = history[index];
      const disclosure =
        message?.origin?.kind === 'injection' &&
        message.origin.variant === DATE_CHANGE_INJECTION_VARIANT
          ? message.origin.disclosure
          : undefined;
      if (disclosure?.kind === 'date') return disclosure;
    }
    return undefined;
  }

  private dateFromProfile(): DateDisclosure | undefined {
    const profileData = this.profile.data();
    if (profileData.environmentDisclosure?.cwd !== profileData.cwd) return undefined;
    const date = profileData.environmentDisclosure.date;
    if (!date?.disclosed) return undefined;
    return {
      ...date.value,
      renderGeneration: profileData.renderGeneration ?? 0,
    };
  }
}

interface DateDisclosure {
  readonly localDate: string;
  readonly timeZone: string;
  readonly renderGeneration: number;
}

function currentDateDisclosure(): Omit<DateDisclosure, 'renderGeneration'> {
  const date = new Date();
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return {
    localDate: `${year}-${month}-${day}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentDateChangeService,
  AgentDateChangeService,
  ScopeActivation.OnScopeCreated,
  'dateChange',
);
