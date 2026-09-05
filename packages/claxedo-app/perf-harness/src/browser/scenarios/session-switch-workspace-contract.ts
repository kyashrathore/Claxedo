import { HEAVY_WORKSPACE_FILE_LINES } from "./heavy-workspace-reopen-contract"
import { workspaceFileResourcePath } from "../workspace-file-path"
import { mockStreamKind } from "../mock-streams"

/**
 * Contract for the `session-switch-workspace` scenario: session switching
 * measured as isolated interactions across the matrix
 * {within-workspace, across-workspace} x {cold, warm} x workspace
 * {closed, open-on-substantial-file, open-on-large-review}.
 *
 * Cold cells leave home for a first-visit session, which canonically starts
 * with its panel closed. Warm cells return to home's saved closed/file/review
 * presentation. Source disposal and destination restoration are separate
 * clocks; within-workspace reads must reuse their already-loaded caches.
 */

// Matrix axes, used for metric naming and penalty derivation.
export const SESSION_SWITCH_SCOPES = ["within", "across"] as const
export const SESSION_SWITCH_TEMPERATURES = ["cold", "warm"] as const
export const SESSION_SWITCH_BLOCKS = ["closed", "open_file", "open_review"] as const

export type SessionSwitchScope = (typeof SESSION_SWITCH_SCOPES)[number]
export type SessionSwitchTemperature = (typeof SESSION_SWITCH_TEMPERATURES)[number]
export type SessionSwitchBlock = (typeof SESSION_SWITCH_BLOCKS)[number]

export type SessionSwitchPanelPresentation = "closed" | "file" | "review"
export type SessionSwitchPanelTransition = {
  source: SessionSwitchPanelPresentation
  destination: SessionSwitchPanelPresentation
}

/** The per-session snapshot owner closes first visits and restores warm home. */
export function sessionSwitchPanelTransition(
  block: SessionSwitchBlock,
  temperature: SessionSwitchTemperature,
): SessionSwitchPanelTransition {
  const home = block === "closed" ? "closed" : block === "open_file" ? "file" : "review"
  return temperature === "cold"
    ? { source: home, destination: "closed" }
    : { source: "closed", destination: home }
}

export function sessionSwitchCellPrefix(
  block: SessionSwitchBlock,
  scope: SessionSwitchScope,
  temperature: SessionSwitchTemperature,
) {
  return `session_switch_${block}_${scope}_${temperature}`
}

// The substantial file the open-on-substantial-file block keeps active,
// weighted like the heavy-workspace working-set files.
export const SESSION_SWITCH_SUBSTANTIAL_FILE_PATH = "src/generated/file-7.ts"
export const SESSION_SWITCH_SUBSTANTIAL_FILE_LINES = HEAVY_WORKSPACE_FILE_LINES

/**
 * Mock-authoritative request classes for the same-workspace stability gate.
 * Counted by the route-level mock (the producer of every response), so a
 * refetch cannot hide from a PerformanceObserver window. `sse` reconnects are
 * counted but reported rather than gated: session-scoped streams legitimately
 * change subscriptions when the user switches sessions. The fixture transport
 * stays open until that consumer or its owning page closes it.
 */
export type StabilityRequestClass = "vcs" | "file" | "workspace" | "sse"

export function stabilityRequestClass(pathName: string): StabilityRequestClass | undefined {
  if (mockStreamKind(pathName)) return "sse"
  if (pathName.includes("/diff/") || pathName === "/vcs" || pathName.startsWith("/vcs/")) return "vcs"
  if (workspaceFileResourcePath(pathName)) return "file"
  if (
    pathName === "/api/workspace" ||
    pathName.startsWith("/api/workspace/") ||
    pathName.endsWith("/workspace/resolve") ||
    pathName === "/worktree"
  ) {
    return "workspace"
  }
  return undefined
}

export type StabilityRequestCounts = Record<StabilityRequestClass, number>

/** Same-workspace transitions reuse loaded VCS, file, and workspace data.
 * DOM disposal/restoration is intentional when session presentation changes.
 */
export function sameWorkspaceSwitchStabilityFailures(
  cell: string,
  requestDelta: StabilityRequestCounts,
) {
  return (["vcs", "file", "workspace"] as const)
    .filter((kind) => requestDelta[kind] > 0)
    .map((kind) => `${cell} issued ${requestDelta[kind]} ${kind} requests; expected 0 for a same-workspace switch`)
}

/**
 * How the outgoing workspace surface may stop being the user's surface.
 *
 * `disposed` is the original outcome: the panel tore the old body down and its
 * root left the document. `retained-inert` is the outcome the panel body LRU
 * introduces (workspace-panel.tsx): the old body stays constructed so a return
 * switch is a display flip instead of a reconstruction, and is instead PROVED
 * harmless — marked with `RETAINED_PANEL_BODY_INERT_ATTRIBUTE`, `aria-hidden`,
 * and computed `content-visibility: hidden`, so it renders nothing, paints
 * nothing, hit-tests nothing and is absent from the accessibility tree.
 *
 * This is the same evolution the Review surface already went through inside an
 * open panel (heavyWorkspaceInactiveReviewOwnershipFailures): the gate is no
 * longer "the old DOM is gone" but "the old DOM is gone OR provably inert".
 * The CLOSED panel's zero-DOM contract is untouched and still absolute.
 */
export type OldWorkspaceRelease = "disposed" | "retained-inert"

/** Host element the panel wraps each retained body in. Owned here so the driver, the probe and the gate cannot disagree on it. */
export const RETAINED_PANEL_BODY_HOST_SELECTOR = "[data-testid='workspace-panel-body']"
/** Marker the panel stamps on a retained body host that is NOT the displayed one. */
export const RETAINED_PANEL_BODY_INERT_ATTRIBUTE = "data-panel-body-inert"

/**
 * Coarse backstop on how long the outgoing workspace surface may remain the
 * user's surface. It is deliberately loose, because this clock cannot be
 * tighter than the interaction's own first observable frame: both releases — a
 * disposal and a display-lock flip — are decided inside the click's update
 * flush, and what the number records is the first animation frame that could
 * SEE that, which the click task itself pushes out (measured floor across
 * builds and machine load: 40-115 ms). The gate that carries the real meaning
 * is the ordering one in `sessionSwitchClockFailures`; this backstop
 * only catches a release that waits on the destination's construction.
 */
export const OLD_WORKSPACE_RELEASE_BUDGET_MS = 250

export type SessionSwitchClockObservation = {
  /** destination session above-fold ready (independent of the workspace). */
  sessionReadyMs?: number
  /** old workspace surface disposed, or retained and provably inert. */
  oldWorkspaceReleasedMs?: number
  /** which of the two outcomes released it. */
  oldWorkspaceRelease?: OldWorkspaceRelease
  /** destination workspace above-fold ready. */
  destinationWorkspaceReadyMs?: number
  /** First-visit destination proved its panel closed. */
  destinationPanelClosedMs?: number
  timedOut: boolean
}

/** Require only the clocks owned by the actual source/destination surfaces.
 * A visible destination cannot precede release of an outgoing open surface.
 * First-visit closure may precede final disposal during the normal close grace.
 */
export function sessionSwitchClockFailures(
  cell: string,
  transition: SessionSwitchPanelTransition,
  observation: SessionSwitchClockObservation,
) {
  const failures: string[] = []
  if (observation.sessionReadyMs === undefined) failures.push(`${cell} destination session never became ready`)
  if (transition.destination === "closed") {
    if (observation.destinationPanelClosedMs === undefined) failures.push(`${cell} destination session did not keep its workspace panel closed`)
  } else if (observation.destinationWorkspaceReadyMs === undefined) {
    failures.push(`${cell} destination workspace never restored its saved ${transition.destination} content`)
  }
  if (transition.source === "closed") return failures
  const released = observation.oldWorkspaceReleasedMs
  if (released === undefined) {
    failures.push(`${cell} old workspace surface was neither disposed nor made inert`)
    return failures
  }
  const outcome = observation.oldWorkspaceRelease ?? "unknown"
  if (released > OLD_WORKSPACE_RELEASE_BUDGET_MS) {
    failures.push(
      `${cell} released the old workspace surface after ${roundReleaseMs(released)}ms (${outcome});` +
        ` backstop ${OLD_WORKSPACE_RELEASE_BUDGET_MS}ms`,
    )
  }
  if (
    observation.destinationWorkspaceReadyMs !== undefined &&
    released > observation.destinationWorkspaceReadyMs
  ) {
    failures.push(
      `${cell} presented the destination workspace at ${roundReleaseMs(observation.destinationWorkspaceReadyMs)}ms` +
        ` while the old workspace surface was still the user's (released ${roundReleaseMs(released)}ms, ${outcome})`,
    )
  }
  return failures
}

function roundReleaseMs(value: number) {
  return Math.round(value * 100) / 100
}

/**
 * The workspace-open penalty: open-workspace session-switch latency minus the
 * closed-workspace latency for the same {scope, temperature} cell. Positive
 * means having the workspace open costs the user that much per switch.
 */
export function workspaceOpenPenaltyMs(input: { openMs: number; closedMs: number }) {
  return Math.round((input.openMs - input.closedMs) * 100) / 100
}

export function sessionSwitchPenaltyMetricName(
  block: Exclude<SessionSwitchBlock, "closed">,
  scope: SessionSwitchScope,
  temperature: SessionSwitchTemperature,
) {
  return `session_switch_penalty_${block}_${scope}_${temperature}_ms`
}
