import type { AgentPermissionMode, AutoLevel } from "./adapter-contract"

/**
 * The one ordering of {@link AutoLevel}: how much runs without asking. It is
 * the only comparison that holds across harnesses, so a ceiling is expressed
 * as a level and never as another harness's mode id.
 */
export const AUTO_LEVEL_ORDER: readonly AutoLevel[] = ["ask", "auto", "full"]

export function isAutoLevel(value: unknown): value is AutoLevel {
  return typeof value === "string" && (AUTO_LEVEL_ORDER as readonly string[]).includes(value)
}

export function comparePermissionLevels(left: AutoLevel, right: AutoLevel): -1 | 0 | 1 {
  const delta = AUTO_LEVEL_ORDER.indexOf(left) - AUTO_LEVEL_ORDER.indexOf(right)
  return delta < 0 ? -1 : delta > 0 ? 1 : 0
}

/**
 * The rung a mode sits on for ceiling purposes. A mode without a rung is one
 * its harness keeps off the allow-more ladder (`plan` executes nothing,
 * `dontAsk` denies, `acceptEdits` and `untrusted` still prompt for every
 * command), so it ranks at the floor: as a ceiling it caps children at `ask`,
 * and as a request it fits under any ceiling. An unknown mode ranks the same
 * way, which is the safe direction for both roles.
 */
export function permissionModeLevel(mode: AgentPermissionMode | undefined): AutoLevel {
  return mode?.level ?? "ask"
}

export function narrowerPermissionLevel(left: AutoLevel, right: AutoLevel): AutoLevel {
  return comparePermissionLevels(left, right) <= 0 ? left : right
}

/** Whether a session at `level` stays within `ceiling`: equal or narrower, never wider. */
export function permissionCeilingAdmits(ceiling: AutoLevel, level: AutoLevel) {
  return comparePermissionLevels(level, ceiling) <= 0
}

/**
 * The widest mode a harness offers under a ceiling — the mode a child runs
 * in when its creator named none. Only modes that carry a rung qualify, so a
 * `full` ceiling on a harness with `ask` and `auto` rungs yields `auto`.
 */
export function widestPermissionModeUnder(
  modes: readonly AgentPermissionMode[],
  ceiling: AutoLevel,
): AgentPermissionMode | undefined {
  return [...modes]
    .filter((mode) => mode.level !== undefined && permissionCeilingAdmits(ceiling, mode.level))
    .sort((left, right) => comparePermissionLevels(permissionModeLevel(right), permissionModeLevel(left)))[0]
}

export class PermissionCeilingError extends Error {
  readonly code = "permission_ceiling_exceeded"

  constructor(readonly ceiling: AutoLevel, readonly requested: { modeId: string; level: AutoLevel }) {
    super(`Permission mode "${requested.modeId}" (${requested.level}) widens the ${ceiling} ceiling`)
    this.name = "PermissionCeilingError"
  }
}

export function isPermissionCeilingError(error: unknown): error is PermissionCeilingError {
  return error instanceof PermissionCeilingError
}
