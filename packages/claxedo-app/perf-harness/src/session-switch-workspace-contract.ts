import { HEAVY_WORKSPACE_FILE_LINES } from "./heavy-workspace-reopen-contract"

/**
 * Contract for the `session-switch-workspace` scenario: session switching
 * measured as isolated interactions across the matrix
 * {within-workspace, across-workspace} x {cold, warm} x workspace
 * {closed, open-on-substantial-file, open-on-large-review}.
 *
 * Same-workspace switches gate HARD on workspace stability: the open
 * workspace must be a bystander (no remount, no VCS/file/workspace refetch,
 * no review recomputation). Cross-workspace switches run four independent
 * clocks off one click. Session readiness is always measured independently of
 * workspace content readiness.
 */

// Matrix axes, used for metric naming and penalty derivation.
export const SESSION_SWITCH_SCOPES = ["within", "across"] as const
export const SESSION_SWITCH_TEMPERATURES = ["cold", "warm"] as const
export const SESSION_SWITCH_BLOCKS = ["closed", "open_file", "open_review"] as const

export type SessionSwitchScope = (typeof SESSION_SWITCH_SCOPES)[number]
export type SessionSwitchTemperature = (typeof SESSION_SWITCH_TEMPERATURES)[number]
export type SessionSwitchBlock = (typeof SESSION_SWITCH_BLOCKS)[number]

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
 * counted but reported rather than gated: the mock's held streams re-resolve
 * on their own 25s cadence, so a wall-clock switch window can legitimately
 * contain a background reconnect on a slow host.
 */
export type StabilityRequestClass = "vcs" | "file" | "workspace" | "sse"

export function stabilityRequestClass(pathName: string): StabilityRequestClass | undefined {
  if (
    pathName === "/event" ||
    pathName === "/global/event" ||
    pathName.endsWith("/api/wr/events") ||
    pathName.endsWith("/api/wr/runtime-events")
  ) {
    return "sse"
  }
  if (pathName.includes("/diff/") || pathName === "/vcs" || pathName.startsWith("/vcs/")) return "vcs"
  if (pathName.startsWith("/file") || pathName === "/find/file") return "file"
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

export type SameWorkspaceStabilityObservation = {
  /** identity token stamped on the shell element survived the switch. */
  shellTokenPreserved?: boolean
  /** identity token stamped on the visible workspace content root survived. */
  contentTokenPreserved?: boolean
  /** mock-counted request deltas across the switch. */
  requestDelta: StabilityRequestCounts
  /** data-review-rendered-files attribute writes during the switch (open-review block only). */
  reviewRenderedFilesChurn?: number
}

/**
 * Hard stability gate for same-workspace switches. Token checks apply only
 * when the workspace surface was open (undefined = surface not present, e.g.
 * the closed block). SSE reconnects stay report-only (see above).
 */
export function sameWorkspaceSwitchStabilityFailures(
  cell: string,
  observation: SameWorkspaceStabilityObservation,
) {
  const failures: string[] = []
  if (observation.shellTokenPreserved === false) {
    failures.push(`${cell} remounted the workspace panel shell (element identity token lost)`)
  }
  if (observation.contentTokenPreserved === false) {
    failures.push(`${cell} remounted the open workspace content (element identity token lost)`)
  }
  for (const kind of ["vcs", "file", "workspace"] as const) {
    if (observation.requestDelta[kind] > 0) {
      failures.push(`${cell} issued ${observation.requestDelta[kind]} ${kind} requests; expected 0 for a same-workspace switch`)
    }
  }
  if ((observation.reviewRenderedFilesChurn ?? 0) > 0) {
    failures.push(
      `${cell} recomputed the review (${observation.reviewRenderedFilesChurn} data-review-rendered-files writes); expected 0`,
    )
  }
  return failures
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
 * is the ordering one in `crossWorkspaceSwitchClockFailures`; this backstop
 * only catches a release that waits on the destination's construction.
 */
export const OLD_WORKSPACE_RELEASE_BUDGET_MS = 250

export type CrossWorkspaceSwitchObservation = {
  /** destination session above-fold ready (independent of the workspace). */
  sessionReadyMs?: number
  /** old workspace surface disposed, or retained and provably inert. */
  oldWorkspaceReleasedMs?: number
  /** which of the two outcomes released it. */
  oldWorkspaceRelease?: OldWorkspaceRelease
  /** destination workspace above-fold ready. */
  destinationWorkspaceReadyMs?: number
  timedOut: boolean
}

/**
 * Cross-workspace switches must resolve all their independent clocks (the
 * fourth clock — shell responsiveness — is the interaction's own renderer
 * interval distribution and is gated by the harness's frame gate, not here).
 *
 * The old surface's release is gated by ORDER, not by a stopwatch: it must land
 * no later than the frame that makes the destination workspace the user's
 * surface. Both clocks come off the same in-page tick loop, so the comparison
 * is immune to how late that loop's first frame lands — and it is the
 * invariant that actually matters. Presenting the destination while the
 * workspace the user left is still reachable and still rendering is the defect,
 * whether the panel got there by holding a disposal or by holding a flip.
 */
export function crossWorkspaceSwitchClockFailures(cell: string, observation: CrossWorkspaceSwitchObservation) {
  const failures: string[] = []
  if (observation.sessionReadyMs === undefined) failures.push(`${cell} destination session never became ready`)
  if (observation.destinationWorkspaceReadyMs === undefined) {
    failures.push(`${cell} destination workspace never rendered above-fold content`)
  }
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
