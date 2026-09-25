import type { HarnessId } from "./mechanisms"
import {
  harnessPermissionLabel,
  permissionMechanism,
} from "./mechanisms"

/** Picker options come from the runtime report; local auto-answer is a separate preference. */

/** Runtime mode selection. Retired local selections are accepted only as stale input
 * and rejected by findPermissionModeOption, even when a harness reuses the id. */
export type PermissionSelection =
  | { kind: "claxedo"; modeId: string }
  | { kind: "harness"; modeId: string }

/** The concrete call Claxedo makes for a given option. */
export type PermissionModeDelivery = {
  kind: "harness-permission-mode"
  modeId: string
  appliesFrom: "next-turn" | "next-session"
}

export type PermissionModeOption = {
  id: string
  name: string
  description?: string
  origin: "harness"
  /** A condition the user must know about, shown alongside the option. */
  caveat?: string
  /** How this option reaches the harness. Drives the per-item info. */
  delivery: PermissionModeDelivery
}

/**
 * Native Pi has real machine access but no selectable approval policy.
 */
export const NATIVE_NO_POLICY_REASON =
  "Pi does not expose a permission mode. Its tools run with the permissions of the selected Local machine or Cloud sandbox."

/**
 * What the harness itself reported, as served by the runtime.
 *
 * Structurally the runtime's `AgentPermissionModeState`, redeclared so this
 * module does not depend on the runtime package — see the wire-shape note on
 * `AgentRuntimePermissionModeState`.
 */
export type HarnessModeReport = {
  modes: readonly { id: string; name: string; description?: string; level?: "ask" | "auto" | "full" }[]
  currentModeId?: string
  unsupported?: string
  appliesFrom: "next-turn" | "next-session"
}

export type HarnessPermissionModes = {
  modes: readonly PermissionModeOption[]
  /** Set when `modes` is empty: why this harness offers nothing to pick. */
  unavailable?: string
  /** The report is still in flight; `unavailable` is provisional, not an answer. */
  loading?: boolean
}

/**
 * The harness's own modes, converted for display.
 *
 * Every field the user sees comes from `report`. Nothing here consults
 * `HarnessId` to decide what a mode does, on purpose: a static table of what
 * each SDK supports drifts from what the installed packages actually do. The
 * runtime reads the packages; this renders what it says.
 */
export function harnessPermissionModes(input: {
  harness: HarnessId
  report?: HarnessModeReport
  /** See `permissionModeOptions`. Suppresses next-session caveats on a draft. */
  hasSession?: boolean
}): HarnessPermissionModes {
  const label = harnessPermissionLabel(input.harness)
  const report = input.report

  // Checked first, ahead of the loading and empty-report branches, because
  // neither is true here: this harness is not slow to answer and has not merely
  // failed to report — it has no policy surface. Saying "has not
  // reported any permission modes" would imply it might later.
  if (permissionMechanism(input.harness).kind === "native-no-policy") {
    return { modes: [], unavailable: NATIVE_NO_POLICY_REASON }
  }

  // Not yet fetched. Genuinely transient, and distinct from every case below.
  if (!report) return { modes: [], unavailable: `Loading ${label}'s permission modes…`, loading: true }

  if (report.unsupported) return { modes: [], unavailable: report.unsupported }

  // A 200 whose body is not actually a mode report — a proxy error page, a
  // server mid-deploy, a mis-scoped route — must degrade to "unavailable" here.
  // `readJson` does no shape validation, so without this guard the `.length`
  // below throws during the composer's render, and a render-time throw takes
  // the whole app shell into the ErrorBoundary: the user gets a blank "Something
  // went wrong" page instead of one control that could not load.
  if (!Array.isArray(report.modes)) {
    return { modes: [], unavailable: `${label} returned an unreadable permission-mode report` }
  }

  if (report.modes.length === 0) {
    return { modes: [], unavailable: `${label} has not reported any permission modes for this session` }
  }

  return {
    modes: report.modes.map((mode) => ({
      id: mode.id,
      // The harness's own name and description, unchanged.
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
      origin: "harness" as const,
      // Suppressed on a draft: there is no "this session" for the change to be
      // excluded from, and the first message will run under this mode regardless.
      ...(report.appliesFrom === "next-session" && input.hasSession !== false
        ? { caveat: `Applies to the next ${label} agent, not this session` }
        : {}),
      delivery: {
        kind: "harness-permission-mode" as const,
        modeId: mode.id,
        appliesFrom: report.appliesFrom,
      },
    })),
  }
}

/** Only the runtime-reported list is a picker authority. */
export function permissionModeOptions(input: {
  harness: HarnessId
  report?: HarnessModeReport
  /**
   * Whether a session actually exists yet.
   *
   * Only `next-session` caveats care, and they care a lot: "applies to the next
   * agent, not this session" is meaningless on a draft, where there is no this
   * session to be excluded from. The first message creates the session and picks
   * the mode up, so on a draft the choice is simply in force.
   */
  hasSession?: boolean
}): { harness: HarnessPermissionModes } {
  return { harness: harnessPermissionModes(input) }
}

/**
 * The mode to start on when the user has chosen nothing.
 *
 * Prefers what the harness says is current — it is the truth about the session,
 * and on a resumed session it is the mode already in force. Only when the harness
 * reports no current mode does this choose its `auto` rung or first option.
 * Without reported modes there is no default to invent.
 */
export function defaultPermissionSelection(input: {
  harness: HarnessId
  report?: HarnessModeReport
}): PermissionSelection | undefined {
  const report = input.report
  // `Array.isArray` for the same reason as `harnessPermissionModes` above: this
  // runs inside the composer's `selection` memo, so an unreadable report would
  // throw during render and take the whole shell into the ErrorBoundary rather
  // than degrading this one control.
  if (report && Array.isArray(report.modes) && report.modes.length > 0) {
    const current = report.currentModeId
      ? report.modes.find((mode) => mode.id === report.currentModeId)
      : undefined
    const chosen = current ?? report.modes.find((mode) => mode.level === "auto") ?? report.modes[0]!
    // Always the harness's own id, including for the auto rung: there is no
    // separate Claxedo row standing in front of the list for it to point at,
    // so naming the rung anything but the harness's own word for it would name
    // a row the picker does not contain.
    return { kind: "harness", modeId: chosen.id }
  }
  return undefined
}

/** Resolve a selection to the option it refers to, or undefined if it is stale. */
export function findPermissionModeOption(input: {
  selection: PermissionSelection
  harness: HarnessId
  report?: HarnessModeReport
}): PermissionModeOption | undefined {
  const selection = input.selection
  // Bound to a local before the callback: TypeScript discards narrowing on a
  // property access once it is read inside a closure.
  const modeId = selection.modeId
  if (selection.kind !== "harness") return undefined
  return harnessPermissionModes(input).modes.find((mode) => mode.id === modeId)
}
