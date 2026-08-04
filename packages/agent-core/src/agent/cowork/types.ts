/**
 * Cowork domain types — the machine-readable state behind `.cowork/`.
 *
 * `state.json` (this file's shapes) is the single source of truth;
 * `MISSIONS.md` and `missions/*.md` are generated human views and must never
 * be edited by hand. All writes go through `CoworkStore`.
 */

export type CoworkAgentKind = 'worker' | 'reviewer';

export interface CoworkRosterEntry {
  /** Display/route name, e.g. `agent-build`, `reviewer-a`. Unique per workspace. */
  readonly name: string;
  /** Engine agent id (e.g. `agent-3`); the tower is always `main`. */
  readonly agentId: string;
  readonly kind: CoworkAgentKind;
  /** Workers: the mission they own. */
  readonly missionId?: string;
  /** Reviewers: the branch they are assigned to review. */
  readonly reviewTarget?: string;
  /** Workers: worktree slot, e.g. `wt-1`. */
  readonly worktree?: string;
  /** Workers: their branch, e.g. `feat/vulkan-build`. */
  readonly branch?: string;
  readonly spawnedAt: string;
}

export interface CoworkRoster {
  readonly agents: CoworkRosterEntry[];
}

export type CoworkMissionStatus =
  | 'planned'
  | 'active'
  | 'completed'
  | 'blocked'
  | 'paused'
  | 'merged';

/**
 * `build` missions change code: their scope reserves write access (plan-time
 * disjoint check, merge-time containment) and they merge through the full
 * review gate. `survey` missions are read-only investigations: their scope is
 * informational only (reserves nothing), and their merge is a zero-diff
 * formality that closes the mission without a git merge.
 */
export type CoworkMissionKind = 'build' | 'survey';

export interface CoworkMissionTask {
  text: string;
  done: boolean;
}

export interface CoworkMission {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  kind: CoworkMissionKind;
  /** picomatch globs; mutable only through `updateMission` (tower, logged). */
  scope: string[];
  readonly branch: string;
  readonly worktree: string;
  readonly deps: readonly string[];
  status: CoworkMissionStatus;
  owner?: string;
  tasks: CoworkMissionTask[];
  /** Decision log, oldest first. */
  notes: string[];
  blockers: string[];
}

export interface CoworkState {
  readonly version: 1;
  readonly base: string;
  /** `pr` is reserved for a future gh-backed mode; v1 always runs `branch`. */
  readonly mode: 'branch' | 'pr';
  readonly createdAt: string;
  roster: CoworkRoster;
  missions: CoworkMission[];
}

export type CoworkFindingType = 'bug' | 'improve' | 'vuln' | 'idea';
export type CoworkFindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export type CoworkReviewStatus = 'clean' | `p1-${number}items` | `p2-${number}items`;
export type CoworkReviewMerge = 'merge' | 'fix-then-merge' | 'hold';

export interface CoworkReviewInfo {
  readonly reviewer: string;
  readonly target: string;
  readonly round: number;
  readonly status: string;
  readonly merge: string;
  /** Branch tip the review was written against; merge gate compares it. */
  readonly reviewedCommit: string;
  readonly date: string;
  readonly file: string;
}

export interface CoworkInboxItem {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly sentAt: string;
  readonly scope?: string;
  readonly action?: string;
  readonly consentRef?: string;
  readonly body: string;
}
