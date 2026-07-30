/**
 * `dateChange` domain (L4) — `IAgentDateChangeService` implementation.
 *
 * Owns the `date_change` context-injection provider. The system prompt is only
 * re-rendered at profile (re)bind and after compaction, so a session that runs
 * past midnight keeps a stale date; this provider appends a system-reminder at
 * the next step boundary instead. The provider runs only while the profile's
 * rendered snapshot exists and matches the live cwd. The baseline prefers the
 * typed disclosure on the newest surviving `date_change` injection, then the
 * persisted rendered snapshot, then a runtime seed kept in `agentState`: a
 * profile whose snapshot declares no date disclosure is seeded with the first
 * observed date (quietly), so a crossed midnight still announces afterwards.
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import {
  disclosureOfKind,
  pickDisclosureBaseline,
} from '#/agent/contextInjector/disclosureBaseline';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';

import { IAgentDateChangeService } from './dateChange';

const DATE_CHANGE_INJECTION_VARIANT = 'date_change';

export const dateChangeSeedKey = defineState<DateDisclosure | undefined>(
  'dateChange.seed',
  () => undefined,
);

export class AgentDateChangeService extends Disposable implements IAgentDateChangeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(dateChangeSeedKey);
    this._register(
      dynamicInjector.register(DATE_CHANGE_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private reminder({
    lastDisclosure,
  }: ContextInjectionContext): ContextInjectionResult | undefined {
    const profileData = this.profile.data();
    if (profileData.environmentDisclosure?.cwd !== profileData.cwd) return undefined;
    const renderGeneration = profileData.renderGeneration ?? 0;
    const current = currentDateDisclosure();
    const baseline = pickDisclosureBaseline<DateDisclosure>(
      disclosureOfKind(lastDisclosure, 'date'),
      this.dateFromProfile(),
      this.states.get(dateChangeSeedKey),
    );
    if (baseline === undefined) {
      this.states.set(dateChangeSeedKey, { ...current, renderGeneration });
      return undefined;
    }
    if (baseline.localDate === current.localDate) return undefined;
    return {
      content: `The date has changed. Today's date is now ${current.localDate}. The date and time stated in your system prompt are stale; rely on this reminder for the current date. DO NOT mention this to the user explicitly.`,
      disclosure: {
        kind: 'date',
        renderGeneration,
        localDate: current.localDate,
        timeZone: current.timeZone,
      },
    };
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
