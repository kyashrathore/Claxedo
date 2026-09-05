import { measurement, prepareTrustedInteraction } from "../../isolated-interaction"
import type { FlowResult } from "../../flows"
import { measureInteraction } from "../../frame-sampler"
import {
  type HeavyWorkspaceSurfaceIdentity,
  type HeavyWorkspaceReviewIdentity,
  HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR,
  heavyWorkspaceWindowedCorpusFailures,
  heavyWorkspaceSetupScrollFailures,
  HEAVY_WORKSPACE_REOPEN_FILE_PATHS,
  heavyWorkspaceLiveFileFailures,
  HEAVY_WORKSPACE_CLOSE_DWELL_MS,
  HEAVY_WORKSPACE_REQUIRE_DISPOSAL_ENV,
  heavyWorkspaceClosedOwnershipFailures,
  heavyWorkspaceFileRestorationFailures,
  heavyWorkspaceReviewReopenFailures,
  heavyWorkspaceInactiveReviewOwnershipFailures,
  heavyWorkspaceReviewRestorationFailures,
  heavyWorkspaceExpansionRetentionFailures,
  heavyWorkspaceInactiveFileOwnershipFailures,
} from "./heavy-workspace-reopen-contract"
import { launchTo, recordVisualFailure, waitForAnimationFrame } from "../actions/common"
import {
  openReviewSurface,
  waitForReviewChangedFiles,
  openFirstReviewDiff,
  waitForReviewStable,
  waitForHeavyReviewCorpus,
  scrollHeavyReviewWorkingSet,
} from "../actions/review"
import { waitForTranscript } from "../actions/session"
import { measureWorkspaceFiles, openWorkspaceFileTab } from "../actions/workspace"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import type { Page } from "playwright-core"

type HeavyWorkspaceFileRestoreObservation = {
  completionMs: number
  timedOut: boolean
  blankFrames: number
  loadingFrames: number
  stableReadyFrames: number
  identity: HeavyWorkspaceSurfaceIdentity
}

type HeavyWorkspaceReviewObservation = {
  completionMs: number
  timedOut: boolean
  blankFrames: number
  loadingFrames: number
  stableReadyFrames: number
  identity: HeavyWorkspaceReviewIdentity
  scrollDiagnostic?: {
    action: string
    attempt: number
    canRecord: boolean
    currentTop?: number
    position: { top: number; anchorPath?: string; anchorOffset?: number }
    restoring: boolean
    visible: boolean
  }
}

async function readHeavyWorkspaceScrollDiagnostic(page: Page) {
  return await page.evaluate((scrollSelector) => {
    // Under disposal the Review body (and its scroll element) is unmounted
    // while another workspace tab is active; the workspace root carries the
    // same diagnostic for exactly that state. Prefer the live scroll element.
    const scroll = document.querySelector<HTMLElement>(
      `[data-testid='workspace-panel-shell'] [data-testid='review-pane-root'] ${scrollSelector}`,
    ) ?? document.querySelector<HTMLElement>(
      "[data-testid='workspace-panel-shell'] [data-testid='review-pane-root']",
    )
    const diagnostic = scroll && (scroll as unknown as Record<string, unknown>).__claxedoReviewScrollDiagnostic
    return typeof diagnostic === "function" ? diagnostic() : undefined
  }, HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR)
}

export async function heavyWorkspaceReopen(
  page: Page,
  app: BrowserTarget,
  fixture: ReturnType<typeof fixtureFor>,
): Promise<FlowResult> {
  const session = fixture.sessions[0]!
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)

  // Build the state entirely through visible product controls: open Review,
  // expand a real diff, switch to Files, and open three repository files. The
  // fixture exposes 500 VCS rows and three persisted terminal identities, but
  // injects no app events to create the state under test.
  await openReviewSurface(page, fixture, { settle: "frame" })
  await waitForReviewChangedFiles(page, fixture, { timeout: 2_000 })
  await openFirstReviewDiff(page)
  await waitForReviewStable(page)
  await waitForHeavyReviewCorpus(page, fixture)
  // The expanded diff lives at the top of the list. With the windowed file
  // list it leaves the DOM once the deep scroll moves the window away, so its
  // evidence must be read here, not from the post-scroll identity.
  const reviewAtTop = await readHeavyWorkspaceReviewIdentity(page)
  if (reviewAtTop.expandedPaths.length === 0) {
    recordVisualFailure(fixture, "heavy workspace setup had no expanded review diff")
  }
  if (reviewAtTop.expandedBodyPaths.length !== reviewAtTop.expandedPaths.length || reviewAtTop.renderedHunks === 0) {
    recordVisualFailure(fixture, "heavy workspace setup had no fully rendered expanded review body")
  }
  const deepReviewPath = fixture.changedFiles[Math.floor(fixture.changedFiles.length * 0.7)]?.file ?? ""
  await scrollHeavyReviewWorkingSet(page, fixture)
  const scrollAfterDeepPosition = await readHeavyWorkspaceScrollDiagnostic(page)
  const reviewBefore = await readHeavyWorkspaceReviewIdentity(page)
  for (const failure of heavyWorkspaceWindowedCorpusFailures({
    reviewFileCount: reviewBefore.reviewFileCount,
    totalFileCount: reviewBefore.totalFileCount,
    expectedTotal: fixture.changedFiles.length,
  })) recordVisualFailure(fixture, `heavy workspace setup: ${failure}`)
  if (!reviewBefore.scrollAnchorPath || reviewBefore.scrollTop <= 0) {
    recordVisualFailure(fixture, "heavy workspace setup did not establish a deep Review scroll position")
  }
  await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  const scrollAfterNavigator = await readHeavyWorkspaceScrollDiagnostic(page)
  for (const failure of heavyWorkspaceSetupScrollFailures({
    before: scrollAfterDeepPosition,
    after: scrollAfterNavigator,
    expectedAnchorPath: deepReviewPath,
    stage: "while opening Files",
  })) recordVisualFailure(fixture, failure)
  for (const filePath of HEAVY_WORKSPACE_REOPEN_FILE_PATHS) {
    await openWorkspaceFileTab(page, fixture, filePath)
  }
  const scrollAfterFileTabs = await readHeavyWorkspaceScrollDiagnostic(page)
  for (const failure of heavyWorkspaceSetupScrollFailures({
    before: scrollAfterNavigator,
    after: scrollAfterFileTabs,
    expectedAnchorPath: deepReviewPath,
    stage: "while opening file tabs",
  })) recordVisualFailure(fixture, failure)
  await waitForAnimationFrame(page, 2)

  const before = await readHeavyWorkspaceSurfaceIdentity(page)
  for (const failure of heavyWorkspaceLiveFileFailures(before)) recordVisualFailure(fixture, failure)
  if (before.openTabIds.length < HEAVY_WORKSPACE_REOPEN_FILE_PATHS.length + 1) {
    recordVisualFailure(
      fixture,
      `heavy workspace setup opened only ${before.openTabIds.length} tabs; expected Review plus ${HEAVY_WORKSPACE_REOPEN_FILE_PATHS.length} files`,
    )
  }
  const closeMetric = await measureInteraction(page, "heavy-workspace-close", () => closeHeavyWorkspacePanel(page), {
    armAt: "trusted-pointerdown",
  })
  const closeCompletionMs = closeMetric.completionMs
  if (closeCompletionMs >= 5_000) recordVisualFailure(fixture, "heavy workspace panel did not finish closing")
  await page.waitForTimeout(HEAVY_WORKSPACE_CLOSE_DWELL_MS)
  const closedOwnership = await page.evaluate(() => ({
    shells: document.querySelectorAll("[data-testid='workspace-panel-shell']").length,
    tabs: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-slot='workspace-tab']").length,
    fileRoots: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='tab-file-root']").length,
    navigators: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='workspace-files-navigator']").length,
    reviewRoots: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='review-pane-root']").length,
    reviewFiles: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-review-file]").length,
  }))
  const requireDisposal = process.env[HEAVY_WORKSPACE_REQUIRE_DISPOSAL_ENV] === "1"
  if (requireDisposal) {
    for (const failure of heavyWorkspaceClosedOwnershipFailures(closedOwnership)) {
      recordVisualFailure(fixture, failure)
    }
  }

  let reopened: HeavyWorkspaceReviewObservation | undefined
  const reopenControl = await prepareHeavyWorkspaceReopen(page)
  const headline = await measureInteraction(page, "heavy-workspace-reopen", async () => {
    reopened = await activateHeavyWorkspaceReview(page, reviewBefore, reopenControl)
    return reopened.completionMs
  }, { armAt: "trusted-pointerdown" })
  const observation = reopened
  if (!observation) throw new Error("heavy workspace reopen produced no observation")
  if (observation.timedOut) recordVisualFailure(fixture, "heavy workspace reopen did not reach two stable ready frames")
  const reopenedSurface = await readHeavyWorkspaceSurfaceIdentity(page)
  for (const failure of [
    ...heavyWorkspaceReviewReopenFailures(before, reopenedSurface),
    ...heavyWorkspaceReviewRestorationFailures(reviewBefore, observation.identity),
  ]) recordVisualFailure(fixture, failure)

  // The physical top-level button intentionally activates Review. Prove that
  // every file tab and its content survived by explicitly returning to the
  // selected file outside the reopen window, then measure a real Review-tab
  // resume from that file. This keeps both action clocks honest.
  const fileControl = await prepareTrustedInteraction(
    page,
    page.locator(`[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-id=${JSON.stringify(before.activeTabId)}] > button`).first(),
    "heavy-workspace-file-restore",
  )
  const restoredFile = await restoreHeavyWorkspaceFile(page, before, fileControl)
  if (restoredFile.timedOut) recordVisualFailure(fixture, "heavy workspace cached file did not restore to two stable ready frames")
  for (const failure of heavyWorkspaceFileRestorationFailures(before, restoredFile.identity)) {
    recordVisualFailure(fixture, failure)
  }

  // A file tab is active here. The workspace shell remains mounted, but only
  // the active tab may own a heavy surface.
  const inactiveReviewOwnership = await page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-testid='workspace-panel-shell'][data-open='true'] [data-testid='workspace-review-body']",
    ))
    return {
      roots: roots.length,
      files: document.querySelectorAll("[data-testid='workspace-panel-shell'][data-open='true'] [data-review-file]").length,
      fileRoots: document.querySelectorAll(
        "[data-testid='workspace-panel-shell'][data-open='true'] [data-testid='tab-file-root']",
      ).length,
    }
  })
  if (requireDisposal) {
    for (const failure of heavyWorkspaceInactiveReviewOwnershipFailures(inactiveReviewOwnership)) {
      recordVisualFailure(fixture, failure)
    }
  }

  let reviewResumed: HeavyWorkspaceReviewObservation | undefined
  const reviewResumeControl = await prepareHeavyWorkspaceReviewResume(page)
  const reviewResumeMetric = await measureInteraction(page, "heavy-workspace-review-resume", async () => {
    reviewResumed = await activateHeavyWorkspaceReview(page, reviewBefore, reviewResumeControl)
    return reviewResumed.completionMs
  }, { armAt: "trusted-pointerdown" })
  const reviewObservation = reviewResumed
  if (!reviewObservation) throw new Error("heavy workspace Review resume produced no observation")
  if (reviewObservation.timedOut) {
    recordVisualFailure(fixture, "heavy workspace Review did not restore to two stable ready frames")
    recordVisualFailure(fixture, `heavy workspace Review scroll diagnostic: ${JSON.stringify(reviewObservation.scrollDiagnostic)}`)
  }
  for (const failure of heavyWorkspaceReviewRestorationFailures(reviewBefore, reviewObservation.identity)) {
    recordVisualFailure(fixture, failure)
  }
  // The expanded diff's evidence lives in reviewAtTop, captured before the
  // deep scroll unmounted its row; reviewBefore and the resumed identity both
  // describe the deep window where no expanded row exists, so comparing them
  // can never detect a lost expansion. With every scroll-restoration assertion
  // already recorded, scroll the restored surface back to the top so the
  // expanded rows rematerialize, and require the setup expansion to survive.
  const expandedAfterResume = await readHeavyWorkspaceExpansionAtTop(page, reviewAtTop.expandedPaths)
  for (const failure of heavyWorkspaceExpansionRetentionFailures({
    expandedAtSetup: reviewAtTop.expandedPaths,
    expandedAfterResume,
  })) recordVisualFailure(fixture, failure)
  const inactiveFileOwnership = await page.evaluate(() => ({
    fileRoots: document.querySelectorAll(
      "[data-testid='workspace-panel-shell'][data-open='true'] [data-testid='tab-file-root']",
    ).length,
  }))
  if (requireDisposal) {
    for (const failure of heavyWorkspaceInactiveFileOwnershipFailures(inactiveFileOwnership)) {
      recordVisualFailure(fixture, failure)
    }
  }

  for (const [phase, metric] of [
    ["close", closeMetric],
    ["reopen", headline],
    ["Review resume", reviewResumeMetric],
  ] as const) {
    if (!metric.causal) {
      recordVisualFailure(fixture, `heavy workspace ${phase} has no causal measurement; set CLAXEDO_PERF_CAUSAL=1`)
      continue
    }
    if (metric.causal.performanceSource !== "trusted-window-trace" || !metric.causal.performance) {
      recordVisualFailure(
        fixture,
        `heavy workspace ${phase} has no exact trusted-window renderer work: ${metric.causal.performanceUnavailableReason ?? "unknown reason"}`,
      )
    }
    if (!metric.mainThreadTasksMs?.length) {
      recordVisualFailure(fixture, `heavy workspace ${phase} trace contained no renderer task samples`)
    }
  }

  const closePerformance = closeMetric.causal?.performance
  const closeDom = closeMetric.causal?.dom
  const closeResources = closeMetric.causal?.resources
  const closeLoaf = closeMetric.causal?.longAnimationFrames
  const performance = headline.causal?.performance
  const dom = headline.causal?.dom
  const resources = headline.causal?.resources
  const reviewPerformance = reviewResumeMetric.causal?.performance
  const reviewDom = reviewResumeMetric.causal?.dom
  const reviewResources = reviewResumeMetric.causal?.resources
  return {
    headline: fixture.scenario === "heavy-workspace-close"
      ? closeMetric
      : fixture.scenario === "heavy-workspace-review-resume"
        ? reviewResumeMetric
        : headline,
    debug: [
      measurement("workspace_close_completion_ms", closeCompletionMs),
      ...(closePerformance ? [
        measurement("workspace_close_script_ms", closePerformance.scriptMs),
        measurement("workspace_close_style_ms", closePerformance.recalcStyleMs),
        measurement("workspace_close_layout_ms", closePerformance.layoutMs),
        measurement("workspace_close_task_ms", closePerformance.taskMs),
      ] : []),
      measurement("workspace_close_p95_renderer_interval_ms", closeMetric.p95FrameMs),
      measurement("workspace_close_worst_renderer_interval_ms", closeMetric.worstFrameMs),
      measurement("workspace_close_renderer_intervals_over_16_67_ms", closeMetric.framesOver1667, "count"),
      measurement("workspace_close_renderer_interval_samples", closeMetric.sampleCount, "count"),
      ...(closeLoaf ? [
        measurement("workspace_close_loaf_count", closeLoaf.length, "count"),
        measurement("workspace_close_loaf_duration_ms", closeLoaf.reduce((sum, frame) => sum + frame.duration, 0)),
        measurement("workspace_close_loaf_blocking_ms", closeLoaf.reduce((sum, frame) => sum + frame.blockingDuration, 0)),
      ] : []),
      ...(closeDom ? [
        measurement("workspace_close_attribute_mutations", closeDom.attributesChanged, "count"),
        measurement("workspace_close_nodes_added", closeDom.nodesAdded, "count"),
        measurement("workspace_close_nodes_removed", closeDom.nodesRemoved, "count"),
      ] : []),
      ...(closeResources ? [
        measurement("workspace_close_resource_requests", closeResources.length, "count"),
        measurement("workspace_close_resource_transfer_bytes", closeResources.reduce((sum, resource) => sum + resource.transferSize, 0), "bytes"),
      ] : []),
      measurement("workspace_close_dwell_ms", HEAVY_WORKSPACE_CLOSE_DWELL_MS),
      measurement("workspace_disposal_required", requireDisposal ? 1 : 0, "count"),
      measurement("workspace_closed_shells_after_dwell", closedOwnership.shells, "count"),
      measurement("workspace_closed_tabs_after_dwell", closedOwnership.tabs, "count"),
      measurement("workspace_closed_file_roots_after_dwell", closedOwnership.fileRoots, "count"),
      measurement("workspace_closed_navigators_after_dwell", closedOwnership.navigators, "count"),
      measurement("workspace_closed_review_roots_after_dwell", closedOwnership.reviewRoots, "count"),
      measurement("workspace_closed_review_files_after_dwell", closedOwnership.reviewFiles, "count"),
      measurement("workspace_reopen_completion_ms", observation.completionMs),
      ...(performance ? [
        measurement("workspace_reopen_script_ms", performance.scriptMs),
        measurement("workspace_reopen_style_ms", performance.recalcStyleMs),
        measurement("workspace_reopen_layout_ms", performance.layoutMs),
        measurement("workspace_reopen_task_ms", performance.taskMs),
      ] : []),
      measurement("workspace_reopen_p95_renderer_interval_ms", headline.p95FrameMs),
      measurement("workspace_reopen_worst_renderer_interval_ms", headline.worstFrameMs),
      measurement("workspace_reopen_renderer_intervals_over_16_67_ms", headline.framesOver1667, "count"),
      measurement("workspace_reopen_renderer_interval_samples", headline.sampleCount, "count"),
      measurement("workspace_reopen_attribute_mutations", dom?.attributesChanged ?? 0, "count"),
      measurement("workspace_reopen_nodes_added", dom?.nodesAdded ?? 0, "count"),
      measurement("workspace_reopen_nodes_removed", dom?.nodesRemoved ?? 0, "count"),
      measurement("workspace_reopen_blank_frames", observation.blankFrames, "count"),
      measurement("workspace_reopen_loading_frames", observation.loadingFrames, "count"),
      measurement("workspace_reopen_stable_ready_frames", observation.stableReadyFrames, "count"),
      ...(resources ? [
        measurement("workspace_reopen_resource_requests", resources.length, "count"),
        measurement("workspace_reopen_resource_duration_ms", resources.reduce((sum, resource) => sum + resource.duration, 0)),
        measurement("workspace_reopen_resource_transfer_bytes", resources.reduce((sum, resource) => sum + resource.transferSize, 0), "bytes"),
      ] : []),
      measurement("workspace_reopen_open_tabs", reopenedSurface.openTabIds.length, "count"),
      measurement("workspace_reopen_review_files", observation.identity.reviewFileCount, "count"),
      measurement("workspace_reopen_total_files", observation.identity.totalFileCount, "count"),
      measurement("workspace_file_restore_content_lines", restoredFile.identity.selectedFileLines ?? 0, "count"),
      measurement("workspace_file_restore_content_chars", restoredFile.identity.selectedFileChars ?? 0, "count"),
      measurement("workspace_file_restore_inactive_review_roots", inactiveReviewOwnership.roots, "count"),
      measurement("workspace_file_restore_inactive_review_files", inactiveReviewOwnership.files, "count"),
      measurement("workspace_file_restore_file_roots", inactiveReviewOwnership.fileRoots, "count"),
      measurement("workspace_review_resume_completion_ms", reviewObservation.completionMs),
      ...(reviewPerformance ? [
        measurement("workspace_review_resume_script_ms", reviewPerformance.scriptMs),
        measurement("workspace_review_resume_style_ms", reviewPerformance.recalcStyleMs),
        measurement("workspace_review_resume_layout_ms", reviewPerformance.layoutMs),
        measurement("workspace_review_resume_task_ms", reviewPerformance.taskMs),
      ] : []),
      measurement("workspace_review_resume_p95_renderer_interval_ms", reviewResumeMetric.p95FrameMs),
      measurement("workspace_review_resume_worst_renderer_interval_ms", reviewResumeMetric.worstFrameMs),
      measurement("workspace_review_resume_renderer_intervals_over_16_67_ms", reviewResumeMetric.framesOver1667, "count"),
      measurement("workspace_review_resume_renderer_interval_samples", reviewResumeMetric.sampleCount, "count"),
      measurement("workspace_review_resume_attribute_mutations", reviewDom?.attributesChanged ?? 0, "count"),
      measurement("workspace_review_resume_nodes_added", reviewDom?.nodesAdded ?? 0, "count"),
      measurement("workspace_review_resume_nodes_removed", reviewDom?.nodesRemoved ?? 0, "count"),
      measurement("workspace_review_resume_blank_frames", reviewObservation.blankFrames, "count"),
      measurement("workspace_review_resume_loading_frames", reviewObservation.loadingFrames, "count"),
      measurement("workspace_review_resume_stable_ready_frames", reviewObservation.stableReadyFrames, "count"),
      ...(reviewResources ? [
        measurement("workspace_review_resume_resource_requests", reviewResources.length, "count"),
        measurement("workspace_review_resume_resource_duration_ms", reviewResources.reduce((sum, resource) => sum + resource.duration, 0)),
        measurement("workspace_review_resume_resource_transfer_bytes", reviewResources.reduce((sum, resource) => sum + resource.transferSize, 0), "bytes"),
      ] : []),
      measurement("workspace_review_resume_review_files", reviewObservation.identity.reviewFileCount, "count"),
      measurement("workspace_review_resume_total_files", reviewObservation.identity.totalFileCount, "count"),
      measurement("workspace_review_resume_rendered_hunks", reviewObservation.identity.renderedHunks, "count"),
      measurement("workspace_review_resume_expanded_diffs", reviewObservation.identity.expandedPaths.length, "count"),
      measurement("workspace_review_resume_rendered_expanded_bodies", reviewObservation.identity.expandedBodyPaths.length, "count"),
      measurement("workspace_review_resume_retained_expanded_diffs", expandedAfterResume.length, "count"),
      measurement("workspace_review_resume_scroll_top", reviewObservation.identity.scrollTop, "px"),
      measurement("workspace_review_resume_inactive_file_roots", inactiveFileOwnership.fileRoots, "count"),
    ],
  }
}

async function closeHeavyWorkspacePanel(page: Page) {
  const control = page.locator("button[aria-label='Close workspace panel']:visible").last()
  await control.waitFor({ state: "visible", timeout: 2_000 })
  const mark = `claxedo-heavy-workspace-close-${crypto.randomUUID()}`
  await control.evaluate((node, mark) => {
    performance.clearMarks(mark)
    node.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) performance.mark(mark)
    }, { once: true })
  }, mark)
  await control.click({ timeout: 2_000 })
  return await page.evaluate(async (mark) => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error("Trusted workspace close did not emit pointerdown")
    const completion = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
        const closed = !shell || (
          shell.dataset.open === "false" &&
          (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
        )
        if (closed || elapsed >= 5_000) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    performance.clearMarks(mark)
    return completion
  }, mark)
}

async function restoreHeavyWorkspaceFile(
  page: Page,
  expected: HeavyWorkspaceSurfaceIdentity,
  control: { mark: string; x: number; y: number },
): Promise<HeavyWorkspaceFileRestoreObservation> {
  await page.mouse.click(control.x, control.y)
  return await page.evaluate(async ({ expected, mark }) => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error("Trusted workspace file restore did not emit pointerdown")
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const identity = (): HeavyWorkspaceSurfaceIdentity => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
      const tabs = Array.from(shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
      const active = tabs.find((tab) => tab.dataset.selected === "true")
      const review = tabs.find((tab) => tab.dataset.workspaceTabKind === "review")
      const selectedFile = shell?.querySelector<HTMLElement>(
        "[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path][aria-selected='true']",
      )
      const activeFile = Array.from(shell?.querySelectorAll<HTMLElement>(
        "[data-testid='tab-file-root'][data-tab-file-state='ready']",
      ) ?? []).find(visible)
      const navigator = shell?.querySelector<HTMLElement>("[data-testid='workspace-files-navigator']")
      return {
        openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
        activeTabId: active?.dataset.workspaceTabId,
        selectedFilePath: selectedFile?.dataset.fileTreePath,
        selectedFileChars: Number(activeFile?.dataset.tabFileContentChars ?? "0"),
        selectedFileLines: Number(activeFile?.dataset.tabFileContentLines ?? "0"),
        navigatorMode: navigator?.dataset.mode,
        reviewTabId: review?.dataset.workspaceTabId,
      }
    }
    const sameStrings = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((value, index) => value === right[index])
    const exactIdentity = (current: HeavyWorkspaceSurfaceIdentity) =>
      sameStrings(current.openTabIds, expected.openTabIds) &&
      current.activeTabId === expected.activeTabId &&
      current.selectedFilePath === expected.selectedFilePath &&
      current.selectedFileChars === expected.selectedFileChars &&
      current.selectedFileLines === expected.selectedFileLines &&
      current.navigatorMode === expected.navigatorMode &&
      current.reviewTabId === expected.reviewTabId
    let blankFrames = 0
    let loadingFrames = 0
    let stableReadyFrames = 0
    let lastSignature = ""
    let finalIdentity = identity()
    const completionMs = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        finalIdentity = identity()
        const panelVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
        const activeFile = expected.selectedFilePath && shell?.querySelector<HTMLElement>(
          `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(expected.selectedFilePath)}"][data-tab-file-state='ready']`,
        )
        const semanticBody = !!activeFile && visible(activeFile)
        if (panelVisible && !semanticBody) blankFrames++
        const loading = !!shell && Array.from(shell.querySelectorAll<HTMLElement>("div, span"))
          .some((node) => visible(node) && node.children.length === 0 && node.textContent?.trim() === "Loading...")
        if (panelVisible && loading) loadingFrames++
        const ready = panelVisible && semanticBody && !loading && exactIdentity(finalIdentity)
        const signature = JSON.stringify(finalIdentity)
        stableReadyFrames = ready && signature === lastSignature ? stableReadyFrames + 1 : ready ? 1 : 0
        lastSignature = signature
        if (stableReadyFrames >= 2 || elapsed >= 5_000) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    performance.clearMarks(mark)
    return {
      completionMs,
      timedOut: completionMs >= 5_000,
      blankFrames,
      loadingFrames,
      stableReadyFrames,
      identity: finalIdentity,
    }
  }, { expected, mark: control.mark })
}

async function prepareHeavyWorkspaceReviewResume(page: Page) {
  const control = page.locator(
    "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] button",
  ).first()
  await control.waitFor({ state: "visible", timeout: 2_000 })
  const mark = `claxedo-heavy-workspace-review-resume-${crypto.randomUUID()}`
  await control.evaluate((node, mark) => {
    performance.clearMarks(mark)
    node.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) performance.mark(mark)
    }, { once: true })
  }, mark)
  const box = await control.boundingBox()
  if (!box) throw new Error("Visible Review workspace tab had no clickable bounds")
  return { mark, x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function activateHeavyWorkspaceReview(
  page: Page,
  expected: HeavyWorkspaceReviewIdentity,
  control: { mark: string; x: number; y: number },
): Promise<HeavyWorkspaceReviewObservation> {
  await page.mouse.click(control.x, control.y)
  return await page.evaluate(async ({ expected, mark, scrollSelector }) => {
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error("Trusted workspace Review activation did not emit pointerdown")
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const identity = (): HeavyWorkspaceReviewIdentity => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      const root = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']") ?? [])
        .find(visible)
      const diff = root?.querySelector<HTMLElement>("[data-review-diff-style]")
      const scroll = root?.querySelector<HTMLElement>(scrollSelector)
      const semanticBody = !!scroll && visible(scroll)
      const files = semanticBody
        ? Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? []).filter(visible)
        : []
      const corpus = semanticBody
        ? root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
        : undefined
      const scrollTop = scroll?.getBoundingClientRect().top
      const scrollAnchor = scrollTop === undefined
        ? undefined
        : files.toSorted((left, right) =>
            Math.abs(left.getBoundingClientRect().top - scrollTop) - Math.abs(right.getBoundingClientRect().top - scrollTop)
          )[0]
      const expanded = files.filter((item) => !!item.querySelector("[aria-expanded='true']"))
      return {
        diffStyle: diff?.dataset.reviewDiffStyle,
        expandedPaths: expanded.map((item) => item.dataset.reviewFile ?? ""),
        expandedBodyPaths: expanded
          .filter((item) => {
            const wrapper = item.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
            return !!wrapper && wrapper.childElementCount > 0 && !wrapper.querySelector("[data-slot='session-review-diff-placeholder']")
          })
          .map((item) => item.dataset.reviewFile ?? ""),
        reviewFileCount: files.length,
        totalFileCount: Number(corpus?.dataset.reviewTotalFiles ?? "0"),
        renderedHunks: Number(diff?.dataset.reviewRenderedHunks ?? "0"),
        scrollTop: scroll?.scrollTop ?? 0,
        scrollAnchorPath: scrollAnchor?.dataset.reviewFile,
        scrollAnchorOffset: scrollAnchor && scrollTop !== undefined
          ? scrollAnchor.getBoundingClientRect().top - scrollTop
          : undefined,
      }
    }
    const sameStrings = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((value, index) => value === right[index])
    let blankFrames = 0
    let loadingFrames = 0
    let stableReadyFrames = 0
    let lastSignature = ""
    let finalIdentity = identity()
    let scrollDiagnostic: HeavyWorkspaceReviewObservation["scrollDiagnostic"]
    const completionMs = await new Promise<number>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - started
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        const activeReview = shell?.querySelector<HTMLElement>(
          "[data-slot='workspace-tab'][data-workspace-tab-kind='review'][data-selected='true']",
        )
        const root = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']") ?? [])
          .find(visible)
        const scroll = root?.querySelector<HTMLElement>(scrollSelector)
        const semanticBody = !!scroll && visible(scroll)
        finalIdentity = identity()
        const diagnostic = scroll && (scroll as unknown as Record<string, unknown>).__claxedoReviewScrollDiagnostic
        scrollDiagnostic = typeof diagnostic === "function"
          ? (diagnostic as () => HeavyWorkspaceReviewObservation["scrollDiagnostic"])()
          : undefined
        const panelVisible = !!shell && visible(shell) && shell.getBoundingClientRect().width > 120
        if (panelVisible && activeReview && !semanticBody) blankFrames++
        const loading = semanticBody && !!root?.querySelector(
          "[data-testid='review-pane-loading'], [data-testid='workspace-review-pending'], [data-slot='session-review-diff-placeholder']",
        )
        if (panelVisible && activeReview && loading) loadingFrames++
        const ready = panelVisible && !!activeReview && semanticBody && !loading &&
          finalIdentity.diffStyle === expected.diffStyle &&
          sameStrings(finalIdentity.expandedPaths, expected.expandedPaths) &&
          sameStrings(finalIdentity.expandedBodyPaths, expected.expandedBodyPaths) &&
          finalIdentity.reviewFileCount === expected.reviewFileCount &&
          finalIdentity.totalFileCount === expected.totalFileCount &&
          // A windowed review scrolled away from its expanded rows renders no
          // hunks on a fresh mount; the counters only compare when an expanded
          // body is expected inside the restored window.
          (expected.expandedBodyPaths.length === 0 || finalIdentity.renderedHunks >= expected.renderedHunks) &&
          finalIdentity.scrollAnchorPath === expected.scrollAnchorPath &&
          finalIdentity.scrollAnchorOffset !== undefined && expected.scrollAnchorOffset !== undefined &&
          Math.abs(finalIdentity.scrollAnchorOffset - expected.scrollAnchorOffset) <= 2 &&
          finalIdentity.scrollTop > 0
        const signature = JSON.stringify(finalIdentity)
        stableReadyFrames = ready && signature === lastSignature ? stableReadyFrames + 1 : ready ? 1 : 0
        lastSignature = signature
        if (stableReadyFrames >= 2 || elapsed >= 5_000) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    performance.clearMarks(mark)
    return {
      completionMs,
      timedOut: completionMs >= 5_000,
      blankFrames,
      loadingFrames,
      stableReadyFrames,
      identity: finalIdentity,
      scrollDiagnostic,
    }
  }, { expected, mark: control.mark, scrollSelector: HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR })
}

async function prepareHeavyWorkspaceReopen(page: Page) {
  const control = page.locator("button[aria-label='Open workspace panel']:visible").last()
  await control.waitFor({ state: "visible", timeout: 2_000 })
  const mark = `claxedo-heavy-workspace-reopen-${crypto.randomUUID()}`
  await control.evaluate((node, mark) => {
    performance.clearMarks(mark)
    node.addEventListener("pointerdown", (event) => {
      if (event.isTrusted) performance.mark(mark)
    }, { once: true })
  }, mark)
  const box = await control.boundingBox()
  if (!box) throw new Error("Visible workspace panel open control had no clickable bounds")
  return { mark, x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function readHeavyWorkspaceSurfaceIdentity(page: Page): Promise<HeavyWorkspaceSurfaceIdentity> {
  return await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const tabs = Array.from(shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
    const active = tabs.find((tab) => tab.dataset.selected === "true")
    const review = tabs.find((tab) => tab.dataset.workspaceTabKind === "review")
    const selectedFile = shell?.querySelector<HTMLElement>(
      "[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path][aria-selected='true']",
    )
    const activeFile = Array.from(shell?.querySelectorAll<HTMLElement>(
      "[data-testid='tab-file-root'][data-tab-file-state='ready']",
    ) ?? []).find((element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    })
    const navigator = shell?.querySelector<HTMLElement>("[data-testid='workspace-files-navigator']")
    return {
      openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
      activeTabId: active?.dataset.workspaceTabId,
      selectedFilePath: selectedFile?.dataset.fileTreePath,
      selectedFileChars: Number(activeFile?.dataset.tabFileContentChars ?? "0"),
      selectedFileLines: Number(activeFile?.dataset.tabFileContentLines ?? "0"),
      navigatorMode: navigator?.dataset.mode,
      reviewTabId: review?.dataset.workspaceTabId,
    }
  })
}

async function readHeavyWorkspaceReviewIdentity(page: Page): Promise<HeavyWorkspaceReviewIdentity> {
  return await page.evaluate((scrollSelector) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const root = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']") ?? [])
      .find(visible)
    const diff = root?.querySelector<HTMLElement>("[data-review-diff-style]")
    const files = Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
    const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    const scroll = root?.querySelector<HTMLElement>(scrollSelector)
    const scrollTop = scroll?.getBoundingClientRect().top
    const scrollAnchor = scrollTop === undefined
      ? undefined
      : files.toSorted((left, right) =>
          Math.abs(left.getBoundingClientRect().top - scrollTop) - Math.abs(right.getBoundingClientRect().top - scrollTop)
        )[0]
    const expanded = files.filter((item) => !!item.querySelector("[aria-expanded='true']"))
    return {
      diffStyle: diff?.dataset.reviewDiffStyle,
      expandedPaths: expanded.map((item) => item.dataset.reviewFile ?? ""),
      expandedBodyPaths: expanded
        .filter((item) => {
          const wrapper = item.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
          return !!wrapper && wrapper.childElementCount > 0 && !wrapper.querySelector("[data-slot='session-review-diff-placeholder']")
        })
        .map((item) => item.dataset.reviewFile ?? ""),
      reviewFileCount: files.length,
      totalFileCount: Number(corpus?.dataset.reviewTotalFiles ?? "0"),
      renderedHunks: Number(diff?.dataset.reviewRenderedHunks ?? "0"),
      scrollTop: scroll?.scrollTop ?? 0,
      scrollAnchorPath: scrollAnchor?.dataset.reviewFile,
      scrollAnchorOffset: scrollAnchor && scrollTop !== undefined
        ? scrollAnchor.getBoundingClientRect().top - scrollTop
        : undefined,
    }
  }, HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR)
}

// Scrolls the restored Review back to the top so rows the deep window had
// unmounted rematerialize, then reads which files are expanded. Only runs
// after every scroll-restoration assertion has been captured, so moving the
// scroll here cannot disturb the measured evidence. Waits (bounded) until the
// window has re-rendered the expected expanded rows, since the windowing memo
// reacts to the scroll event asynchronously.
async function readHeavyWorkspaceExpansionAtTop(
  page: Page,
  expectedExpandedPaths: readonly string[],
): Promise<string[]> {
  return await page.evaluate(async ({ expectedExpandedPaths, scrollSelector }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const root = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const scroll = root?.querySelector<HTMLElement>(scrollSelector)
    if (!root || !scroll) return []
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    scroll.scrollTop = 0
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }))
    const expandedPaths = () => Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]"))
      .filter((item) => !!item.querySelector("[aria-expanded='true']"))
      .map((item) => item.dataset.reviewFile ?? "")
    for (let attempt = 0; attempt < 60; attempt++) {
      await frame()
      const expanded = expandedPaths()
      if (expectedExpandedPaths.every((path) => expanded.includes(path))) return expanded
    }
    return expandedPaths()
  }, { expectedExpandedPaths, scrollSelector: HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR })
}
