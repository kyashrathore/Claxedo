import type { FlowResult } from "../../flows"
import { type FrameMetric, mergeFrameMetrics } from "../../frame-sampler"
import {
  type IsolatedInteractionObservation,
  ISOLATED_INTERACTION_TIMEOUT_MS,
  settleBeforeNextInteraction,
  measurement,
  prepareTrustedInteraction,
  measureIsolatedInteraction,
  isolatedInteractionMetricRows,
  isolatedInteractionEvidenceFailures,
  isolatedInteractionSettleFailures,
  alreadyLoadedResourceRequestFailures,
  isolatedInteractionResourceRequests,
} from "../../isolated-interaction"
import type { Measurement } from "../../types"
import {
  type WorkspaceTabSnapshot,
  WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS,
  workspaceInteractionTabSwitchFailures,
  WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX,
  WORKSPACE_INTERACTIONS_HOVER_DWELL_MS,
  workspaceInteractionExpandFailures,
  workspaceInteractionCollapseFailures,
  workspaceInteractionDiffStyleFailures,
  WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX,
  workspaceInteractionLargeDiffGuardFailures,
  workspaceInteractionNavigatorFailures,
  WORKSPACE_INTERACTIONS_OPEN_FILE_PATH,
  workspaceInteractionTabDeltaFailures,
  WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX,
  workspaceInteractionResizeFailures,
  WORKSPACE_INTERACTIONS_LARGE_FILE_PATH,
} from "./workspace-interactions-contract"
import { launchTo, roundMs, recordVisualFailure } from "../actions/common"
import { openReviewSurface, waitForHeavyReviewCorpus } from "../actions/review"
import { waitForTranscript } from "../actions/session"
import { measureWorkspaceFiles, openWorkspaceFileTab } from "../actions/workspace"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import path from "node:path"
import type { Page } from "playwright-core"

type PanelInteractionMode =
  | { kind: "activate-file"; filePath: string }
  | { kind: "activate-review" }
  | { kind: "diff-style"; expectedStyle: string }
  | { kind: "expand-diff"; filePath: string; renderedHunksBefore: number }
  // Collapse is structural: collapsed rows mount NO accordion content at all
  // (review-session.tsx wraps Content in Show when={expanded()}), and the
  // rendered-hunks counter is monotonic, so unmount + trigger state — not a
  // counter decrease — is the collapse observable.
  | { kind: "collapse-diff"; filePath: string }
  // An above-ceiling diff expands to the large-diff guard pane, not hunks.
  | { kind: "large-diff-guard"; filePath: string }
  // The "render anyway" force is its own isolated interaction and is where
  // the large hunks actually render.
  | { kind: "force-large-diff"; filePath: string; renderedHunksBefore: number }
  | { kind: "navigator"; expectedMode: "files" | "changes" }
  | { kind: "close-tab"; tabId: string; openTabsBefore: number }

type PanelInteractionObservation = IsolatedInteractionObservation & {
  tabs: WorkspaceTabSnapshot
  renderedHunks: number
  diffStyle?: string
  navigatorMode?: string
  navigatorDataReady: boolean
  /** For diff modes: the target row's trigger expanded state at settle. */
  rowExpanded: boolean
  /** For diff modes: the target row still mounts its diff wrapper at settle. */
  rowContentMounted: boolean
  /** For diff modes: the target row shows the large-diff guard pane at settle. */
  rowLargeDiffGuard: boolean
}

// One self-contained in-page readiness loop for every workspace-panel
// interaction kind. Serialized into the page by Playwright, so it must not
// reference module-scope helpers.
const observeWorkspacePanelInteraction = async (params: {
  mark: string
  timeoutMs: number
  expectedTotal: number
  mode: PanelInteractionMode
}): Promise<PanelInteractionObservation> => {
  const started = performance.getEntriesByName(params.mark, "mark").at(-1)?.startTime
  if (started === undefined) throw new Error(`Trusted ${params.mode.kind} interaction did not emit pointerdown`)
  const visible = (element: Element) => {
    if (element.closest("[aria-hidden='true']")) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const shell = () => document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
  const reviewRoot = () => {
    const current = shell()
    return current
      ? Array.from(current.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
      : undefined
  }
  const diffNode = () => {
    const node = reviewRoot()?.querySelector<HTMLElement>("[data-review-diff-style]")
    return node && !node.closest("[aria-hidden='true']") ? node : undefined
  }
  const renderedHunks = () => Number(diffNode()?.dataset.reviewRenderedHunks ?? "0")
  const tabsSnapshot = () => {
    const tabs = Array.from(shell()?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
    return {
      openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
      activeTabId: tabs.find((tab) => tab.dataset.selected === "true")?.dataset.workspaceTabId,
    }
  }
  const loadingVisible = () => {
    const current = shell()
    if (!current) return false
    return Array.from(current.querySelectorAll<HTMLElement>("div, span"))
      .some((node) => visible(node) && node.children.length === 0 && node.textContent?.trim() === "Loading...")
  }
  const navigatorNode = () => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator']"))
      .filter(visible)
      .at(-1)
  }
  const navigatorDataReady = () => {
    const navigator = navigatorNode()
    if (!navigator) return false
    if (navigator.getAttribute("data-file-tree-data-ready") === "true") return true
    if (navigator.querySelector("[data-file-tree-loading], [class*='animate-spin']")) return false
    return !!navigator.querySelector("[data-file-tree-path], [data-component='filetree'] button")
  }
  const mode = params.mode
  const diffRow = () => {
    const filePath = "filePath" in mode ? mode.filePath : undefined
    if (!filePath) return undefined
    return reviewRoot()?.querySelector<HTMLElement>(`[data-review-file="${CSS.escape(filePath)}"]`) ?? undefined
  }
  const rowState = () => {
    const row = diffRow()
    const wrapper = row?.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
    return {
      expanded: row?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") === "true",
      contentMounted: !!wrapper,
      contentRendered: !!wrapper && wrapper.childElementCount > 0 &&
        !wrapper.querySelector("[data-slot='session-review-diff-placeholder']") &&
        !wrapper.querySelector("[data-slot='session-review-large-diff']"),
      largeDiffGuard: !!row?.querySelector("[data-slot='session-review-large-diff']"),
    }
  }
  const acknowledge = (): boolean => {
    switch (mode.kind) {
      case "activate-file":
        return !!shell()?.querySelector(
          `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(mode.filePath)}"]`,
        )
      case "activate-review":
        return !!shell()?.querySelector(
          "[data-slot='workspace-tab'][data-workspace-tab-kind='review'][data-selected='true']",
        )
      case "diff-style":
        return diffNode()?.dataset.reviewDiffStyle === mode.expectedStyle
      case "expand-diff":
      case "large-diff-guard":
        return rowState().expanded
      case "collapse-diff":
        return !rowState().expanded
      case "force-large-diff":
        return !rowState().largeDiffGuard
      case "navigator":
        return navigatorNode()?.dataset.mode === mode.expectedMode
      case "close-tab":
        return tabsSnapshot().openTabIds.length < mode.openTabsBefore
    }
    // The switch covers every `mode.kind`, so this is unreachable. Stating it
    // gives the function one return contract, and a new mode fails to compile
    // here rather than silently reading as "not yet".
    const unhandled: never = mode
    throw new Error(`workspace-interactions mode is not implemented: ${JSON.stringify(unhandled)}`)
  }
  const ready = (): boolean => {
    switch (mode.kind) {
      case "activate-file": {
        const root = shell()?.querySelector<HTMLElement>(
          `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(mode.filePath)}"][data-tab-file-state='ready']`,
        )
        return !!root && visible(root) && !loadingVisible()
      }
      case "activate-review": {
        const root = reviewRoot()
        const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
        if (!corpus || Number(corpus.dataset.reviewTotalFiles ?? "0") !== params.expectedTotal) return false
        if (!Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? []).some(visible)) return false
        return !root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
      }
      case "diff-style":
        return diffNode()?.dataset.reviewDiffStyle === mode.expectedStyle
      case "expand-diff": {
        const state = rowState()
        return state.expanded && state.contentRendered && renderedHunks() > mode.renderedHunksBefore
      }
      case "collapse-diff": {
        const state = rowState()
        return !state.expanded && !state.contentMounted
      }
      case "large-diff-guard": {
        const state = rowState()
        return state.expanded && state.largeDiffGuard
      }
      case "force-large-diff": {
        const state = rowState()
        return state.expanded && !state.largeDiffGuard && state.contentRendered &&
          renderedHunks() > mode.renderedHunksBefore
      }
      case "navigator":
        return navigatorNode()?.dataset.mode === mode.expectedMode && navigatorDataReady()
      case "close-tab": {
        const tabs = tabsSnapshot()
        if (tabs.openTabIds.includes(mode.tabId)) return false
        if (tabs.openTabIds.length !== mode.openTabsBefore - 1) return false
        return tabs.activeTabId !== undefined && !loadingVisible()
      }
    }
    // The switch covers every `mode.kind`, so this is unreachable. Stating it
    // gives the function one return contract, and a new mode fails to compile
    // here rather than silently reading as "not yet".
    const unhandled: never = mode
    throw new Error(`workspace-interactions mode is not implemented: ${JSON.stringify(unhandled)}`)
  }
  let acknowledgedMs: number | undefined
  let stableFrames = 0
  let lastSignature = ""
  const completionMs = await new Promise<number>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started
      if (acknowledgedMs === undefined && acknowledge()) acknowledgedMs = elapsed
      const isReady = ready()
      const signature = JSON.stringify([
        tabsSnapshot(),
        renderedHunks(),
        rowState(),
        diffNode()?.dataset.reviewDiffStyle,
        navigatorNode()?.dataset.mode,
      ])
      stableFrames = isReady && signature === lastSignature ? stableFrames + 1 : isReady ? 1 : 0
      lastSignature = signature
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  performance.clearMarks(params.mark)
  const settledRowState = rowState()
  return {
    completionMs,
    acknowledgedMs,
    timedOut: completionMs >= params.timeoutMs,
    tabs: tabsSnapshot(),
    renderedHunks: renderedHunks(),
    diffStyle: diffNode()?.dataset.reviewDiffStyle,
    navigatorMode: navigatorNode()?.dataset.mode,
    navigatorDataReady: navigatorDataReady(),
    rowExpanded: settledRowState.expanded,
    rowContentMounted: settledRowState.contentMounted,
    rowLargeDiffGuard: settledRowState.largeDiffGuard,
  }
}

async function readWorkspaceTabSnapshot(page: Page): Promise<WorkspaceTabSnapshot> {
  return await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const tabs = Array.from(shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']") ?? [])
    return {
      openTabIds: tabs.map((tab) => tab.dataset.workspaceTabId ?? ""),
      activeTabId: tabs.find((tab) => tab.dataset.selected === "true")?.dataset.workspaceTabId,
    }
  })
}

export async function workspaceInteractions(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const session = fixture.sessions[0]
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  const expectedTotal = fixture.changedFiles.length
  const timeoutMs = ISOLATED_INTERACTION_TIMEOUT_MS
  const debug: Measurement[] = []
  const metrics: FrameMetric[] = []
  const settleGate = async (label: string) => {
    const gate = await settleBeforeNextInteraction(page)
    debug.push(
      measurement(`${label}_settle_gate_ms`, roundMs(gate.waitedMs)),
      measurement(`${label}_settle_gate_settled`, gate.settled ? 1 : 0, "count"),
    )
  }

  // Precondition for EVERY interaction: data loaded and animations settled.
  await openReviewSurface(page, fixture, { settle: "frame" })
  await waitForHeavyReviewCorpus(page, fixture)
  await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  for (const filePath of WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS) {
    await openWorkspaceFileTab(page, fixture, filePath)
  }
  await settleGate("workspace_interactions_precondition")

  const tabIdForFile = async (filePath: string) =>
    await page.evaluate((basename) => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      const tabs = Array.from(
        shell?.querySelectorAll<HTMLElement>("[data-slot='workspace-tab'][data-workspace-tab-kind='file']") ?? [],
      )
      return tabs.find((tab) => (tab.textContent ?? "").includes(basename))?.dataset.workspaceTabId
    }, path.basename(filePath))
  const fileTabButton = (filePath: string) =>
    page
      .locator("[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='file']")
      .filter({ hasText: path.basename(filePath) })
      .first()
      .locator("button")
      .first()
  const reviewTabButton = () =>
    page.locator(
      "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] button",
    ).first()
  const navigator = () => page.locator("[data-testid='workspace-files-navigator'][data-mode='files']").last()

  const runPanelInteraction = async (input: {
    prefix: string
    control: ReturnType<Page["locator"]>
    mode: PanelInteractionMode
    hardZeroRequests: boolean
    /**
     * Rest the pointer on the control for this long before the measured press.
     * `page.mouse.click` moves and presses in the same call, which no mouse
     * user can do: reaching a control and committing to it takes longer than a
     * frame. Use it only where the dwell is part of the interaction being
     * modelled, and keep it out of the measured window (the recorder arms at
     * the trusted pointerdown, so hover-time work is excluded by construction).
     */
    hoverDwellMs?: number
  }) => {
    await input.control.scrollIntoViewIfNeeded().catch(() => undefined)
    const prepared = await prepareTrustedInteraction(page, input.control, input.prefix)
    if (input.hoverDwellMs) {
      await page.mouse.move(prepared.x, prepared.y)
      await page.waitForTimeout(input.hoverDwellMs)
    }
    const { metric, observation } = await measureIsolatedInteraction<PanelInteractionObservation>(
      page,
      input.prefix,
      async () => {
        await page.mouse.click(prepared.x, prepared.y)
        return await page.evaluate(observeWorkspacePanelInteraction, {
          mark: prepared.mark,
          timeoutMs,
          expectedTotal,
          mode: input.mode,
        })
      },
    )
    metrics.push(metric)
    debug.push(...isolatedInteractionMetricRows(input.prefix, metric, observation))
    for (const failure of [
      ...isolatedInteractionEvidenceFailures(input.prefix, metric),
      ...isolatedInteractionSettleFailures(input.prefix, observation),
      ...(input.hardZeroRequests
        ? alreadyLoadedResourceRequestFailures(input.prefix, isolatedInteractionResourceRequests(metric))
        : []),
    ]) recordVisualFailure(fixture, failure)
    await settleGate(input.prefix)
    return { metric, observation }
  }

  const [fileA, fileB] = WORKSPACE_INTERACTIONS_PRELOADED_FILE_PATHS
  const readRenderedHunks = async () =>
    await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
        .find((item) => !item.closest("[aria-hidden='true']"))
      return Number(node?.dataset.reviewRenderedHunks ?? "0")
    })
  const readDiffStyle = async () =>
    await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
        .find((item) => !item.closest("[aria-hidden='true']"))
      return node?.dataset.reviewDiffStyle
    })
  const gateTabSwitch = (interaction: string, before: WorkspaceTabSnapshot, after: WorkspaceTabSnapshot, expectedActiveTabId?: string) => {
    for (const failure of workspaceInteractionTabSwitchFailures({ interaction, before, after, expectedActiveTabId })) {
      recordVisualFailure(fixture, failure)
    }
  }

  // Switching among open file tabs — both directions, each isolated + zero requests.
  const tabIdA = await tabIdForFile(fileA)
  const tabIdB = await tabIdForFile(fileB)
  let before = await readWorkspaceTabSnapshot(page)
  const toA = await runPanelInteraction({
    prefix: "workspace_interactions_tab_switch_to_a",
    control: fileTabButton(fileA),
    mode: { kind: "activate-file", filePath: fileA },
    hardZeroRequests: true,
  })
  gateTabSwitch("workspace_interactions_tab_switch_to_a", before, toA.observation.tabs, tabIdA)
  before = toA.observation.tabs
  const toB = await runPanelInteraction({
    prefix: "workspace_interactions_tab_switch_to_b",
    control: fileTabButton(fileB),
    mode: { kind: "activate-file", filePath: fileB },
    hardZeroRequests: true,
  })
  gateTabSwitch("workspace_interactions_tab_switch_to_b", before, toB.observation.tabs, tabIdB)

  // Files -> Review navigation (data already loaded at precondition).
  before = toB.observation.tabs
  const toReview = await runPanelInteraction({
    prefix: "workspace_interactions_files_to_review",
    control: reviewTabButton(),
    mode: { kind: "activate-review" },
    hardZeroRequests: true,
  })
  gateTabSwitch("workspace_interactions_files_to_review", before, toReview.observation.tabs)

  // Expanding then collapsing a substantial diff — the SAME row both times,
  // addressed through its own trigger. Expanding may legitimately fetch the
  // file diff on demand, so its request count is reported, not gated;
  // collapsing unmounts already-mounted DOM and is a hard zero. Collapse is
  // proven structurally (content unmounted): the rendered-hunks counter is
  // the app's monotonic render counter and never decreases.
  const expandPath = fixture.changedFiles[WORKSPACE_INTERACTIONS_EXPAND_DIFF_INDEX].file
  const diffTrigger = page
    .locator(`[data-testid='review-pane-root'] [data-review-file="${expandPath}"]`)
    .locator("[data-testid$='-trigger']")
    .first()
  const hunksBeforeExpand = await readRenderedHunks()
  const expand = await runPanelInteraction({
    prefix: "workspace_interactions_diff_expand",
    control: diffTrigger,
    mode: { kind: "expand-diff", filePath: expandPath, renderedHunksBefore: hunksBeforeExpand },
    hardZeroRequests: false,
    // A row is expanded with a mouse, and a mouse cannot press a row it has not
    // first moved onto and held still on. Modelling that dwell is the only way
    // this phase measures what a user experiences: without it the pointer
    // arrives and presses in the same task, so anything the app starts at hover
    // time (here: the row's diff content) is still in flight when the press
    // begins and gets charged to the click. The dwell is deliberately short —
    // well under the ~200ms a deliberate click takes end to end.
    hoverDwellMs: WORKSPACE_INTERACTIONS_HOVER_DWELL_MS,
  })
  for (const failure of workspaceInteractionExpandFailures({
    interaction: "workspace_interactions_diff_expand",
    renderedHunksBefore: hunksBeforeExpand,
    renderedHunksAfter: expand.observation.renderedHunks,
  })) recordVisualFailure(fixture, failure)
  const collapse = await runPanelInteraction({
    prefix: "workspace_interactions_diff_collapse",
    control: diffTrigger,
    mode: { kind: "collapse-diff", filePath: expandPath },
    hardZeroRequests: true,
  })
  for (const failure of workspaceInteractionCollapseFailures({
    interaction: "workspace_interactions_diff_collapse",
    stillExpanded: collapse.observation.rowExpanded,
    contentMounted: collapse.observation.rowContentMounted,
  })) recordVisualFailure(fixture, failure)

  // Split <-> unified, both directions, each isolated + zero requests.
  const initialStyle = await readDiffStyle()
  if (initialStyle !== "split" && initialStyle !== "unified") {
    recordVisualFailure(fixture, `review diff style was not readable before the toggle: ${String(initialStyle)}`)
  } else {
    const otherStyle = initialStyle === "split" ? "unified" : "split"
    for (const [prefix, expectedStyle] of [
      ["workspace_interactions_diff_style_forward", otherStyle],
      ["workspace_interactions_diff_style_back", initialStyle],
    ] as const) {
      const toggle = page
        .locator(`[data-testid="review-diff-style-toggle"][data-review-next-diff-style="${expectedStyle}"]`)
        .last()
      const result = await runPanelInteraction({
        prefix,
        control: toggle,
        mode: { kind: "diff-style", expectedStyle },
        hardZeroRequests: true,
      })
      for (const failure of workspaceInteractionDiffStyleFailures({
        interaction: prefix,
        expectedStyle,
        observedStyle: result.observation.diffStyle,
      })) recordVisualFailure(fixture, failure)
    }
  }

  // Large-diff expand: the diff's changed lines exceed the app's render
  // ceiling (MAX_DIFF_CHANGED_LINES), so it is measured as TWO isolated
  // interactions — expanding surfaces the large-diff guard pane (the app's
  // designed above-ceiling response, no hunks and no content fetch), and the
  // explicit "render anyway" force then renders the large hunks (fetching
  // content on demand, so its request count is reported, not gated).
  const largeDiffPath = fixture.changedFiles[WORKSPACE_INTERACTIONS_LARGE_DIFF_INDEX].file
  const largeDiffTrigger = page
    .locator(`[data-testid='review-pane-root'] [data-review-file="${largeDiffPath}"]`)
    .locator("[data-testid$='-trigger']")
    .first()
  const largeGuard = await runPanelInteraction({
    prefix: "workspace_interactions_large_diff_expand",
    control: largeDiffTrigger,
    mode: { kind: "large-diff-guard", filePath: largeDiffPath },
    hardZeroRequests: false,
  })
  for (const failure of workspaceInteractionLargeDiffGuardFailures({
    interaction: "workspace_interactions_large_diff_expand",
    placeholderShown: largeGuard.observation.rowLargeDiffGuard,
  })) recordVisualFailure(fixture, failure)
  if (largeGuard.observation.rowLargeDiffGuard) {
    const hunksBeforeForce = await readRenderedHunks()
    const forceButton = page
      .locator(`[data-testid='review-pane-root'] [data-review-file="${largeDiffPath}"] [data-slot='session-review-large-diff-actions'] button`)
      .first()
    const force = await runPanelInteraction({
      prefix: "workspace_interactions_large_diff_force",
      control: forceButton,
      mode: { kind: "force-large-diff", filePath: largeDiffPath, renderedHunksBefore: hunksBeforeForce },
      hardZeroRequests: false,
    })
    for (const failure of workspaceInteractionExpandFailures({
      interaction: "workspace_interactions_large_diff_force",
      renderedHunksBefore: hunksBeforeForce,
      renderedHunksAfter: force.observation.renderedHunks,
    })) recordVisualFailure(fixture, failure)
  }

  // Review -> Files navigation back onto an open, already-loaded file tab.
  before = await readWorkspaceTabSnapshot(page)
  const backToFiles = await runPanelInteraction({
    prefix: "workspace_interactions_review_to_files",
    control: fileTabButton(fileB),
    mode: { kind: "activate-file", filePath: fileB },
    hardZeroRequests: true,
  })
  gateTabSwitch("workspace_interactions_review_to_files", before, backToFiles.observation.tabs, tabIdB)

  // Navigator mode change, both directions. The changes mode may fetch VCS
  // status on demand, so both directions report rather than gate requests.
  // The Changes navigator button is configuration-gated (showChanges); when
  // this build does not render it, the interaction is skipped and reported.
  const changesAvailable = await page.locator("button[aria-label='Open Changes']:visible").count()
  debug.push(measurement("workspace_interactions_navigator_changes_available", changesAvailable > 0 ? 1 : 0, "count"))
  if (changesAvailable > 0) {
    for (const [prefix, label, expectedMode] of [
      ["workspace_interactions_navigator_to_changes", "Open Changes", "changes"],
      ["workspace_interactions_navigator_to_files", "Open Files", "files"],
    ] as const) {
      const result = await runPanelInteraction({
        prefix,
        control: page.locator(`button[aria-label='${label}']:visible`).first(),
        mode: { kind: "navigator", expectedMode },
        hardZeroRequests: false,
      })
      for (const failure of workspaceInteractionNavigatorFailures({
        interaction: prefix,
        expectedMode,
        observedMode: result.observation.navigatorMode,
        dataReady: result.observation.navigatorDataReady,
      })) recordVisualFailure(fixture, failure)
    }
  }

  // Opening a file (fetches content on demand -> requests reported).
  const searchAndRow = async (filePath: string) => {
    const search = navigator().locator("input[placeholder='Search files...']").first()
    await search.fill(filePath)
    const row = navigator().locator(`[data-file-tree-path="${filePath}"]`).first()
    await row.waitFor({ state: "visible", timeout: 3_000 })
    return row
  }
  before = await readWorkspaceTabSnapshot(page)
  const openRow = await searchAndRow(WORKSPACE_INTERACTIONS_OPEN_FILE_PATH)
  const openFile = await runPanelInteraction({
    prefix: "workspace_interactions_open_file",
    control: openRow,
    mode: { kind: "activate-file", filePath: WORKSPACE_INTERACTIONS_OPEN_FILE_PATH },
    hardZeroRequests: false,
  })
  for (const failure of workspaceInteractionTabDeltaFailures({
    interaction: "workspace_interactions_open_file",
    before,
    after: openFile.observation.tabs,
    expectedDelta: 1,
  })) recordVisualFailure(fixture, failure)

  // Closing that file (already loaded -> hard zero).
  const closeTabId = await tabIdForFile(WORKSPACE_INTERACTIONS_OPEN_FILE_PATH)
  if (!closeTabId) {
    recordVisualFailure(fixture, `workspace_interactions_close_file: no tab id for ${WORKSPACE_INTERACTIONS_OPEN_FILE_PATH}`)
  } else {
    before = await readWorkspaceTabSnapshot(page)
    const closeFile = await runPanelInteraction({
      prefix: "workspace_interactions_close_file",
      control: page
        .locator(`[data-testid='workspace-tab-close'][data-workspace-tab-id="${closeTabId}"]`)
        .locator("button")
        .first(),
      mode: { kind: "close-tab", tabId: closeTabId, openTabsBefore: before.openTabIds.length },
      hardZeroRequests: true,
    })
    for (const failure of workspaceInteractionTabDeltaFailures({
      interaction: "workspace_interactions_close_file",
      before,
      after: closeFile.observation.tabs,
      expectedDelta: -1,
    })) recordVisualFailure(fixture, failure)
  }

  // Panel resize: a trusted pointer drag on the resize separator, dragged in
  // the NARROWING direction (+x on the left-edge handle). Widening from the
  // ~70% default immediately hits the panel's readable-content clamp
  // (maxWidth = min(86% of available, available - reserved content width)),
  // which would truncate the drag; narrowing has 400+px of unclamped travel
  // above the 360px minimum. Deliberately measured BEFORE the large-file
  // open: each drag step re-lays-out the active tab at the new width, and
  // dragging a 3200-line file saturated the renderer far past the readiness
  // bound — the resize interaction measures the panel's resize path against a
  // standard-weight tab, while the large file's cost stays owned by its own
  // interaction. The completion clock includes the scripted drag itself; the
  // renderer-interval distribution during the drag is the real signal. Hard
  // zero requests.
  const widthBefore = await page.evaluate(() =>
    document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      ?.getBoundingClientRect().width ?? 0)
  const separator = page.locator("[role='separator'][aria-label='Resize workspace panel']").first()
  const resizePrepared = await prepareTrustedInteraction(page, separator, "workspace_interactions_panel_resize")
  const resize = await measureIsolatedInteraction<IsolatedInteractionObservation & { widthAfter: number }>(
    page,
    "workspace-interactions-panel-resize",
    async () => {
      await page.mouse.move(resizePrepared.x, resizePrepared.y)
      await page.mouse.down()
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(resizePrepared.x + (WORKSPACE_INTERACTIONS_RESIZE_DELTA_PX * step) / 8, resizePrepared.y)
      }
      await page.mouse.up()
      return await page.evaluate(async ({ mark, timeoutMs, widthBefore }) => {
        const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
        if (started === undefined) throw new Error("Trusted panel resize did not emit pointerdown")
        const width = () =>
          document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
            ?.getBoundingClientRect().width ?? 0
        let acknowledgedMs: number | undefined
        let stableFrames = 0
        let lastWidth = -1
        const completionMs = await new Promise<number>((resolve) => {
          const tick = () => {
            const elapsed = performance.now() - started
            const current = width()
            if (acknowledgedMs === undefined && Math.abs(current - widthBefore) > 0.5) acknowledgedMs = elapsed
            const moved = Math.abs(current - widthBefore) > 0.5
            stableFrames = moved && Math.abs(current - lastWidth) <= 0.5 ? stableFrames + 1 : moved ? 1 : 0
            lastWidth = current
            if (stableFrames >= 2 || elapsed >= timeoutMs) return resolve(elapsed)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
        performance.clearMarks(mark)
        return { completionMs, acknowledgedMs, timedOut: completionMs >= timeoutMs, widthAfter: width() }
      }, { mark: resizePrepared.mark, timeoutMs, widthBefore })
    },
  )
  metrics.push(resize.metric)
  debug.push(
    ...isolatedInteractionMetricRows("workspace_interactions_panel_resize", resize.metric, resize.observation),
    measurement("workspace_interactions_panel_resize_width_delta_px", roundMs(resize.observation.widthAfter - widthBefore), "px"),
  )
  for (const failure of [
    ...isolatedInteractionEvidenceFailures("workspace_interactions_panel_resize", resize.metric),
    ...isolatedInteractionSettleFailures("workspace_interactions_panel_resize", resize.observation),
    ...alreadyLoadedResourceRequestFailures(
      "workspace_interactions_panel_resize",
      isolatedInteractionResourceRequests(resize.metric),
    ),
    ...workspaceInteractionResizeFailures({ widthBefore, widthAfter: resize.observation.widthAfter }),
  ]) recordVisualFailure(fixture, failure)
  await settleGate("workspace_interactions_panel_resize")

  // Large-file open: much larger than the median opened file. Last, so its
  // heavyweight surface cannot bleed into any later interaction's clock.
  before = await readWorkspaceTabSnapshot(page)
  const largeRow = await searchAndRow(WORKSPACE_INTERACTIONS_LARGE_FILE_PATH)
  const openLargeFile = await runPanelInteraction({
    prefix: "workspace_interactions_open_large_file",
    control: largeRow,
    mode: { kind: "activate-file", filePath: WORKSPACE_INTERACTIONS_LARGE_FILE_PATH },
    hardZeroRequests: false,
  })
  for (const failure of workspaceInteractionTabDeltaFailures({
    interaction: "workspace_interactions_open_large_file",
    before,
    after: openLargeFile.observation.tabs,
    expectedDelta: 1,
  })) recordVisualFailure(fixture, failure)

  return { headline: mergeFrameMetrics("workspace-interactions", metrics), debug }
}
