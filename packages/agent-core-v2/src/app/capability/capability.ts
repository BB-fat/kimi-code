/**
 * `capability` domain (L3) — `ICapabilityService` contract.
 *
 * Manages the built-in product capabilities (`kimi-cu`, `kimi-webbridge`):
 * layered readiness detection and idempotent install orchestration. Entries
 * are hardcoded in a closed registry — install sources are fixed official
 * CDN URLs, never client-supplied.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { CapabilityStatus } from './types';

export interface ICapabilityService {
  readonly _serviceBrand: undefined;

  /** Detect every registered entry (unsupported entries included, marked). */
  listCapabilities(): Promise<readonly CapabilityStatus[]>;

  /**
   * Detect one entry. Throws `capability.not_found` (Error2) for an id that
   * is not in the registry.
   */
  getCapability(id: string): Promise<CapabilityStatus>;

  /**
   * Start an idempotent install in the background and return the current
   * status (with `install.running === true`); clients poll `getCapability`
   * for progress. Throws `capability.not_found`, `capability.unsupported`
   * (wrong platform), or `capability.install_in_progress`.
   */
  installCapability(id: string): Promise<CapabilityStatus>;
}

export const ICapabilityService: ServiceIdentifier<ICapabilityService> =
  createDecorator<ICapabilityService>('capabilityService');
