import type { BenchmarkPage as Page } from "./agent-cdp-page"
import type { ActivationHooks } from "./agent-browser-observer"
import {
  COLLAPSE_ALL_SELECTOR,
  type FixtureEvidence,
  type PanelProfile,
  type PanelTarget,
  type PublicPanelLoadPreset,
  type SessionNavigationCase,
  type WorkspacePanelCase,
} from "./workspace-panel-scenario"
import { activateExact, clickFileRow, clickFileTab, clickVisible } from "./workspace-panel-locators"
import {
  abortTrace,
  addMilestones,
  beginTrace,
  finishMeasuredTrace,
  markCounterEnd,
  waitForTracedOpenFiles,
} from "./workspace-panel-trace-recording"
import { waitForPaintedFile, waitForPanelClosed, waitForPanelProfile } from "./workspace-panel-readiness"
import { ensureAllDiffs, waitForDiffState } from "./workspace-panel-diff-readiness"
import { cancelPanelOwnerObserver, waitForPanelOwner } from "./workspace-panel-owner-readiness"
import {
  actionFile,
  ensureDiffOpen,
  ensureFilesOpen,
  ensurePanelClosed,
  ensureReviewExpansionCount,
  prepareDataWarmFileOpen,
  prepareSurfaceColdFileOpen,
  seedPanelLoad,
  waitForFastSessionSwitchQuiet,
} from "./workspace-panel-setup"

export async function executeWorkspacePanelAction(input: {
  page: Page
  benchmarkCase: WorkspacePanelCase
  fixture: FixtureEvidence
  preset: PublicPanelLoadPreset
  hoverPrefetch: boolean
}) {
  const { page, benchmarkCase, fixture, preset } = input
  await seedPanelLoad(page, fixture, preset)
  switch (benchmarkCase.action) {
    case "open-panel":
      await ensureFilesOpen(page, fixture)
      await ensurePanelClosed(page)
      return measurePanelOpen(page, fixture)
    case "close-panel":
      await ensureFilesOpen(page, fixture)
      return measurePrearmedSettledAction(
        page,
        async () => waitForPanelClosed(page, true),
        async () => clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Close workspace panel']"),
      )
    case "files-to-review":
      await ensureFilesOpen(page, fixture)
      return measurePrearmedSettledAction(
        page,
        async () => waitForPanelProfile(page, "diff", fixture, preset.expandedReviewFileCount, true),
        async () => clickVisible(page, "button[aria-label='Open Changes']"),
      )
    case "review-to-files":
      await ensureDiffOpen(page, fixture)
      return measurePrearmedSettledAction(
        page,
        async () => waitForPanelProfile(page, "files", fixture, undefined, true),
        async () => clickVisible(page, "button[aria-label='Open Files']"),
      )
    case "open-file": {
      await ensureFilesOpen(page, fixture)
      const file = actionFile(fixture, preset)
      if (input.hoverPrefetch) await prepareDataWarmFileOpen(page, fixture, preset, file)
      else await prepareSurfaceColdFileOpen(page, fixture, preset, file)
      return measurePrearmedSettledAction(
        page,
        async () => waitForPaintedFile(page, file, true),
        async () => clickFileRow(page, file),
      )
    }
    case "switch-file-tab": {
      await ensureFilesOpen(page, fixture)
      const [first, second] = fixture.openFiles
      await clickFileTab(page, first)
      await waitForPaintedFile(page, first)
      return measurePrearmedSettledAction(
        page,
        async () => waitForPaintedFile(page, second, true),
        async () => clickFileTab(page, second),
      )
    }
    case "expand-all":
      await ensureDiffOpen(page, fixture)
      await ensureAllDiffs(page, fixture, false)
      return measurePrearmedSettledAction(
        page,
        async () => waitForDiffState(page, fixture, { openCount: fixture.changed.length }, true),
        async () => clickVisible(page, "button[aria-label='Expand all']"),
      )
    case "collapse-all":
      await ensureDiffOpen(page, fixture)
      await ensureReviewExpansionCount(page, fixture, preset.expandedReviewFileCount)
      return measurePrearmedSettledAction(
        page,
        async () => waitForDiffState(page, fixture, { openCount: 0 }, true),
        async () => clickVisible(page, COLLAPSE_ALL_SELECTOR),
      )
  }
  // The switch covers every `WorkspacePanelAction`, so this is unreachable.
  // Saying so gives the function one return contract, and adding an action to
  // the union without a case here now fails to compile rather than silently
  // measuring nothing.
  const unhandled: never = benchmarkCase.action
  throw new Error(`Claxedo workspace panel action is not implemented: ${JSON.stringify(unhandled)}`)
}

export async function executeSessionNavigation(input: {
  page: Page
  benchmarkCase: SessionNavigationCase
  source: PanelTarget
  destination: PanelTarget
  fixture: FixtureEvidence
  preset?: PublicPanelLoadPreset
}) {
  const { page, benchmarkCase, source, destination, fixture, preset } = input
  if (!Number.isSafeInteger(benchmarkCase.transcriptBytes) || benchmarkCase.transcriptBytes <= 0) {
    throw new Error("Claxedo session-navigation transcriptBytes must be a positive safe integer")
  }

  if (benchmarkCase.navigationType === "first-visit") {
    // Measured history walks dest→dest. Launch already leaves the app on
    // control once; do not bounce back to source/control between destinations.
    await ensurePanelClosed(page)
    return measureNavigation(page, destination)
  }

  if (benchmarkCase.navigationType === "return-visited-panel-closed") {
    // Destination was first-visited earlier in this process. Continue from the
    // current session without an untimed activateExact(control/source).
    await ensurePanelClosed(page)
    return measureNavigation(page, destination)
  }

  if (!preset) throw new Error("Claxedo panel-open session navigation requires a load preset")
  // Panel-open only: source/control seeding stays isolated here so history
  // measured clicks are not reset to control between destinations.
  await activateExact(page, destination)
  await seedPanelLoad(page, fixture, preset)
  await waitForPanelOwner(page, "diff", destination, fixture, {
    expectedReviewOpenCount: preset.expandedReviewFileCount,
  })
  await activateExact(page, source)
  await seedPanelLoad(page, fixture, preset)
  await waitForPanelOwner(page, "diff", source, fixture, {
    expectedReviewOpenCount: preset.expandedReviewFileCount,
  })
  // The untimed control seeding is itself a session switch. A follow-up switch
  // inside the app's fast-switch window counts as rapid flicking and defers the
  // hydrate above the first fold by 900 ms, which the shared first-fold rule
  // then waits out. The measured return is a deliberate revisit, so let that
  // window expire before the trusted click.
  await waitForFastSessionSwitchQuiet(page)
  return measureNavigation(page, destination, {
    fixture,
    profile: "diff",
    expectedReviewOpenCount: preset.expandedReviewFileCount,
  })
}

async function measurePanelOpen(page: Page, fixture: FixtureEvidence) {
  const recording = await beginTrace(page, { openFilesExpectedCount: fixture.files.length })
  try {
    await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Open workspace panel']")
    const readiness = await waitForTracedOpenFiles(page)
    await addMilestones(page, [
      { id: "shell-visible", at: readiness.shellVisible },
      { id: "animation-settled", at: readiness.animationSettled },
      { id: "data-ready", at: readiness.dataReady },
      { id: "above-fold-painted", at: readiness.aboveFoldPainted },
    ])
    return await finishMeasuredTrace(page, recording)
  } catch (error) {
    await abortTrace(page, recording)
    throw error
  }
}

export async function runPrearmedStablePaint(input: {
  arm: () => Promise<number>
  click: () => Promise<void>
  cancel: () => Promise<void>
}) {
  const painted = input.arm()
  void painted.catch(() => undefined)
  try {
    await input.click()
    return await painted
  } catch (error) {
    await input.cancel()
    await Promise.allSettled([painted])
    throw error
  }
}

async function measurePrearmedSettledAction(
  page: Page,
  ready: () => Promise<number>,
  click: () => Promise<void>,
) {
  const recording = await beginTrace(page)
  let aborted = false
  try {
    const paintedAt = await runPrearmedStablePaint({
      arm: ready,
      click,
      cancel: async () => {
        aborted = true
        await abortTrace(page, recording)
      },
    })
    await addMilestones(page, [{ id: "action-painted", at: paintedAt }])
    await markCounterEnd(page, paintedAt)
    return await finishMeasuredTrace(page, recording)
  } catch (error) {
    if (!aborted) await abortTrace(page, recording)
    throw error
  }
}

async function measureNavigation(
  page: Page,
  destination: PanelTarget,
  panel?: {
    profile: Exclude<PanelProfile, "closed">
    fixture: FixtureEvidence
    expectedReviewOpenCount?: number
  },
) {
  if (!panel) {
    const session = await activateExact(page, destination)
    return {
      clock: {
        kind: "single-monotonic-clock" as const,
        clock: "performance.now" as const,
        start: session.trustedEventAtMs,
        end: session.paintedAtMs,
      },
    }
  }
  const recording = await beginTrace(page)
  const panelObserverToken = `panel-owner:${crypto.randomUUID()}`
  let panelReadyPromise: Promise<number> | undefined
  try {
    const hooks: ActivationHooks = {
      onArmed: async () => {
        panelReadyPromise = waitForPanelOwner(page, panel.profile, destination, panel.fixture, {
          markEnd: false,
          expectedReviewOpenCount: panel.expectedReviewOpenCount,
          observerToken: panelObserverToken,
        })
        void panelReadyPromise.catch(() => undefined)
      },
    }
    const session = await activateExact(page, destination, hooks)
    if (!panelReadyPromise) throw new Error("Claxedo session activation did not arm the panel readiness observer")
    const panelReady = await panelReadyPromise
    const end = Math.max(session.paintedAtMs, panelReady)
    await addMilestones(page, [
      { id: "session-ready", at: session.paintedAtMs },
      { id: "panel-ready", at: panelReady },
      { id: "content-identity", at: session.paintedAtMs },
      { id: "above-fold-painted", at: end },
    ])
    await markCounterEnd(page, end)
    return await finishMeasuredTrace(page, recording)
  } catch (error) {
    await cancelPanelOwnerObserver(page, panelObserverToken)
    if (panelReadyPromise) await Promise.allSettled([panelReadyPromise])
    await abortTrace(page, recording)
    throw error
  }
}
