import type { FlowResult } from "../../flows"
import { type FrameMetric, mergeFrameMetrics } from "../../frame-sampler"
import {
  type IsolatedInteractionObservation,
  ISOLATED_INTERACTION_TIMEOUT_MS,
  measurement,
  settleBeforeNextInteraction,
  prepareTrustedInteraction,
  measureIsolatedInteraction,
  isolatedInteractionMetricRows,
  isolatedInteractionEvidenceFailures,
  isolatedInteractionSettleFailures,
} from "../../isolated-interaction"
import {
  type OldWorkspaceRelease,
  type SessionSwitchBlock,
  type SessionSwitchScope,
  type SessionSwitchTemperature,
  sessionSwitchCellPrefix,
  RETAINED_PANEL_BODY_HOST_SELECTOR,
  RETAINED_PANEL_BODY_INERT_ATTRIBUTE,
  sessionSwitchClockFailures,
  sessionSwitchPanelTransition,
  type SessionSwitchPanelTransition,
  type SessionSwitchPanelPresentation,
  type SessionSwitchClockObservation,
  type StabilityRequestCounts,
  sameWorkspaceSwitchStabilityFailures,
  SESSION_SWITCH_SUBSTANTIAL_FILE_PATH,
  SESSION_SWITCH_SUBSTANTIAL_FILE_LINES,
  SESSION_SWITCH_SCOPES,
  SESSION_SWITCH_TEMPERATURES,
  sessionSwitchPenaltyMetricName,
  workspaceOpenPenaltyMs,
} from "./session-switch-workspace-contract"
import type { Measurement } from "../../types"
import { launchTo, waitForAnimationFrame, roundMs, recordVisualFailure } from "../actions/common"
import { openFirstReviewDiff, waitForReviewStable } from "../actions/review"
import { waitForTranscript, showSessionInventory } from "../actions/session"
import {
  syntheticVisibleClick,
  WORKSPACE_PANEL_TOGGLE_SELECTOR,
  waitForWorkspaceReviewContent,
  measureWorkspaceFiles,
  openWorkspaceFileTab,
} from "../actions/workspace"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import type { Page } from "playwright-core"

type SessionSwitchObservation = IsolatedInteractionObservation & SessionSwitchClockObservation

// One physical click, independent clocks for the destination session, any
// outgoing open surface, and the destination's saved panel presentation.
const observeSessionSwitch = async (params: {
  mark: string
  timeoutMs: number
  sessionId: string
  newDirectory: string
  transition: SessionSwitchPanelTransition
  expectedFilePath: string
  expectedFileLines: number
  expectedTotal: number
  /** RETAINED_PANEL_BODY_HOST_SELECTOR — the contract owns the marker names. */
  bodyHostSelector: string
  /** RETAINED_PANEL_BODY_INERT_ATTRIBUTE. */
  bodyInertAttribute: string
}): Promise<SessionSwitchObservation> => {
  const started = performance.getEntriesByName(params.mark, "mark").at(-1)?.startTime
  if (started === undefined) throw new Error(`Trusted session switch did not emit pointerdown for ${params.sessionId}`)
  const visible = (element: Element) => {
    if (element.closest("[aria-hidden='true']")) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const root = () =>
    document.querySelector<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(params.sessionId)}"]`)
  const sessionReady = () => {
    const target = root()
    if (!target || target.closest("[aria-hidden='true']")) return false
    if (target.dataset.sessionFirstFoldReady !== "true" || target.dataset.sessionMessagesReady !== "true") return false
    if (Number(target.dataset.sessionMessageCount ?? target.dataset.sessionConversationCount ?? "0") <= 0) return false
    const timeline = target.querySelector<HTMLElement>("[data-session-timeline-root]")
    if (!timeline || timeline.dataset.sessionTimelineRevealReady !== "true") return false
    if (timeline.dataset.sessionTimelineProgressiveReady !== "true") return false
    if (getComputedStyle(timeline).visibility === "hidden") return false
    if (Number(timeline.dataset.sessionTimelineKeyCount ?? "0") <= 0) return false
    return Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]"))
      .some((row) => (row.textContent ?? "").trim())
  }
  const shell = () => document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
  const oldContent = window.__claxedoPerfOldPanelContent
  // The old surface stops being the user's surface either by leaving the
  // document, or by being retained under a body host the panel has PROVED
  // inert: marked not-displayed, hidden from the accessibility tree, and
  // skipped for rendering. Anything less (still marked displayed, still
  // reachable, still rendering) is not a release. Mirrors the retained-Review
  // reader used by the heavy-workspace inactive-ownership gate.
  const readOldWorkspaceRelease = (): OldWorkspaceRelease | undefined => {
    if (!oldContent) return undefined
    if (!oldContent.isConnected) return "disposed"
    const host = oldContent.closest<HTMLElement>(params.bodyHostSelector)
    if (!host) return undefined
    const inert = host.getAttribute(params.bodyInertAttribute) === "true" &&
      host.getAttribute("aria-hidden") === "true" &&
      getComputedStyle(host).contentVisibility === "hidden"
    return inert ? "retained-inert" : undefined
  }
  const destinationReady = () => {
    const current = shell()
    if (!current || current.dataset.open !== "true" || !visible(current)) return false
    const dir = current.dataset.stateWorkspaceDir ?? ""
    if (!dir.includes(params.newDirectory)) return false
    const activeTab = current.querySelector<HTMLElement>("[data-slot='workspace-tab'][data-selected='true']")
    if (params.transition.destination === "file") {
      if (activeTab?.dataset.workspaceTabId !== `file://${params.expectedFilePath}`) return false
      return Array.from(current.querySelectorAll<HTMLElement>("[data-testid='tab-file-root'][data-tab-file-state='ready']"))
        .some((file) => visible(file) && file.dataset.tabFilePath === params.expectedFilePath &&
          Number(file.dataset.tabFileContentLines ?? "0") === params.expectedFileLines &&
          Number(file.dataset.tabFileContentChars ?? "0") > 0)
    }
    if (activeTab?.dataset.workspaceTabKind !== "review") return false
    const reviewRoot = Array.from(current.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const corpus = reviewRoot?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    return !!corpus && Number(corpus.dataset.reviewTotalFiles ?? "0") === params.expectedTotal &&
      Array.from(reviewRoot!.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)
  }
  const destinationClosed = () => {
    const current = shell()
    return !current || (current.dataset.open === "false" &&
      (current.getAttribute("aria-hidden") === "true" || getComputedStyle(current).display === "none"))
  }

  let acknowledgedMs: number | undefined
  let sessionReadyMs: number | undefined
  let oldWorkspaceReleasedMs: number | undefined
  let oldWorkspaceRelease: OldWorkspaceRelease | undefined
  let destinationWorkspaceReadyMs: number | undefined
  let destinationPanelClosedMs: number | undefined
  let stableFrames = 0
  const completionMs = await new Promise<number>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started
      if (acknowledgedMs === undefined && root()) acknowledgedMs = elapsed
      const currentSessionReady = sessionReady()
      if (sessionReadyMs === undefined && currentSessionReady) sessionReadyMs = elapsed
      if (params.transition.source !== "closed" && oldWorkspaceReleasedMs === undefined) {
        const release = readOldWorkspaceRelease()
        if (release) {
          oldWorkspaceRelease = release
          oldWorkspaceReleasedMs = elapsed
        }
      }
      const currentPanelReady = params.transition.destination === "closed" ? destinationClosed() : destinationReady()
      if (params.transition.destination === "closed") {
        if (destinationPanelClosedMs === undefined && currentPanelReady) destinationPanelClosedMs = elapsed
      } else if (destinationWorkspaceReadyMs === undefined && currentPanelReady) destinationWorkspaceReadyMs = elapsed
      const done = currentSessionReady && currentPanelReady &&
        (params.transition.source === "closed" || oldWorkspaceReleasedMs !== undefined) &&
        (params.transition.destination === "closed" ? destinationPanelClosedMs !== undefined : destinationWorkspaceReadyMs !== undefined)
      stableFrames = done ? stableFrames + 1 : 0
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  performance.clearMarks(params.mark)
  delete window.__claxedoPerfOldPanelContent
  return {
    completionMs,
    acknowledgedMs,
    timedOut: completionMs >= params.timeoutMs,
    sessionReadyMs,
    oldWorkspaceReleasedMs,
    oldWorkspaceRelease,
    destinationWorkspaceReadyMs,
    destinationPanelClosedMs,
  }
}

const SESSION_SWITCH_PANEL_CONTENT_SELECTOR = "[data-testid='review-pane-root']"

export async function sessionSwitchWorkspace(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const sessions = fixture.sessions
  const home = sessions[0]
  await launchTo(page, app, sessionPath(home, home.id))
  await waitForTranscript(page, fixture, home.id, home.title)
  await showSessionInventory(page, fixture, Math.min(sessions.length, 8), { settle: "frame" })
  const expectedTotal = fixture.changedFiles.length
  const timeoutMs = ISOLATED_INTERACTION_TIMEOUT_MS
  const debug: Measurement[] = []
  const metrics: FrameMetric[] = []
  const completions = new Map<string, number>()
  const settleStabilityRequestStarts = async (label: string) => {
    const started = performance.now()
    let quietStarted = started
    let previous = { ...fixture.requestCounts.stability }
    // Boot and workspace setup intentionally start the authoritative workspace
    // resolve/VCS/file queries. Do not charge a query whose request begins
    // after the surface is visually ready to the first session click. Use
    // elapsed time rather than a frame count: headless Chromium can deliver
    // rAF callbacks much faster than a physical display. The 300ms quiet
    // interval covers the file-status debounce after opening the substantial
    // file without entering any measured interaction window.
    while (performance.now() - quietStarted < 300 && performance.now() - started < 2_000) {
      await waitForAnimationFrame(page, 1)
      const current = fixture.requestCounts.stability
      const changed = current.vcs !== previous.vcs ||
        current.file !== previous.file ||
        current.workspace !== previous.workspace
      if (changed) quietStarted = performance.now()
      previous = { ...current }
    }
    debug.push(
      measurement(`${label}_request_quiet_gate_ms`, roundMs(performance.now() - started)),
      measurement(
        `${label}_request_quiet_gate_settled`,
        performance.now() - quietStarted >= 300 ? 1 : 0,
        "count",
      ),
    )
  }
  const settleGate = async (label: string) => {
    const gate = await settleBeforeNextInteraction(page)
    debug.push(
      measurement(`${label}_settle_gate_ms`, roundMs(gate.waitedMs)),
      measurement(`${label}_settle_gate_settled`, gate.settled ? 1 : 0, "count"),
    )
  }

  const sessionRowActivate = async (target: (typeof sessions)[number]) => {
    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${target.id}"]`).first()
    if (await row.count()) {
      const activate = row.locator('[data-slot="navigation-row-activate"]').first()
      return (await activate.count()) ? activate : row
    }
    return page.locator("[role='button'], button, a").filter({ hasText: target.title }).first()
  }

  const prepareSourceSurface = async (presentation: SessionSwitchPanelPresentation, cell: string) => {
    await page.evaluate(({ contentSelector, presentation, cell, filePath, fileLines }) => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      if (presentation === "closed") {
        if (shell) throw new Error(`${cell} expected a closed source workspace panel`)
        delete window.__claxedoPerfOldPanelContent
        return
      }
      const activeTab = shell?.querySelector<HTMLElement>("[data-slot='workspace-tab'][data-selected='true']")
      const expectedTab = presentation === "review" ? "review" : `file://${filePath}`
      if (activeTab?.dataset.workspaceTabId !== expectedTab) {
        throw new Error(`${cell} expected source tab ${expectedTab}, observed ${String(activeTab?.dataset.workspaceTabId)}`)
      }
      if (presentation === "file") {
        const file = shell?.querySelector<HTMLElement>(`[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(filePath)}"][data-tab-file-state='ready']`)
        if (Number(file?.dataset.tabFileContentLines ?? "0") !== fileLines) {
          throw new Error(`${cell} source file did not contain ${fileLines} lines`)
        }
      }
      const content = Array.from(shell?.querySelectorAll<HTMLElement>(contentSelector) ?? []).find((element) => {
        if (element.closest("[aria-hidden='true']")) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      })
      if (!content) throw new Error(`${cell} source has no displayed workspace surface`)
      window.__claxedoPerfOldPanelContent = content
    }, { contentSelector: SESSION_SWITCH_PANEL_CONTENT_SELECTOR, presentation, cell,
      filePath: SESSION_SWITCH_SUBSTANTIAL_FILE_PATH, fileLines: SESSION_SWITCH_SUBSTANTIAL_FILE_LINES })
  }

  const runCell = async (input: {
    block: SessionSwitchBlock
    scope: SessionSwitchScope
    temperature: SessionSwitchTemperature
    target: (typeof sessions)[number]
  }) => {
    const cell = sessionSwitchCellPrefix(input.block, input.scope, input.temperature)
    const transition = sessionSwitchPanelTransition(input.block, input.temperature)
    await prepareSourceSurface(transition.source, cell)
    const requestsBefore = { ...fixture.requestCounts.stability }
    const premounted = await page
      .locator(`[data-testid="session-page-root"][data-session-id="${input.target.id}"]`)
      .count()
    const control = await sessionRowActivate(input.target)
    await control.scrollIntoViewIfNeeded().catch(() => undefined)
    const prepared = await prepareTrustedInteraction(page, control, cell)
    const { metric, observation } = await measureIsolatedInteraction<SessionSwitchObservation>(page, cell, async () => {
      await page.mouse.click(prepared.x, prepared.y)
      return await page.evaluate(observeSessionSwitch, {
        mark: prepared.mark,
        timeoutMs,
        sessionId: input.target.id,
        newDirectory: input.target.directory,
        transition,
        expectedTotal,
        expectedFilePath: SESSION_SWITCH_SUBSTANTIAL_FILE_PATH,
        expectedFileLines: SESSION_SWITCH_SUBSTANTIAL_FILE_LINES,
        bodyHostSelector: RETAINED_PANEL_BODY_HOST_SELECTOR,
        bodyInertAttribute: RETAINED_PANEL_BODY_INERT_ATTRIBUTE,
      })
    })
    metrics.push(metric)
    completions.set(`${input.block}:${input.scope}:${input.temperature}`, observation.completionMs)
    debug.push(
      ...isolatedInteractionMetricRows(cell, metric, observation),
      measurement(`${cell}_destination_premounted`, premounted > 0 ? 1 : 0, "count"),
    )
    // Session readiness is measured independently of workspace readiness.
    if (observation.sessionReadyMs !== undefined) {
      debug.push(measurement(`${cell}_session_ready_ms`, roundMs(observation.sessionReadyMs)))
    }
    if (observation.oldWorkspaceReleasedMs !== undefined) {
      debug.push(
        measurement(`${cell}_old_workspace_released_ms`, roundMs(observation.oldWorkspaceReleasedMs)),
        measurement(`${cell}_old_workspace_retained_inert`, observation.oldWorkspaceRelease === "retained-inert" ? 1 : 0, "count"),
      )
    }
    if (observation.destinationWorkspaceReadyMs !== undefined) {
      debug.push(measurement(`${cell}_destination_workspace_ready_ms`, roundMs(observation.destinationWorkspaceReadyMs)))
    }
    if (observation.destinationPanelClosedMs !== undefined) {
      debug.push(measurement(`${cell}_destination_panel_closed_ms`, roundMs(observation.destinationPanelClosedMs)))
    }
    for (const failure of sessionSwitchClockFailures(cell, transition, observation)) recordVisualFailure(fixture, failure)
    await settleGate(cell)
    const requestDelta: StabilityRequestCounts = {
      vcs: fixture.requestCounts.stability.vcs - requestsBefore.vcs,
      file: fixture.requestCounts.stability.file - requestsBefore.file,
      workspace: fixture.requestCounts.stability.workspace - requestsBefore.workspace,
      sse: fixture.requestCounts.stability.sse - requestsBefore.sse,
    }
    debug.push(
      measurement(`${cell}_vcs_requests`, requestDelta.vcs, "count"),
      measurement(`${cell}_file_requests`, requestDelta.file, "count"),
      measurement(`${cell}_workspace_requests`, requestDelta.workspace, "count"),
      measurement(`${cell}_sse_reconnects`, requestDelta.sse, "count"),
    )
    if (input.scope === "within") {
      for (const failure of sameWorkspaceSwitchStabilityFailures(cell, requestDelta)) recordVisualFailure(fixture, failure)
    }
    for (const failure of [
      ...isolatedInteractionEvidenceFailures(cell, metric),
      ...isolatedInteractionSettleFailures(cell, observation),
    ]) recordVisualFailure(fixture, failure)
  }

  // Block A — workspace closed.
  await settleStabilityRequestStarts("session_switch_closed_precondition")
  await runCell({ block: "closed", scope: "within", temperature: "cold", target: sessions[2] })
  await runCell({ block: "closed", scope: "within", temperature: "warm", target: home })
  await runCell({ block: "closed", scope: "across", temperature: "cold", target: sessions[1] })
  await runCell({ block: "closed", scope: "across", temperature: "warm", target: home })

  // Block B — leave home's substantial file for a first-visit closed panel;
  // the warm return restores home's saved file. No cold destination is primed.
  await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
  await waitForWorkspaceReviewContent(page, expectedTotal)
  await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  await openWorkspaceFileTab(page, fixture, SESSION_SWITCH_SUBSTANTIAL_FILE_PATH)
  await settleGate("session_switch_open_file_precondition")
  await settleStabilityRequestStarts("session_switch_open_file_precondition")
  await runCell({ block: "open_file", scope: "within", temperature: "cold", target: sessions[4] })
  await runCell({ block: "open_file", scope: "within", temperature: "warm", target: home })
  await runCell({ block: "open_file", scope: "across", temperature: "cold", target: sessions[3] })
  await runCell({ block: "open_file", scope: "across", temperature: "warm", target: home })

  // Block C — leave/restore home on a large review (500-file corpus, one
  // substantial diff expanded).
  // `> button` scopes to the tab's activate button; a bare `button` would
  // also match the nested close IconButton and `.at(-1)` would close the tab.
  await syntheticVisibleClick(
    page,
    "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button",
  )
  await waitForWorkspaceReviewContent(page, expectedTotal)
  await openFirstReviewDiff(page)
  await waitForReviewStable(page)
  await settleGate("session_switch_open_review_precondition")
  await settleStabilityRequestStarts("session_switch_open_review_precondition")
  await runCell({ block: "open_review", scope: "within", temperature: "cold", target: sessions[6] })
  await runCell({ block: "open_review", scope: "within", temperature: "warm", target: home })
  await runCell({ block: "open_review", scope: "across", temperature: "cold", target: sessions[5] })
  await runCell({ block: "open_review", scope: "across", temperature: "warm", target: home })

  // The workspace-open penalty, first-class per {within/across}x{cold/warm}
  // cell and per open variant.
  for (const block of ["open_file", "open_review"] as const) {
    for (const scope of SESSION_SWITCH_SCOPES) {
      for (const temperature of SESSION_SWITCH_TEMPERATURES) {
        const openMs = completions.get(`${block}:${scope}:${temperature}`)
        const closedMs = completions.get(`closed:${scope}:${temperature}`)
        if (openMs !== undefined && closedMs !== undefined) {
          debug.push(measurement(
            sessionSwitchPenaltyMetricName(block, scope, temperature),
            workspaceOpenPenaltyMs({ openMs, closedMs }),
          ))
        }
      }
    }
  }

  return { headline: mergeFrameMetrics("session-switch-workspace", metrics), debug }
}
