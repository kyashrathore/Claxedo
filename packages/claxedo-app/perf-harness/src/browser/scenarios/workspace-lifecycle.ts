import type { FlowResult } from "../../flows"
import { type FrameMetric, mergeFrameMetrics } from "../../frame-sampler"
import {
  HEAVY_WORKSPACE_REQUIRE_DISPOSAL_ENV,
  heavyWorkspaceClosedOwnershipFailures,
} from "./heavy-workspace-reopen-contract"
import {
  ISOLATED_INTERACTION_TIMEOUT_MS,
  settleBeforeNextInteraction,
  measurement,
  type IsolatedInteractionObservation,
  isolatedInteractionMetricRows,
  isolatedInteractionEvidenceFailures,
  isolatedInteractionSettleFailures,
  prepareTrustedInteraction,
  measureIsolatedInteraction,
  prepareTrustedWindowInteraction,
  clickWarmupResourceRequestFailures,
  isolatedInteractionResourceRequests,
  alreadyLoadedResourceRequestFailures,
} from "../../isolated-interaction"
import type { Measurement } from "../../types"
import {
  type WorkspaceLifecycleColdOpenObservation,
  WORKSPACE_LIFECYCLE_DATA_FETCH_PATTERN,
  workspaceLifecycleColdOpenFailures,
  workspaceLifecycleAboveFoldFailures,
  WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS,
  type WorkspaceLifecycleInterruptionObservation,
  WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS,
  workspaceLifecycleInterruptionFailures,
  type WorkspaceLifecycleWarmReopenObservation,
  workspaceLifecycleWarmReopenFailures,
} from "./workspace-lifecycle-contract"
import { launchTo, roundMs, recordVisualFailure } from "../actions/common"
import { waitForTranscript } from "../actions/session"
import {
  workspacePanelToggle,
  syntheticVisibleClick,
  WORKSPACE_PANEL_TOGGLE_SELECTOR,
  waitForWorkspacePanelFullyClosed,
  workspaceHeaderInertPoint,
  relayNextTrustedPointerdownToWorkspaceToggle,
  readWorkspaceClosedOwnership,
  workspaceOwnershipRows,
  waitForWorkspaceReviewContent,
} from "../actions/workspace"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import type { Page } from "playwright-core"

export async function workspaceLifecycle(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const session = fixture.sessions[0]
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  const expectedTotal = fixture.changedFiles.length
  const timeoutMs = ISOLATED_INTERACTION_TIMEOUT_MS
  const requireDisposal = process.env[HEAVY_WORKSPACE_REQUIRE_DISPOSAL_ENV] === "1"
  const debug: Measurement[] = []
  const metrics: FrameMetric[] = []
  const settleGate = async (label: string) => {
    const gate = await settleBeforeNextInteraction(page)
    debug.push(
      measurement(`${label}_settle_gate_ms`, roundMs(gate.waitedMs)),
      measurement(`${label}_settle_gate_settled`, gate.settled ? 1 : 0, "count"),
    )
  }
  const record = (prefix: string, metric: FrameMetric, observation: IsolatedInteractionObservation, extraFailures: string[] = []) => {
    metrics.push(metric)
    debug.push(...isolatedInteractionMetricRows(prefix, metric, observation))
    for (const failure of [
      ...isolatedInteractionEvidenceFailures(prefix, metric),
      ...isolatedInteractionSettleFailures(prefix, observation),
      ...extraFailures,
    ]) recordVisualFailure(fixture, failure)
  }

  // Phase 1 (+ 4 + 5): the FIRST panel open. One trusted click, three
  // triggering-event clocks: click -> shell settled (phase 1), fetchStart ->
  // data arrival (phase 4, with click -> fetchStart reported separately so a
  // late fetch is visible), data arrival -> above-fold interactive (phase 5).
  const coldOpenControl = await prepareTrustedInteraction(page, workspacePanelToggle(page), "workspace-lifecycle-cold-open")
  const coldOpen = await measureIsolatedInteraction<
    WorkspaceLifecycleColdOpenObservation & { aboveFold: { reviewFileRows: number; totalFiles: number; pending: boolean } }
  >(page, "workspace-lifecycle-cold-open", async () => {
    await page.mouse.click(coldOpenControl.x, coldOpenControl.y)
    return await page.evaluate(async ({ mark, timeoutMs, fetchPattern, expectedTotal }) => {
      const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
      if (started === undefined) throw new Error("Trusted workspace cold open did not emit pointerdown")
      performance.setResourceTimingBufferSize?.(1_000)
      const fetchRe = new RegExp(fetchPattern)
      const visible = (element: Element) => {
        if (element.closest("[aria-hidden='true']")) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      }
      let acknowledgedMs: number | undefined
      let shellSettledMs: number | undefined
      let shellStableFrames = 0
      let lastShellSignature = ""
      let aboveFoldAt: number | undefined
      let readyStableFrames = 0
      let aboveFold = { reviewFileRows: 0, totalFiles: 0, pending: false }
      let fetchEntry: PerformanceResourceTiming | undefined
      const completionMs = await new Promise<number>((resolve) => {
        const tick = () => {
          const elapsed = performance.now() - started
          if (!fetchEntry || fetchEntry.responseEnd === 0) {
            const entries = performance
              .getEntriesByType("resource")
              .filter((entry): entry is PerformanceResourceTiming =>
                entry instanceof PerformanceResourceTiming && fetchRe.test(entry.name))
            fetchEntry = entries.find((entry) => entry.startTime >= started - 5) ?? entries.at(-1) ?? fetchEntry
          }
          const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
          if (acknowledgedMs === undefined && shell) acknowledgedMs = elapsed
          const shellVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
          if (shellVisible && shellSettledMs === undefined) {
            const rect = shell.getBoundingClientRect()
            // approx: the app has no shell/content split yet, so "shell
            // settled" is the panel element visible with stable geometry.
            const signature = `${Math.round(rect.x)}x${Math.round(rect.width)}`
            shellStableFrames = signature === lastShellSignature ? shellStableFrames + 1 : 1
            lastShellSignature = signature
            if (shellStableFrames >= 2) shellSettledMs = elapsed
          }
          const root = shell
            ? Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
            : undefined
          const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
          const rows = root ? Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).filter(visible) : []
          const pending = !!root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
          aboveFold = { reviewFileRows: rows.length, totalFiles: Number(corpus?.dataset.reviewTotalFiles ?? "0"), pending }
          const ready = shellVisible && shellSettledMs !== undefined && rows.length > 0 &&
            aboveFold.totalFiles === expectedTotal && !pending
          if (ready && aboveFoldAt === undefined) aboveFoldAt = elapsed
          readyStableFrames = ready ? readyStableFrames + 1 : 0
          if (readyStableFrames >= 2 || elapsed >= timeoutMs) return resolve(elapsed)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      performance.clearMarks(mark)
      const dataArrivedAt = fetchEntry && fetchEntry.responseEnd > 0 ? fetchEntry.responseEnd : undefined
      return {
        completionMs,
        acknowledgedMs,
        timedOut: completionMs >= timeoutMs,
        shellSettledMs,
        clickToFetchStartMs: fetchEntry ? fetchEntry.startTime - started : undefined,
        fetchStartToDataMs: fetchEntry && dataArrivedAt !== undefined ? dataArrivedAt - fetchEntry.startTime : undefined,
        dataToAboveFoldMs: dataArrivedAt !== undefined && aboveFoldAt !== undefined
          ? started + aboveFoldAt - dataArrivedAt
          : undefined,
        aboveFold,
      }
    }, { mark: coldOpenControl.mark, timeoutMs, fetchPattern: WORKSPACE_LIFECYCLE_DATA_FETCH_PATTERN.source, expectedTotal })
  })
  record("workspace_lifecycle_cold_open", coldOpen.metric, coldOpen.observation, [
    ...workspaceLifecycleColdOpenFailures(coldOpen.observation),
    ...workspaceLifecycleAboveFoldFailures(coldOpen.observation.aboveFold, expectedTotal),
  ])
  const coldObserved = coldOpen.observation
  debug.push(
    // approx: shell settle without a shell/content split (see contract note).
    ...(coldObserved.shellSettledMs !== undefined
      ? [measurement("workspace_lifecycle_shell_open_settled_ms", roundMs(coldObserved.shellSettledMs))]
      : []),
    ...(coldObserved.clickToFetchStartMs !== undefined
      ? [measurement("workspace_lifecycle_click_to_fetch_start_ms", roundMs(coldObserved.clickToFetchStartMs))]
      : []),
    ...(coldObserved.fetchStartToDataMs !== undefined
      ? [measurement("workspace_lifecycle_fetch_start_to_data_ms", roundMs(coldObserved.fetchStartToDataMs))]
      : []),
    ...(coldObserved.dataToAboveFoldMs !== undefined
      ? [measurement("workspace_lifecycle_data_to_above_fold_ms", roundMs(coldObserved.dataToAboveFoldMs))]
      : []),
  )
  await settleGate("workspace_lifecycle_cold_open")

  // Phase 2: opening -> closing interruption. Start closed, begin an
  // untrusted open, click close mid-motion (the trusted, measured input), and
  // clock recovery to fully closed. Recovery is pure animation/DOM work on
  // already-loaded data, so its request count is a hard zero.
  await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
  await waitForWorkspacePanelFullyClosed(page)
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  await settleGate("workspace_lifecycle_before_open_close_interrupt")
  const inertPoint = await workspaceHeaderInertPoint(page)
  const interruptCloseControl = await prepareTrustedWindowInteraction(page, "workspace-lifecycle-open-close-interrupt")
  const openMark = `claxedo-perf-lifecycle-open-${crypto.randomUUID()}`
  const openCloseInterrupt = await measureIsolatedInteraction<WorkspaceLifecycleInterruptionObservation>(
    page,
    "workspace-lifecycle-open-close-interrupt",
    async () => {
      await relayNextTrustedPointerdownToWorkspaceToggle(page)
      await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR, openMark)
      await page.waitForTimeout(WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS)
      await page.mouse.click(inertPoint.x, inertPoint.y)
      return await page.evaluate(async ({ mark, openMark, timeoutMs }) => {
        const openedAt = performance.getEntriesByName(openMark, "mark").at(-1)?.startTime
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted interrupting close did not emit pointerdown")
        let acknowledgedMs: number | undefined
        let recovered = false
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
            if (acknowledgedMs === undefined && (!shell || shell.dataset.open === "false")) acknowledgedMs = elapsed
            const closed = !shell || (
              shell.dataset.open === "false" &&
              (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
            )
            if (closed) {
              recovered = true
              return resolve(elapsed)
            }
            if (elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        performance.clearMarks(openMark)
        return {
          completionMs,
          acknowledgedMs,
          timedOut: completionMs >= timeoutMs,
          interruptOffsetMs: openedAt === undefined ? undefined : started - openedAt,
          recovered,
        }
      }, { mark: interruptCloseControl.mark, openMark, timeoutMs })
    },
  )
  record("workspace_lifecycle_open_close_interrupt", openCloseInterrupt.metric, openCloseInterrupt.observation, [
    ...workspaceLifecycleInterruptionFailures("workspace_lifecycle_open_close_interrupt", openCloseInterrupt.observation),
    // The interrupted OPEN's click still starts the panel-open corpus
    // warm-up by design; only requests beyond that budget are a leak.
    ...clickWarmupResourceRequestFailures(
      "workspace_lifecycle_open_close_interrupt",
      isolatedInteractionResourceRequests(openCloseInterrupt.metric),
      1,
    ),
  ])
  if (openCloseInterrupt.observation.interruptOffsetMs !== undefined) {
    debug.push(measurement("workspace_lifecycle_open_close_interrupt_offset_ms", roundMs(openCloseInterrupt.observation.interruptOffsetMs)))
  }
  // No orphan DOM after the interrupted open (reuses the heavy-workspace
  // ownership-zero selectors; hard only for the disposal candidate).
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  const interruptOwnership = await readWorkspaceClosedOwnership(page)
  debug.push(...workspaceOwnershipRows("workspace_lifecycle_open_close_interrupt_owned", interruptOwnership))
  if (requireDisposal) {
    for (const failure of heavyWorkspaceClosedOwnershipFailures(interruptOwnership)) {
      recordVisualFailure(fixture, `workspace_lifecycle_open_close_interrupt: ${failure}`)
    }
  }
  await settleGate("workspace_lifecycle_open_close_interrupt")

  // Phase 3: closing -> reopening interruption. Start fully open, begin an
  // untrusted close, click reopen mid-motion, clock recovery to fully open
  // (shell visible AND its still-mounted content visible). Hard zero requests.
  await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
  await waitForWorkspaceReviewContent(page, expectedTotal)
  await settleGate("workspace_lifecycle_before_close_reopen_interrupt")
  const reopenInertPoint = await workspaceHeaderInertPoint(page)
  const interruptReopenControl = await prepareTrustedWindowInteraction(page, "workspace-lifecycle-close-reopen-interrupt")
  const closeMark = `claxedo-perf-lifecycle-close-${crypto.randomUUID()}`
  const closeReopenInterrupt = await measureIsolatedInteraction<WorkspaceLifecycleInterruptionObservation>(
    page,
    "workspace-lifecycle-close-reopen-interrupt",
    async () => {
      await relayNextTrustedPointerdownToWorkspaceToggle(page)
      await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR, closeMark)
      await page.waitForTimeout(WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS)
      await page.mouse.click(reopenInertPoint.x, reopenInertPoint.y)
      return await page.evaluate(async ({ mark, closeMark, timeoutMs }) => {
        const closedAt = performance.getEntriesByName(closeMark, "mark").at(-1)?.startTime
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted interrupting reopen did not emit pointerdown")
        const visible = (element: Element) => {
          if (element.closest("[aria-hidden='true']")) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        let acknowledgedMs: number | undefined
        let recovered = false
        let stableFrames = 0
        let lastSignature = ""
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
            if (acknowledgedMs === undefined && shell) acknowledgedMs = elapsed
            const shellVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
            const root = shell
              ? Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
              : undefined
            const contentVisible = !!root && Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)
            const ready = shellVisible && contentVisible
            const rect = shell?.getBoundingClientRect()
            const signature = rect ? `${Math.round(rect.x)}x${Math.round(rect.width)}` : ""
            stableFrames = ready && signature === lastSignature ? stableFrames + 1 : ready ? 1 : 0
            lastSignature = signature
            if (stableFrames >= 2) {
              recovered = true
              return resolve(elapsed)
            }
            if (elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        performance.clearMarks(closeMark)
        return {
          completionMs,
          acknowledgedMs,
          timedOut: completionMs >= timeoutMs,
          interruptOffsetMs: closedAt === undefined ? undefined : started - closedAt,
          recovered,
        }
      }, { mark: interruptReopenControl.mark, closeMark, timeoutMs })
    },
  )
  record("workspace_lifecycle_close_reopen_interrupt", closeReopenInterrupt.metric, closeReopenInterrupt.observation, [
    ...workspaceLifecycleInterruptionFailures("workspace_lifecycle_close_reopen_interrupt", closeReopenInterrupt.observation),
    ...alreadyLoadedResourceRequestFailures(
      "workspace_lifecycle_close_reopen_interrupt",
      isolatedInteractionResourceRequests(closeReopenInterrupt.metric),
    ),
  ])
  if (closeReopenInterrupt.observation.interruptOffsetMs !== undefined) {
    debug.push(measurement("workspace_lifecycle_close_reopen_interrupt_offset_ms", roundMs(closeReopenInterrupt.observation.interruptOffsetMs)))
  }
  await settleGate("workspace_lifecycle_close_reopen_interrupt")

  // Phase 6: warm-data / cold-surface reopen — close fully (crossing the
  // disposal boundary), then one trusted reopen with the caches warm; shell
  // and content are clocked separately. The request count is reported rather
  // than gated: whether a reopen revalidates warm data is exactly what this
  // phase exists to make visible.
  await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
  await waitForWorkspacePanelFullyClosed(page)
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  await settleGate("workspace_lifecycle_before_warm_reopen")
  const warmReopenControl = await prepareTrustedInteraction(page, workspacePanelToggle(page), "workspace-lifecycle-warm-reopen")
  const warmReopen = await measureIsolatedInteraction<WorkspaceLifecycleWarmReopenObservation>(
    page,
    "workspace-lifecycle-warm-reopen",
    async () => {
      await page.mouse.click(warmReopenControl.x, warmReopenControl.y)
      return await page.evaluate(async ({ mark, timeoutMs, expectedTotal }) => {
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted workspace warm reopen did not emit pointerdown")
        const visible = (element: Element) => {
          if (element.closest("[aria-hidden='true']")) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        let acknowledgedMs: number | undefined
        let shellSettledMs: number | undefined
        let shellStableFrames = 0
        let lastShellSignature = ""
        let contentReadyMs: number | undefined
        let readyStableFrames = 0
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
            if (acknowledgedMs === undefined && shell) acknowledgedMs = elapsed
            const shellVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
            if (shellVisible && shellSettledMs === undefined) {
              const rect = shell.getBoundingClientRect()
              // approx: no shell/content split yet (see contract note).
              const signature = `${Math.round(rect.x)}x${Math.round(rect.width)}`
              shellStableFrames = signature === lastShellSignature ? shellStableFrames + 1 : 1
              lastShellSignature = signature
              if (shellStableFrames >= 2) shellSettledMs = elapsed
            }
            const root = shell
              ? Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
              : undefined
            const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
            const rows = root ? Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).filter(visible) : []
            const pending = !!root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
            const contentReady = shellVisible && rows.length > 0 &&
              Number(corpus?.dataset.reviewTotalFiles ?? "0") === expectedTotal && !pending
            if (contentReady && contentReadyMs === undefined) contentReadyMs = elapsed
            const ready = contentReady && shellSettledMs !== undefined
            readyStableFrames = ready ? readyStableFrames + 1 : 0
            if (readyStableFrames >= 2 || elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        return {
          completionMs,
          acknowledgedMs,
          timedOut: completionMs >= timeoutMs,
          shellSettledMs,
          contentReadyMs,
        }
      }, { mark: warmReopenControl.mark, timeoutMs, expectedTotal })
    },
  )
  record("workspace_lifecycle_warm_reopen", warmReopen.metric, warmReopen.observation,
    workspaceLifecycleWarmReopenFailures(warmReopen.observation))
  debug.push(
    ...(warmReopen.observation.shellSettledMs !== undefined
      ? [measurement("workspace_lifecycle_warm_reopen_shell_ms", roundMs(warmReopen.observation.shellSettledMs))]
      : []),
    ...(warmReopen.observation.contentReadyMs !== undefined
      ? [measurement("workspace_lifecycle_warm_reopen_content_ms", roundMs(warmReopen.observation.contentReadyMs))]
      : []),
  )
  await settleGate("workspace_lifecycle_warm_reopen")

  // Phase 7: close with complete surface disposal — one trusted close, then
  // the ownership-zero inspection after the disposal dwell.
  const finalCloseControl = await prepareTrustedInteraction(page, workspacePanelToggle(page), "workspace-lifecycle-close")
  const finalClose = await measureIsolatedInteraction<IsolatedInteractionObservation>(
    page,
    "workspace-lifecycle-close",
    async () => {
      await page.mouse.click(finalCloseControl.x, finalCloseControl.y)
      return await page.evaluate(async ({ mark, timeoutMs }) => {
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted workspace close did not emit pointerdown")
        let acknowledgedMs: number | undefined
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
            if (acknowledgedMs === undefined && (!shell || shell.dataset.open === "false")) acknowledgedMs = elapsed
            const closed = !shell || (
              shell.dataset.open === "false" &&
              (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
            )
            if (closed || elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        return { completionMs, acknowledgedMs, timedOut: completionMs >= timeoutMs }
      }, { mark: finalCloseControl.mark, timeoutMs })
    },
  )
  record("workspace_lifecycle_close", finalClose.metric, finalClose.observation,
    alreadyLoadedResourceRequestFailures("workspace_lifecycle_close", isolatedInteractionResourceRequests(finalClose.metric)))
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  const closedOwnership = await readWorkspaceClosedOwnership(page)
  debug.push(
    measurement("workspace_lifecycle_disposal_required", requireDisposal ? 1 : 0, "count"),
    ...workspaceOwnershipRows("workspace_lifecycle_closed_owned", closedOwnership),
  )
  if (requireDisposal) {
    for (const failure of heavyWorkspaceClosedOwnershipFailures(closedOwnership)) {
      recordVisualFailure(fixture, `workspace_lifecycle_close: ${failure}`)
    }
  }

  return { headline: mergeFrameMetrics("workspace-lifecycle", metrics), debug }
}
