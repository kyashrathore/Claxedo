import type { WorkspaceFixtureManifest } from "agent-app-benchmark/driver-sdk"
import { reviewLoadedDiffIdentity } from "../../src/features/review/ui/review-loaded-diff-identity"

import type { BenchmarkPage as Page } from "./agent-cdp-page"
import {
  measureSessionActivation,
  type ActivationHooks,
  type SessionReadinessTarget,
} from "./agent-browser-observer"

const READINESS_TIMEOUT_MS = 30_000
const COUNTER_START_MARK = "claxedo-public-panel-counter-start"
const COUNTER_END_MARK = "claxedo-public-panel-counter-end"

export type PanelProfile = "closed" | "files" | "diff"
export const PUBLIC_PANEL_LOAD_PROFILES = ["light", "moderate", "heavy"] as const
export const SESSION_NAVIGATION_TYPES = [
  "first-visit",
  "return-visited-panel-closed",
  "return-visited-panel-open",
] as const

export type PublicPanelLoadProfile = (typeof PUBLIC_PANEL_LOAD_PROFILES)[number]
export type SessionNavigationType = (typeof SESSION_NAVIGATION_TYPES)[number]

export type PublicPanelLoadPreset = {
  id: PublicPanelLoadProfile
  expandedDirectoryCount: number
  retainedFileTabCount: number
  expandedReviewFileCount: number
}

const REVIEW_SCROLL_SELECTOR =
  "[data-slot='session-review-scroll'][data-scrollable], [data-slot='session-review-scroll'] [data-scrollable]"
const COLLAPSE_ALL_SELECTOR = "button[aria-label='Collapse all']"

export type PublicPanelLoadPresets = Readonly<Record<PublicPanelLoadProfile, PublicPanelLoadPreset>>

export type SessionNavigationCase = {
  caseId: string
  workload: "session-navigation"
  trend: "history-size" | "panel-load"
  navigationType: SessionNavigationType
  transcriptBytes: number
  loadProfile?: PublicPanelLoadProfile
  sourceSessionId: string
  destinationSessionId: string
}

export type WorkspacePanelV2Action =
  | "open-panel"
  | "close-panel"
  | "files-to-review"
  | "review-to-files"
  | "open-file"
  | "switch-file-tab"
  | "expand-all"
  | "collapse-all"

export type WorkspacePanelV2Case = {
  caseId: string
  workload: "workspace-panel-interaction"
  action: WorkspacePanelV2Action
  loadProfile: PublicPanelLoadProfile
}

export type PanelActionCase = {
  caseId: string
  workload: "workspace-panel-action"
  action:
    | "open-cold"
    | "toggle-open-close"
    | "toggle-close-open"
    | "open-warm-data"
    | "switch-surface"
    | "open-file"
    | "switch-file-tab"
    | "toggle-diff-view"
    | "collapse-all"
    | "expand-all"
}

export type PanelSwitchCase = {
  caseId: string
  workload: "panel-session-switch"
  sessionState: "cold" | "warm"
  panelProfile: PanelProfile
  sourceSessionId: string
  destinationSessionId: string
}

export type PanelTarget = SessionReadinessTarget & {
  logicalSessionId: string
  workspaceDirectory: string
}

type Clock = {
  kind: "single-monotonic-clock"
  clock: "performance.now"
  start: number
  end: number
}

type RendererTrace = {
  clock: "performance.now"
  transitionMode: "animated" | "none"
  milestones: Array<{ id: string; at: number }>
  frameTimestampsMs: number[]
  longAnimationFrames: Array<{
    start: number
    duration: number
    blockingDuration: number
    renderStart: number
    styleAndLayoutStart: number
    scripts: Array<{
      sourceURL: string
      functionName: string
      invokerType: string
      duration: number
      forcedStyleAndLayoutDuration: number
    }>
  }>
  counterInterval: { start: number; end: number }
  counters: {
    scriptDurationMs: number
    styleRecalcDurationMs: number
    layoutDurationMs: number
    taskDurationMs: number
  }
}

type TraceEvent = {
  name?: string
  ph?: string
  ts?: number
  dur?: number
  pid?: number
  tid?: number
}

type TraceRecording = {
  events: TraceEvent[]
  complete: Promise<void>
  stopListening: () => void
}

export type FixtureEvidence = {
  manifest: WorkspaceFixtureManifest
  files: string[]
  changed: string[]
  openFiles: string[]
}

export function publicPanelLoadPresets(input: {
  scenarioDefinition?: Record<string, unknown>
  fixture: FixtureEvidence
}): PublicPanelLoadPresets {
  const cases = input.scenarioDefinition?.cases
  if (!cases || typeof cases !== "object" || Array.isArray(cases)) {
    throw new Error("Claxedo public panel scenario is missing cases")
  }
  const panelLoads = (cases as Record<string, unknown>).panelLoads
  if (!Array.isArray(panelLoads)) {
    throw new Error("Claxedo public panel scenario is missing cases.panelLoads")
  }
  if (panelLoads.length !== PUBLIC_PANEL_LOAD_PROFILES.length) {
    throw new Error("Claxedo public panel scenario must define light, moderate, and heavy load presets")
  }
  const parsed = new Map<PublicPanelLoadProfile, PublicPanelLoadPreset>()
  for (const [index, raw] of panelLoads.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Claxedo public panel load preset must be an object")
    }
    const value = raw as Record<string, unknown>
    if (!PUBLIC_PANEL_LOAD_PROFILES.includes(value.id as PublicPanelLoadProfile)) {
      throw new Error(`Claxedo public panel load preset has unknown id ${String(value.id)}`)
    }
    const id = value.id as PublicPanelLoadProfile
    if (id !== PUBLIC_PANEL_LOAD_PROFILES[index]) {
      throw new Error("Claxedo public panel load presets must be ordered light, moderate, heavy")
    }
    if (parsed.has(id)) throw new Error(`Claxedo public panel load preset ${id} is duplicated`)
    const integer = (name: keyof Omit<PublicPanelLoadPreset, "id">) => {
      const found = value[name]
      if (!Number.isSafeInteger(found) || Number(found) <= 0) {
        throw new Error(`Claxedo public panel load preset ${id}.${name} must be a positive safe integer`)
      }
      return Number(found)
    }
    const preset: PublicPanelLoadPreset = {
      id,
      expandedDirectoryCount: integer("expandedDirectoryCount"),
      retainedFileTabCount: integer("retainedFileTabCount"),
      expandedReviewFileCount: integer("expandedReviewFileCount"),
    }
    if (preset.expandedDirectoryCount > input.fixture.manifest.directories.length) {
      throw new Error(`Claxedo public panel load preset ${id} expands more directories than the fixture owns`)
    }
    if (preset.retainedFileTabCount > input.fixture.openFiles.length) {
      throw new Error(`Claxedo public panel load preset ${id} retains more canonical tabs than the fixture owns`)
    }
    if (preset.expandedReviewFileCount > input.fixture.changed.length) {
      throw new Error(`Claxedo public panel load preset ${id} expands more reviews than the fixture owns`)
    }
    parsed.set(id, preset)
  }
  if (parsed.size !== PUBLIC_PANEL_LOAD_PROFILES.length) {
    throw new Error("Claxedo public panel scenario must define light, moderate, and heavy load presets")
  }
  return Object.fromEntries(PUBLIC_PANEL_LOAD_PROFILES.map((id) => [id, parsed.get(id)!])) as PublicPanelLoadPresets
}

export function fixtureEvidence(manifest: WorkspaceFixtureManifest): FixtureEvidence {
  const files = manifest.files.map((file) => file.path)
  const changed = manifest.files.filter((file) => file.changed).map((file) => file.path)
  if (files.length === 0 || changed.length === 0 || manifest.openFilePaths.length < 2) {
    throw new Error("Claxedo public workspace fixture does not contain the required file identities")
  }
  return { manifest, files, changed, openFiles: [...manifest.openFilePaths] }
}

export async function executeWorkspacePanelAction(input: {
  page: Page
  benchmarkCase: PanelActionCase
  fixture: FixtureEvidence
}) {
  const { page, benchmarkCase, fixture } = input
  switch (benchmarkCase.action) {
    case "open-cold":
      await assertPanelNeverMounted(page)
      return measurePanelOpen(page, fixture, true)
    case "toggle-open-close":
      await ensurePanelClosed(page)
      return measureTogglePair(page, fixture, "closed")
    case "toggle-close-open":
      await ensureFilesOpen(page, fixture)
      return measureTogglePair(page, fixture, "open")
    case "open-warm-data":
      await ensurePanelClosed(page, true)
      return measurePanelOpen(page, fixture, false)
    case "switch-surface":
      await ensureFilesOpen(page, fixture)
      return measureSettledAction(page, async () => clickVisible(page, "button[aria-label='Open Changes']"), async () => {
        await waitForPanelProfile(page, "diff", fixture)
      })
    case "open-file": {
      await ensureFilesOpen(page, fixture)
      await revealFileInNavigator(page, fixture.openFiles[0]!)
      return measureSettledAction(page, async () => clickFileRow(page, fixture.openFiles[0]!), async () => {
        await waitForPaintedFile(page, fixture.openFiles[0]!)
      })
    }
    case "switch-file-tab": {
      await prepareOpenFileTabs(page, fixture)
      const [first, second] = fixture.openFiles
      await clickFileTab(page, first!)
      await waitForPaintedFile(page, first!)
      return measureSettledAction(page, async () => clickFileTab(page, second!), async () => {
        await waitForPaintedFile(page, second!)
      })
    }
    case "toggle-diff-view":
      await prepareDiffActions(page, fixture)
      await ensureDiffStyle(page, "unified")
      return measureSettledAction(page, async () => clickVisible(page, "[data-testid='review-diff-style-toggle'][data-review-next-diff-style='split']"), async () => {
        await waitForDiffState(page, fixture, { style: "split" })
      })
    case "collapse-all":
      await prepareDiffActions(page, fixture)
      await ensureAllDiffs(page, fixture, true)
      return measureSettledAction(page, async () => clickVisible(page, COLLAPSE_ALL_SELECTOR), async () => {
        await waitForDiffState(page, fixture, { openCount: 0 })
      })
    case "expand-all":
      await prepareDiffActions(page, fixture)
      await ensureAllDiffs(page, fixture, false)
      return measureSettledAction(page, async () => clickVisible(page, "button[aria-label='Expand all']"), async () => {
        await waitForDiffState(page, fixture, { openCount: fixture.changed.length })
      })
  }
}

export async function executeWorkspacePanelActionV2(input: {
  page: Page
  benchmarkCase: WorkspacePanelV2Case
  fixture: FixtureEvidence
  preset: PublicPanelLoadPreset
}) {
  const { page, benchmarkCase, fixture, preset } = input
  await seedPanelLoad(page, fixture, preset)
  switch (benchmarkCase.action) {
    case "open-panel":
      await ensureFilesOpen(page, fixture)
      await ensurePanelClosed(page, true)
      return measurePanelOpen(page, fixture, false)
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
      await prepareDataWarmFileOpen(page, fixture, preset, file)
      return measurePrearmedSettledAction(
        page,
        async () => waitForPaintedFile(page, file, true),
        async () => clickFileRow(page, file),
      )
    }
    case "switch-file-tab": {
      await ensureFilesOpen(page, fixture)
      const [first, second] = fixture.openFiles
      await clickFileTab(page, first!)
      await waitForPaintedFile(page, first!)
      return measurePrearmedSettledAction(
        page,
        async () => waitForPaintedFile(page, second!, true),
        async () => clickFileTab(page, second!),
      )
    }
    case "expand-all": {
      await ensureDiffOpen(page, fixture)
      await ensureAllDiffs(page, fixture, false)
      await page.evaluate(() => { (window as any).__diffStateLog = [] })
      const measured = await measurePrearmedSettledAction(
        page,
        async () => waitForDiffState(page, fixture, { openCount: fixture.changed.length }, true),
        async () => clickVisible(page, "button[aria-label='Expand all']"),
      )
      const logPath = process.env["CLAXEDO_DIFF_STATE_LOG"]
      if (logPath) {
        const frames = await page.evaluate(() => (window as any).__diffStateLog ?? [])
        const fs = await import("node:fs/promises")
        await fs.appendFile(logPath, JSON.stringify({ case: benchmarkCase, preset: preset.id, frames }) + "\n")
      }
      return measured
    }
    case "collapse-all":
      await ensureDiffOpen(page, fixture)
      await ensureReviewExpansionCount(page, fixture, preset.expandedReviewFileCount)
      return measurePrearmedSettledAction(
        page,
        async () => waitForDiffState(page, fixture, { openCount: 0 }, true),
        async () => clickVisible(page, COLLAPSE_ALL_SELECTOR),
      )
  }
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
    await activateExact(page, source)
    await ensurePanelClosed(page, true)
    return measureNavigation(page, destination)
  }

  if (benchmarkCase.navigationType === "return-visited-panel-closed") {
    await ensurePanelClosed(page, true)
    await activateExact(page, source)
    await ensurePanelClosed(page, true)
    return measureNavigation(page, destination)
  }

  if (!preset) throw new Error("Claxedo panel-open session navigation requires a load preset")
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
  return measureNavigation(page, destination, {
    fixture,
    profile: "diff",
    expectedReviewOpenCount: preset.expandedReviewFileCount,
  })
}

export async function executeWorkspacePanelSwitch(input: {
  page: Page
  benchmarkCase: PanelSwitchCase
  source: PanelTarget
  destination: PanelTarget
  fixture: FixtureEvidence
}) {
  const { page, benchmarkCase, source, destination, fixture } = input
  await ensurePanelProfile(page, benchmarkCase.panelProfile, fixture)
  if (benchmarkCase.sessionState === "warm") {
    await activateExact(page, destination)
    await ensurePanelProfile(page, benchmarkCase.panelProfile, fixture)
    await waitForPanelOwner(page, benchmarkCase.panelProfile, destination, fixture)
  }
  await activateExact(page, source)
  // A previously visited session may restore its own focus/working-set state
  // after activation. Establish the requested workbench presentation on the
  // actual source session so the timed click starts from the declared profile,
  // rather than from a stale surface that happened to be visible pre-switch.
  await ensurePanelProfile(page, benchmarkCase.panelProfile, fixture)
  await waitForPanelOwner(page, benchmarkCase.panelProfile, source, fixture)

  const recording = await beginTrace(page)
  try {
    const session = await activateExact(page, destination)
    const sessionReady = session.paintedAtMs
    const panelReady = await waitForPanelOwner(page, benchmarkCase.panelProfile, destination, fixture)
    await addMilestones(page, [
      { id: "session-ready", at: sessionReady },
      { id: "panel-ready", at: panelReady },
      { id: "content-identity", at: sessionReady },
      { id: "above-fold-painted", at: Math.max(sessionReady, panelReady) },
    ])
    return await finishMeasuredTrace(page, recording)
  } catch (error) {
    await abortTrace(page, recording)
    throw error
  }
}

async function measurePanelOpen(page: Page, fixture: FixtureEvidence, cold: boolean) {
  const recording = await beginTrace(page, { openFilesExpectedCount: fixture.files.length })
  try {
    if (cold) await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Open workspace panel']")
    else await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Open workspace panel']")
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

async function measureTogglePair(page: Page, fixture: FixtureEvidence, initial: "open" | "closed") {
  const recording = await beginTrace(page)
  try {
    const first = `[data-testid='workspace-panel-toggle'][aria-label='${initial === "open" ? "Close" : "Open"} workspace panel']`
    const second = `[data-testid='workspace-panel-toggle'][aria-label='${initial === "open" ? "Open" : "Close"} workspace panel']`
    await clickVisible(page, first)
    await waitForVisibleSelector(page, second)
    await clickVisible(page, second)
    const finalState = initial === "closed"
      ? await waitForPanelClosed(page)
      : (await waitForOpenFiles(page, fixture)).aboveFoldPainted
    const secondInput = await readLastTrustedInput(page)
    await addMilestones(page, [
      { id: "second-toggle-input", at: secondInput },
      { id: "final-state-presented", at: finalState },
      { id: "animation-settled", at: finalState },
    ])
    return await finishMeasuredTrace(page, recording)
  } catch (error) {
    await abortTrace(page, recording)
    throw error
  }
}

async function measureSettledAction(page: Page, click: () => Promise<void>, ready: () => Promise<void>) {
  const recording = await beginTrace(page)
  try {
    await click()
    await ready()
    await addMilestones(page, [{ id: "action-painted", at: await twoPresentationTimestamp(page) }])
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

async function seedPanelLoad(page: Page, fixture: FixtureEvidence, preset: PublicPanelLoadPreset) {
  await ensureFilesOpen(page, fixture)
  await retainCanonicalFileTabs(page, fixture, preset.retainedFileTabCount)
  await seedExpandedDirectories(page, fixture, preset.expandedDirectoryCount)
  await ensureDiffOpen(page, fixture)
  await ensureReviewExpansionCount(page, fixture, preset.expandedReviewFileCount)
}

async function seedExpandedDirectories(page: Page, fixture: FixtureEvidence, count: number) {
  await collapseVisibleDirectories(page)
  for (const directory of fixture.manifest.directories.slice(0, count)) {
    const file = fixture.files.find((candidate) => candidate.startsWith(`${directory}/`))
    if (!file) throw new Error(`Claxedo public panel fixture has no file below ${directory}`)
    await revealFileInNavigator(page, file)
  }
}

async function collapseVisibleDirectories(page: Page) {
  for (;;) {
    const found = await page.evaluate(() => {
      const visible = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-testid='workspace-files-navigator'][data-mode='files'] [role='treeitem'][aria-expanded='true']",
      )).filter((row) => {
        const rect = row.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && getComputedStyle(row).visibility !== "hidden"
      })
      if (visible.length === 0) return -1
      let selected = 0
      let level = -1
      visible.forEach((row, index) => {
        const current = Number(row.getAttribute("aria-level") ?? 0)
        if (current >= level) { selected = index; level = current }
      })
      return selected
    })
    if (found < 0) return
    await page.locator(
      "[data-testid='workspace-files-navigator'][data-mode='files'] [role='treeitem'][aria-expanded='true']",
    ).nth(found).click()
    await twoPresentationTimestamp(page)
  }
}

async function retainCanonicalFileTabs(page: Page, fixture: FixtureEvidence, count: number) {
  const desired = fixture.openFiles.slice(0, count)
  for (const file of desired) {
    if (await hasFileTab(page, file)) continue
    await revealFileInNavigator(page, file)
    await clickFileRow(page, file)
    await waitForPaintedFile(page, file)
  }
  for (;;) {
    const extra = await page.evaluate((basenames) => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-slot='workspace-tab'][data-workspace-tab-kind='file']",
      ))
      return tabs.findIndex((tab) => !basenames.some((basename) => tab.innerText.includes(basename)))
    }, desired.map((file) => file.slice(file.lastIndexOf("/") + 1)))
    if (extra < 0) break
    const tab = page.locator("[data-slot='workspace-tab'][data-workspace-tab-kind='file']").nth(extra)
    await tab.locator("button").click()
    await tab.locator("[data-testid='workspace-tab-close'] button").click()
    await twoPresentationTimestamp(page)
  }
}

function actionFile(fixture: FixtureEvidence, preset: PublicPanelLoadPreset) {
  const retainedByAnyProfile = new Set(fixture.openFiles)
  const candidates = fixture.files.filter((candidate) => !retainedByAnyProfile.has(candidate))
  const file = candidates[PUBLIC_PANEL_LOAD_PROFILES.indexOf(preset.id)]
  if (!file) throw new Error(`Claxedo public panel fixture has no distinct ${preset.id} action file`)
  return file
}

async function prepareDataWarmFileOpen(
  page: Page,
  fixture: FixtureEvidence,
  preset: PublicPanelLoadPreset,
  file: string,
) {
  // Workspace interaction cases run after their authoritative data is ready.
  // A deliberate row hover uses the product's canonical request cache without
  // ever mounting the target TabFile; the trusted click still owns first
  // surface creation and painting.
  await retainCanonicalFileTabs(page, fixture, preset.retainedFileTabCount)
  await revealFileInNavigator(page, file)
  await assertFileSurfaceAbsent(page, file)
  await (await fileRowLocator(page, file)).hover()
  await page.waitForFunction((expected) => {
    const navigator = document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    return navigator?.dataset.filePrefetchPath === expected && ["ready", "error"].includes(navigator.dataset.filePrefetchState ?? "")
  }, file, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
  const prefetchState = await page.evaluate(() =>
    document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")?.dataset.filePrefetchState
  )
  if (prefetchState !== "ready") throw new Error(`Claxedo file prefetch failed: ${file}`)
  await assertFileSurfaceAbsent(page, file)
}

async function assertFileSurfaceAbsent(page: Page, file: string) {
  await twoPresentationTimestamp(page)
  const state = await page.evaluate((expected) => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-slot='workspace-tab'][data-workspace-tab-kind='file']"))
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='tab-file-root']"))
    const matches = (candidate: string) => candidate === expected || candidate.endsWith(`/${expected}`)
    return {
      tab: tabs.some((tab) => matches(tab.dataset.workspaceTabId ?? "") || tab.innerText.includes(expected.slice(expected.lastIndexOf("/") + 1))),
      root: roots.some((root) => matches(root.dataset.tabFilePath ?? "")),
    }
  }, file)
  if (state.tab || state.root) throw new Error(`Claxedo data-warm open-file target surface was mounted: ${file}; ${JSON.stringify(state)}`)
}

async function ensureReviewExpansionCount(page: Page, fixture: FixtureEvidence, count: number) {
  await ensureAllDiffs(page, fixture, false)
  if (count === 0) return
  if (count === fixture.changed.length) {
    await clickVisible(page, "button[aria-label='Expand all']")
    await waitForDiffState(page, fixture, { openCount: count })
    return
  }
  throw new Error(
    `Claxedo workspace-panel benchmark does not support partial Review expansion without scrolling: ${count}/${fixture.changed.length}`,
  )
}

async function ensurePanelProfile(page: Page, profile: PanelProfile, fixture: FixtureEvidence) {
  if (profile === "closed") return ensurePanelClosed(page)
  if (profile === "files") return ensureFilesOpen(page, fixture)
  return ensureDiffOpen(page, fixture)
}

async function ensureFilesOpen(page: Page, fixture: FixtureEvidence) {
  const state = await panelState(page)
  if (!state.open) {
    const files = await optionalVisibleLocator(page, "button[aria-label='Open Files']")
    if (files) await files.click()
    else {
      // A cold session can paint before workspace-backed toolbar actions are
      // available. The generic toggle preserves the last navigator by design,
      // so opening from a prior Changes profile is only step one: once the
      // workspace header exists, select Files explicitly before readiness.
      await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Open workspace panel']")
      await waitForVisibleSelector(page, "button[aria-label='Open Files'], button[aria-label='Close Files']")
      if ((await panelState(page)).navigator !== "files") {
        await clickVisible(page, "button[aria-label='Open Files']")
      }
    }
  } else if (state.navigator !== "files") {
    await clickVisible(page, "button[aria-label='Open Files']")
  }
  await waitForPanelProfile(page, "files", fixture)
}

async function ensureDiffOpen(page: Page, fixture: FixtureEvidence) {
  await ensureFilesOpen(page, fixture)
  const state = await panelState(page)
  if (state.navigator !== "changes") await clickVisible(page, "button[aria-label='Open Changes']")
  const reviewTab = await optionalVisibleLocator(page, "[data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button")
  if (reviewTab) await reviewTab.click()
  await waitForPanelProfile(page, "diff", fixture)
}

async function ensurePanelClosed(page: Page, requireDisposed = false) {
  if ((await panelState(page)).open) {
    await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Close workspace panel']")
  }
  await waitForPanelClosed(page)
  if (requireDisposed) {
    await Bun.sleep(180)
    const owned = await page.evaluate(() => document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='workspace-files-navigator'], [data-testid='workspace-panel-shell'] [data-testid='review-pane-root']").length)
    if (owned !== 0) throw new Error(`Claxedo closed panel retained ${owned} heavy surface roots`)
  }
}

async function assertPanelNeverMounted(page: Page) {
  const state = await page.evaluate(() => ({
    shell: !!document.querySelector("[data-testid='workspace-panel-shell']"),
    heavy: !!document.querySelector("[data-testid='workspace-files-navigator'], [data-testid='review-pane-root']"),
  }))
  if (state.shell || state.heavy) throw new Error("Claxedo cold panel precondition found an already-mounted panel surface")
}

async function panelState(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
    const navigator = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator']"))
      .find((item) => item.getBoundingClientRect().width > 0 && getComputedStyle(item).visibility !== "hidden")
    return {
      open: shell?.dataset.open === "true",
      navigator: navigator?.dataset.mode ??
        (document.querySelector("button[aria-label='Close Changes'][aria-pressed='true']") ? "changes" : undefined),
    }
  })
}

async function waitForOpenFiles(page: Page, fixture: FixtureEvidence, requireActiveTrace = false) {
  return page.evaluate(async ({ expectedFiles, requireActiveTrace }) => {
    const deadline = performance.now() + 30_000
    let shellVisible: number | undefined
    let animationSettled: number | undefined
    let dataReady: number | undefined
    let aboveFoldPainted: number | undefined
    let lastSignature = ""
    let stable = 0
    return new Promise<{ shellVisible: number; animationSettled: number; dataReady: number; aboveFoldPainted: number }>((resolve, reject) => {
      const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      }
      const frame = (at: number) => {
        const trace = (window as any).__claxedoPublicPanelTrace
        if (requireActiveTrace) {
          if (!trace?.active) return reject(new Error("Claxedo prearmed Files readiness observer lost its active trace"))
          if (!Number.isFinite(trace.trustedInputAt)) {
            requestAnimationFrame(frame)
            return
          }
        }
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        if (shell && visible(shell) && shellVisible === undefined) shellVisible = at
        if (shell?.dataset.shellSettled === "true" && animationSettled === undefined) animationSettled = at
        const navigator = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']") ?? [])
          .find((element) => visible(element))
        const rows = navigator?.querySelectorAll("[data-file-tree-path], [data-component='filetree'] button").length ?? 0
        const ready = !!navigator && visible(navigator) && navigator.dataset.fileTreeDataReady === "true" && rows > 0 && !navigator.querySelector("[data-file-tree-loading], [aria-label='Loading files']")
        if (ready && dataReady === undefined) dataReady = at
        const signature = ready ? JSON.stringify([shell?.dataset.stateWorkspaceDir, rows, navigator?.innerText.length, expectedFiles]) : ""
        stable = ready && shellVisible !== undefined && signature === lastSignature ? stable + 1 : ready ? 1 : 0
        lastSignature = signature
        if (stable >= 2 && aboveFoldPainted === undefined) aboveFoldPainted = at
        if (shellVisible !== undefined && animationSettled !== undefined && dataReady !== undefined && aboveFoldPainted !== undefined) {
          resolve({ shellVisible, animationSettled, dataReady, aboveFoldPainted })
          return
        }
        if (performance.now() >= deadline) return reject(new Error(`Claxedo Files panel did not reach stable above-fold readiness: ${JSON.stringify({
          shell: shell ? { ...shell.dataset } : undefined,
          navigator: navigator ? { ...navigator.dataset } : undefined,
          rows,
          stable,
        })}`))
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, { expectedFiles: fixture.files.length, requireActiveTrace })
}

async function waitForPanelProfile(
  page: Page,
  profile: Exclude<PanelProfile, "closed">,
  fixture: FixtureEvidence,
  expectedReviewOpenCount?: number,
  requireActiveTrace = false,
) {
  if (profile === "files") return (await waitForOpenFiles(page, fixture, requireActiveTrace)).aboveFoldPainted
  return page.evaluate(async ({ changed, expectedReviewOpenCount, expectedReviewIdentity, requireActiveTrace, scrollSelector }) => {
    const deadline = performance.now() + 30_000
    let prior = ""
    let stable = 0
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
        const trace = (window as any).__claxedoPublicPanelTrace
        if (requireActiveTrace) {
          if (!trace?.active) return reject(new Error("Claxedo prearmed Review readiness observer lost its active trace"))
          if (!Number.isFinite(trace.trustedInputAt)) {
            requestAnimationFrame(frame)
            return
          }
        }
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        const root = shell?.querySelector<HTMLElement>("[data-testid='review-pane-root']")
        const corpus = root?.querySelector<HTMLElement>("[data-review-total-files]")
        const state = root?.querySelector<HTMLElement>("[data-review-diff-style]")
        const rendered = Number(corpus?.dataset.reviewRenderedFiles)
        const openCount = Number(state?.dataset.reviewOpenDiffCount ?? -1)
        const loadedCount = Number(state?.dataset.reviewLoadedDiffCount ?? -1)
        const canonicalRows = Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
          .filter((row) => changed.includes(row.dataset.reviewFile ?? ""))
        const expandedRows = canonicalRows.filter((row) =>
          !!row.querySelector("[aria-expanded='true']") || !!row.shadowRoot?.querySelector("[aria-expanded='true']")
        )
        const viewportRect = root?.querySelector<HTMLElement>(scrollSelector)
          ?.getBoundingClientRect()
        const visibleExpandedRows = expandedRows.filter((row) => {
          const rect = row.getBoundingClientRect()
          return !!viewportRect && rect.width > 0 && rect.height > 0 &&
            rect.bottom > viewportRect.top && rect.right > viewportRect.left &&
            rect.top < viewportRect.bottom && rect.left < viewportRect.right
        })
        const paintedRows = visibleExpandedRows.filter((row) => {
          const rowRect = row.getBoundingClientRect()
          const viewer = row.querySelector<HTMLElement>("diffs-container")
          const viewerRoot = viewer?.shadowRoot ?? row.shadowRoot
          if (viewerRoot) {
            return rowRect.width > 0 && rowRect.height > 0 && !!viewerRoot.querySelector("[data-line]")
          }
          const content = row.querySelector<HTMLElement>("[data-slot='session-review-accordion-content']")
          const wrapper = content?.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
          const rect = content?.getBoundingClientRect()
          const style = content ? getComputedStyle(content) : undefined
          return !!content && !!wrapper && !!rect && rect.width > 0 && rect.height > 0 &&
            style?.display !== "none" && style?.visibility !== "hidden" &&
            !wrapper.querySelector("[data-slot='session-review-diff-placeholder']")
        })
        const expansionReady = expectedReviewOpenCount === undefined ||
          (openCount === expectedReviewOpenCount &&
            (expectedReviewOpenCount === 0
              ? expandedRows.length === 0 && root?.querySelectorAll("[data-slot='session-review-accordion-content']").length === 0
              : visibleExpandedRows.length > 0 && paintedRows.length === visibleExpandedRows.length &&
                Number(state?.dataset.reviewRenderedHunks ?? 0) > 0))
        const ready = shell?.dataset.shellSettled === "true" && shell.dataset.stateMode === "review" && !!root &&
          Number(corpus?.dataset.reviewTotalFiles) === changed.length && loadedCount === changed.length &&
          state?.dataset.reviewLoadedDiffIdentity === expectedReviewIdentity && rendered > 0 &&
          rendered === canonicalRows.length && expansionReady &&
          !root.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
        const signature = ready ? JSON.stringify([rendered, openCount, expandedRows.length, visibleExpandedRows.length, paintedRows.length, root.innerText.length]) : ""
        stable = ready && signature === prior ? stable + 1 : ready ? 1 : 0
        prior = signature
        const tracedPresentations = requireActiveTrace
          ? trace.frames.filter((frameAt: number) => frameAt >= trace.trustedInputAt && frameAt <= at).length
          : 2
        if (stable >= 2 && tracedPresentations >= 2) return resolve(at)
        if (performance.now() >= deadline) return reject(new Error(`Claxedo Diff panel did not reach stable canonical readiness: ${JSON.stringify({
          shell: shell ? { ...shell.dataset } : undefined,
          root: root ? { ...root.dataset } : undefined,
          corpus: corpus ? { ...corpus.dataset } : undefined,
          rendered,
          stable,
        })}`))
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, {
    changed: fixture.changed,
    expectedReviewOpenCount,
    expectedReviewIdentity: reviewLoadedDiffIdentity(fixture.changed),
    requireActiveTrace,
    scrollSelector: REVIEW_SCROLL_SELECTOR,
  })
}

async function waitForPanelClosed(page: Page, requireActiveTrace = false) {
  return page.evaluate(async (mustHaveTrace) => {
    const deadline = performance.now() + 30_000
    let stable = 0
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
        const trace = (window as any).__claxedoPublicPanelTrace
        if (mustHaveTrace) {
          if (!trace?.active) return reject(new Error("Claxedo prearmed panel-close observer lost its active trace"))
          if (!Number.isFinite(trace.trustedInputAt)) {
            requestAnimationFrame(frame)
            return
          }
        }
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
        const rect = shell?.getBoundingClientRect()
        const closed = !shell || (shell.dataset.open === "false" && !!rect && rect.left >= window.innerWidth - 1)
        stable = closed ? stable + 1 : 0
        const tracedPresentations = mustHaveTrace
          ? trace.frames.filter((frameAt: number) => frameAt >= trace.trustedInputAt && frameAt <= at).length
          : 2
        if (stable >= 2 && tracedPresentations >= 2) return resolve(at)
        if (performance.now() >= deadline) return reject(new Error(`Claxedo workspace panel did not close: ${JSON.stringify(shell ? {
          data: { ...shell.dataset },
          rect: rect ? { left: rect.left, right: rect.right, width: rect.width } : undefined,
          transform: getComputedStyle(shell).transform,
          transition: getComputedStyle(shell).transition,
        } : { disposed: true })}`))
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, requireActiveTrace)
}

export async function waitForPanelOwner(
  page: Page,
  profile: PanelProfile,
  target: PanelTarget,
  fixture: FixtureEvidence,
  options: { markEnd?: boolean; expectedReviewOpenCount?: number; observerToken?: string } = {},
) {
  return page.evaluate(async ({
    profile,
    sessionId,
    directory,
    files,
    changed,
    endMark,
    markEnd,
    expectedReviewOpenCount,
    expectedReviewIdentity,
    observerToken,
    scrollSelector,
  }) => {
    const deadline = performance.now() + 30_000
    let stable = 0
    let previousSignature = ""
    return new Promise<number>((resolve, reject) => {
      const browser = window as typeof window & { __claxedoPanelOwnerObservers?: Map<string, () => void> }
      const observers = browser.__claxedoPanelOwnerObservers ??= new Map()
      let frameRequest = 0
      let settled = false
      const cleanup = () => {
        if (frameRequest) cancelAnimationFrame(frameRequest)
        if (observerToken) observers.delete(observerToken)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const complete = (at: number) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(at)
      }
      if (observerToken) observers.set(observerToken, () => fail(new Error("Claxedo panel owner observer was cancelled")))
      const frame = (at: number) => {
        const trace = (window as any).__claxedoPublicPanelTrace
        if (trace?.active && !Number.isFinite(trace.trustedInputAt)) {
          frameRequest = requestAnimationFrame(frame)
          return
        }
        const visible = (element: HTMLElement | null | undefined) => {
          if (!element) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
        let ready = false
        let signature = ""
        if (profile === "closed") {
          const rect = shell?.getBoundingClientRect()
          const heavyRoots = shell?.querySelectorAll("[data-testid='workspace-files-navigator'], [data-testid='review-pane-root']").length ?? 0
          ready = (!shell || (shell.dataset.open === "false" && shell.dataset.stateOpen === "false" && !!rect && rect.left >= innerWidth - 1)) && heavyRoots === 0
          signature = ready ? JSON.stringify([shell?.dataset.open ?? "disposed", heavyRoots]) : ""
        } else {
          const body = shell?.querySelector<HTMLElement>(`[data-workspace-panel-session-id="${CSS.escape(sessionId)}"]`)
          const ownerExact = shell?.dataset.open === "true" &&
            shell.dataset.shellSettled === "true" &&
            shell.dataset.stateWorkspaceDir === directory &&
            visible(shell) &&
            !!body &&
            body.dataset.workspacePanelSessionId === sessionId
          if (profile === "files") {
            const navigator = body?.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
            const renderedPaths = Array.from(navigator?.querySelectorAll<HTMLElement>("[data-file-tree-path], [data-file-tree-row]") ?? [])
              .map((row) => row.dataset.fileTreePath ?? row.dataset.fileTreeRow)
              .filter((path): path is string => !!path)
            const canonicalPath = renderedPaths.some((path) => files.some((file) => file === path || file.startsWith(`${path.replace(/\/$/u, "")}/`)))
            ready = ownerExact &&
              shell?.dataset.stateNavigator === "files" &&
              visible(navigator) &&
              navigator?.dataset.fileTreeDataReady === "true" &&
              renderedPaths.length > 0 &&
              canonicalPath &&
              !navigator?.querySelector("[data-file-tree-loading], [aria-label='Loading files']")
            signature = ready ? JSON.stringify([directory, sessionId, renderedPaths, navigator?.innerText.length]) : ""
          } else {
            const root = body?.querySelector<HTMLElement>("[data-testid='review-pane-root']")
            const corpus = root?.querySelector<HTMLElement>("[data-review-total-files]")
            const renderedFiles = Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
              .map((row) => row.dataset.reviewFile)
              .filter((path): path is string => !!path)
            const canonicalFile = renderedFiles.some((path) => changed.includes(path))
            const state = root?.querySelector<HTMLElement>("[data-review-diff-style]")
            const openCount = Number(state?.dataset.reviewOpenDiffCount ?? -1)
            const loadedCount = Number(state?.dataset.reviewLoadedDiffCount ?? -1)
            const canonicalRows = Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
              .filter((row) => changed.includes(row.dataset.reviewFile ?? ""))
            const expandedRows = canonicalRows.filter((row) =>
              !!row.querySelector("[aria-expanded='true']") || !!row.shadowRoot?.querySelector("[aria-expanded='true']")
            )
            const viewportRect = root?.querySelector<HTMLElement>(scrollSelector)
              ?.getBoundingClientRect()
            const visibleExpandedRows = expandedRows.filter((row) => {
              const rect = row.getBoundingClientRect()
              return !!viewportRect && rect.width > 0 && rect.height > 0 &&
                rect.bottom > viewportRect.top && rect.right > viewportRect.left &&
                rect.top < viewportRect.bottom && rect.left < viewportRect.right
            })
            const paintedRows = visibleExpandedRows.filter((row) => {
              const rowRect = row.getBoundingClientRect()
              const viewer = row.querySelector<HTMLElement>("diffs-container")
              const viewerRoot = viewer?.shadowRoot ?? row.shadowRoot
              if (viewerRoot) {
                return rowRect.width > 0 && rowRect.height > 0 && !!viewerRoot.querySelector("[data-line]")
              }
              const content = row.querySelector<HTMLElement>("[data-slot='session-review-accordion-content']")
              const wrapper = content?.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
              const rect = content?.getBoundingClientRect()
              const style = content ? getComputedStyle(content) : undefined
              return !!content && !!wrapper && !!rect && rect.width > 0 && rect.height > 0 &&
                style?.display !== "none" && style?.visibility !== "hidden" &&
                !wrapper.querySelector("[data-slot='session-review-diff-placeholder']")
            })
            const expansionReady = expectedReviewOpenCount === undefined ||
              (openCount === expectedReviewOpenCount &&
                (expectedReviewOpenCount === 0
                  ? expandedRows.length === 0 && root?.querySelectorAll("[data-slot='session-review-accordion-content']").length === 0
                  : visibleExpandedRows.length > 0 && paintedRows.length === visibleExpandedRows.length &&
                    Number(state?.dataset.reviewRenderedHunks ?? 0) > 0))
            ready = ownerExact &&
              shell?.dataset.stateNavigator === "changes" &&
              visible(root) &&
              Number(corpus?.dataset.reviewTotalFiles) === changed.length &&
              loadedCount === changed.length &&
              state?.dataset.reviewLoadedDiffIdentity === expectedReviewIdentity &&
              Number(corpus?.dataset.reviewRenderedFiles) === canonicalRows.length &&
              canonicalRows.length > 0 &&
              renderedFiles.length > 0 &&
              canonicalFile &&
              expansionReady &&
              !root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
            signature = ready ? JSON.stringify([
              directory,
              sessionId,
              state?.dataset.reviewLoadedDiffIdentity,
              renderedFiles,
              openCount,
              expandedRows.length,
              visibleExpandedRows.length,
              paintedRows.length,
              root?.innerText.length,
            ]) : ""
          }
        }
        stable = ready && signature === previousSignature ? stable + 1 : ready ? 1 : 0
        previousSignature = signature
        if (stable >= 2) {
          const trace = (window as any).__claxedoPublicPanelTrace
          const terminal = trace?.active && markEnd
            ? (performance.clearMarks(endMark), performance.mark(endMark).startTime)
            : at
          return complete(terminal)
        }
        if (performance.now() >= deadline) return fail(new Error(`Claxedo workspace panel did not reach atomic destination readiness: ${JSON.stringify({
          profile,
          shell: shell ? { ...shell.dataset } : undefined,
          signature,
          stable,
        })}`))
        frameRequest = requestAnimationFrame(frame)
      }
      frameRequest = requestAnimationFrame(frame)
    })
  }, {
    profile,
    sessionId: target.sessionId,
    directory: target.workspaceDirectory,
    files: fixture.files,
    changed: fixture.changed,
    endMark: COUNTER_END_MARK,
    markEnd: options.markEnd ?? true,
    expectedReviewOpenCount: options.expectedReviewOpenCount,
    expectedReviewIdentity: reviewLoadedDiffIdentity(fixture.changed),
    observerToken: options.observerToken,
    scrollSelector: REVIEW_SCROLL_SELECTOR,
  })
}

async function cancelPanelOwnerObserver(page: Page, observerToken: string) {
  await page.evaluate((token) => {
    const browser = window as typeof window & { __claxedoPanelOwnerObservers?: Map<string, () => void> }
    browser.__claxedoPanelOwnerObservers?.get(token)?.()
  }, observerToken).catch(() => undefined)
}

async function revealFileInNavigator(page: Page, file: string) {
  const clear = await optionalVisibleLocator(page, "[data-testid='workspace-files-navigator'][data-mode='files'] button[aria-label='Clear search']")
  if (clear) await clear.click()
  const segments = file.split("/")
  for (let index = 0; index < segments.length - 1; index += 1) {
    const directory = await directoryRowLocator(page, segments[index]!, index + 1)
    if ((await directory.getAttribute("aria-expanded")) !== "true") await directory.click()
  }
  await waitForTreePath(page, file)
}

async function clickFileRow(page: Page, file: string) {
  await (await fileRowLocator(page, file)).click()
}

async function waitForPaintedFile(page: Page, file: string, requireActiveTrace = false) {
  return page.evaluate(async ({ expected, requireActiveTrace }) => {
    const deadline = performance.now() + 30_000
    let previous = ""
    let stable = 0
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
        const trace = (window as any).__claxedoPublicPanelTrace
        if (requireActiveTrace) {
          if (!trace?.active) return reject(new Error("Claxedo prearmed file readiness observer lost its active trace"))
          if (!Number.isFinite(trace.trustedInputAt)) {
            requestAnimationFrame(frame)
            return
          }
        }
        const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='tab-file-root']"))
        const element = roots.find((candidate) => {
          const path = candidate.dataset.tabFilePath ?? ""
          return (path === expected || path.endsWith(`/${expected}`)) && candidate.dataset.tabFileState === "ready" && candidate.dataset.tabFileRenderState === "painted"
        })
        const rect = element?.getBoundingClientRect()
        const ready = !!element && !!rect && rect.width > 0 && rect.height > 0 && !!element.dataset.tabFileRenderedCacheKey && Number(element.dataset.tabFileContentChars) > 0
        const signature = ready ? JSON.stringify([rect.width, rect.height, element.dataset.tabFileRenderedCacheKey]) : ""
        stable = ready && signature === previous ? stable + 1 : ready ? 1 : 0
        previous = signature
        const tracedPresentations = requireActiveTrace
          ? trace.frames.filter((frameAt: number) => frameAt >= trace.trustedInputAt && frameAt <= at).length
          : 2
        if (stable >= 2 && tracedPresentations >= 2) return resolve(at)
        if (performance.now() >= deadline) {
          const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']"))
            .map((tab) => ({
              id: tab.dataset.workspaceTabId,
              kind: tab.dataset.workspaceTabKind,
              selected: tab.dataset.selected,
              label: tab.innerText.trim(),
            }))
          const fileRoots = roots.map((root) => {
            const rootRect = root.getBoundingClientRect()
            return {
              path: root.dataset.tabFilePath,
              state: root.dataset.tabFileState,
              renderState: root.dataset.tabFileRenderState,
              contentChars: root.dataset.tabFileContentChars,
              renderedCacheKey: root.dataset.tabFileRenderedCacheKey,
              visible: rootRect.width > 0 && rootRect.height > 0,
            }
          })
          return reject(new Error(`Claxedo file did not reach painted readiness: ${expected}; ${JSON.stringify({ tabs, fileRoots })}`))
        }
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, { expected: file, requireActiveTrace })
}

async function fileRowLocator(page: Page, file: string) {
  const exact = `[data-file-tree-path=${JSON.stringify(file)}]`
  const absolute = `[data-file-tree-path$=${JSON.stringify(`/${file}`)}]`
  const locator = page.locator(
    `[data-testid='workspace-files-navigator'][data-mode='files'] :is(${exact}, ${absolute})`,
  )
  await locator.waitFor({ state: "visible" })
  const count = await locator.count()
  if (count !== 1) throw new Error(`Claxedo expected one visible canonical file row for ${file}, found ${count}`)
  return locator
}

async function directoryRowLocator(page: Page, label: string, level: number) {
  const selector = `[data-testid='workspace-files-navigator'][data-mode='files'] [role='treeitem'][aria-level='${level}']`
  try {
    await page.waitForFunction(({ selector: query, expected }) => Array.from(document.querySelectorAll<HTMLElement>(query))
      .some((row) => {
        const rect = row.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && row.innerText.trim().split(/\s+/u).includes(expected)
      }), { selector, expected: label }, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
  } catch {
    throw new Error(`Claxedo directory row did not appear: level=${level} label=${label}`)
  }
  const index = await indexByText(page, selector, label, true)
  if (index < 0) throw new Error(`Claxedo has no visible directory row for ${label}`)
  return page.locator(selector).nth(index)
}

async function waitForTreePath(page: Page, expected: string) {
  try {
    await page.waitForFunction((pathExpected) => Array.from(document.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path]"))
      .some((row) => {
        const path = row.dataset.fileTreePath ?? ""
        const rect = row.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && (path === pathExpected || path.endsWith(`/${pathExpected}`))
      }), expected, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
  } catch {
    throw new Error(`Claxedo tree path did not appear: ${expected}`)
  }
}

async function prepareOpenFileTabs(page: Page, fixture: FixtureEvidence) {
  await ensureFilesOpen(page, fixture)
  for (const file of fixture.openFiles) {
    if (await hasFileTab(page, file)) continue
    await revealFileInNavigator(page, file)
    await clickFileRow(page, file)
    await waitForPaintedFile(page, file)
  }
}

async function hasFileTab(page: Page, file: string) {
  const basename = file.slice(file.lastIndexOf("/") + 1)
  return (await indexByText(page, "[data-slot='workspace-tab'][data-workspace-tab-kind='file']", basename)) !== -1
}

async function clickFileTab(page: Page, file: string) {
  const basename = file.slice(file.lastIndexOf("/") + 1)
  const selector = "[data-slot='workspace-tab'][data-workspace-tab-kind='file']"
  const index = await indexByText(page, selector, basename, true)
  if (index < 0) throw new Error(`Claxedo has no visible file tab for ${file}`)
  await page.locator(selector).nth(index).locator("button").click()
}

async function prepareDiffActions(page: Page, fixture: FixtureEvidence) {
  await ensureDiffOpen(page, fixture)
  const reviewTab = await optionalVisibleLocator(page, "[data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button")
  if (reviewTab) await reviewTab.click()
  await waitForPanelProfile(page, "diff", fixture)
}

async function ensureDiffStyle(page: Page, style: "unified" | "split") {
  const current = await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid='review-pane-root'] [data-review-diff-style]")?.dataset.reviewDiffStyle)
  if (current !== style) {
    await clickVisible(page, `[data-testid='review-diff-style-toggle'][data-review-next-diff-style='${style}']`)
    await page.waitForFunction((expected) => document.querySelector<HTMLElement>("[data-testid='review-pane-root'] [data-review-diff-style]")?.dataset.reviewDiffStyle === expected, style, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
  }
}

async function ensureAllDiffs(page: Page, fixture: FixtureEvidence, expanded: boolean) {
  let state = await readDiffState(page)
  const expected = expanded ? fixture.changed.length : 0
  if (state.openCount === expected) return
  if (expanded) {
    if (state.openCount > 0) {
      await clickVisible(page, COLLAPSE_ALL_SELECTOR)
      await waitForDiffState(page, fixture, { openCount: 0 })
      state = await readDiffState(page)
    }
    if (state.openCount !== 0) {
      throw new Error(`Claxedo Review could not reach its collapsed setup state: ${state.openCount}`)
    }
    await clickVisible(page, "button[aria-label='Expand all']")
    await waitForDiffState(page, fixture, { openCount: fixture.changed.length })
    return
  }
  await clickVisible(page, COLLAPSE_ALL_SELECTOR)
  await waitForDiffState(page, fixture, { openCount: 0 })
}

async function readDiffState(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-testid='review-pane-root'] [data-review-diff-style]")
    return {
      style: root?.dataset.reviewDiffStyle,
      openCount: Number(root?.dataset.reviewOpenDiffCount ?? -1),
      loadedCount: Number(root?.dataset.reviewLoadedDiffCount ?? -1),
      renderedHunks: Number(root?.dataset.reviewRenderedHunks ?? -1),
    }
  })
}

async function waitForDiffState(
  page: Page,
  fixture: FixtureEvidence,
  expected: { style?: "unified" | "split"; openCount?: number },
  requireActiveTrace = false,
) {
  return page.evaluate(async ({ changed, expected, expectedReviewIdentity, requireActiveTrace, scrollSelector }) => {
    const deadline = performance.now() + 30_000
    let stable = 0
    let previous = ""
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
        const trace = (window as any).__claxedoPublicPanelTrace
        if (requireActiveTrace) {
          if (!trace?.active) return reject(new Error("Claxedo prearmed Diff readiness observer lost its active trace"))
          if (!Number.isFinite(trace.trustedInputAt)) {
            requestAnimationFrame(frame)
            return
          }
        }
        const root = document.querySelector<HTMLElement>("[data-testid='review-pane-root'] [data-review-diff-style]")
        const pane = root?.closest<HTMLElement>("[data-testid='review-pane-root']")
        const openCount = Number(root?.dataset.reviewOpenDiffCount ?? -1)
        const loadedCount = Number(root?.dataset.reviewLoadedDiffCount ?? -1)
        const canonicalRows = Array.from(pane?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
          .filter((row) => changed.includes(row.dataset.reviewFile ?? ""))
        const expandedRows = canonicalRows.filter((row) =>
          !!row.querySelector("[aria-expanded='true']") || !!row.shadowRoot?.querySelector("[aria-expanded='true']")
        )
        const viewportRect = pane?.querySelector<HTMLElement>(scrollSelector)
          ?.getBoundingClientRect()
        const visibleExpandedRows = expandedRows.filter((row) => {
          const rect = row.getBoundingClientRect()
          return !!viewportRect && rect.width > 0 && rect.height > 0 &&
            rect.bottom > viewportRect.top && rect.right > viewportRect.left &&
            rect.top < viewportRect.bottom && rect.left < viewportRect.right
        })
        const paintedRows = visibleExpandedRows.filter((row) => {
          const rowRect = row.getBoundingClientRect()
          const viewer = row.querySelector<HTMLElement>("diffs-container")
          const viewerRoot = viewer?.shadowRoot ?? row.shadowRoot
          if (viewerRoot) {
            return rowRect.width > 0 && rowRect.height > 0 && !!viewerRoot.querySelector("[data-line]")
          }
          const content = row.querySelector<HTMLElement>("[data-slot='session-review-accordion-content']")
          const wrapper = content?.querySelector<HTMLElement>("[data-slot='session-review-diff-wrapper']")
          const rect = content?.getBoundingClientRect()
          const style = content ? getComputedStyle(content) : undefined
          return !!content && !!wrapper && !!rect && rect.width > 0 && rect.height > 0 &&
            style?.display !== "none" && style?.visibility !== "hidden" &&
            !wrapper.querySelector("[data-slot='session-review-diff-placeholder']")
        })
        const bodyCount = pane?.querySelectorAll("[data-slot='session-review-accordion-content']").length ?? 0
        const expansionReady = expected.openCount === undefined || (expected.openCount === 0
          ? openCount === 0 && expandedRows.length === 0 && bodyCount === 0
          : openCount === expected.openCount && visibleExpandedRows.length > 0 &&
            paintedRows.length === visibleExpandedRows.length &&
            Number(root?.dataset.reviewRenderedHunks ?? 0) > 0)
        const ready = !!root && loadedCount === changed.length &&
          root.dataset.reviewLoadedDiffIdentity === expectedReviewIdentity &&
          (expected.style === undefined || root.dataset.reviewDiffStyle === expected.style) && expansionReady
        const signature = ready ? JSON.stringify([root.dataset.reviewDiffStyle, openCount, loadedCount, expandedRows.length, visibleExpandedRows.length, paintedRows.length, bodyCount, root.dataset.reviewRenderedHunks]) : ""
        const frameLog = ((window as any).__diffStateLog ??= [])
        if (frameLog.length < 400) frameLog.push({ at, ready, open: openCount, loaded: loadedCount, expanded: expandedRows.length, visible: visibleExpandedRows.length, painted: paintedRows.length, body: bodyCount, hunks: root?.dataset.reviewRenderedHunks, stable })
        stable = ready && signature === previous ? stable + 1 : ready ? 1 : 0
        previous = signature
        const tracedPresentations = requireActiveTrace
          ? trace.frames.filter((frameAt: number) => frameAt >= trace.trustedInputAt && frameAt <= at).length
          : 2
        if (stable >= 2 && tracedPresentations >= 2) return resolve(at)
        if (performance.now() >= deadline) return reject(new Error(`Claxedo Diff state did not reach its authoritative endpoint: ${JSON.stringify({
          expected,
          root: root ? { ...root.dataset } : undefined,
          openCount,
          loadedCount,
          canonicalRows: canonicalRows.length,
          expandedRows: expandedRows.length,
          visibleExpandedRows: visibleExpandedRows.length,
          paintedRows: paintedRows.length,
          bodyCount,
          stable,
        })}`))
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, {
    changed: fixture.changed,
    expected,
    expectedReviewIdentity: reviewLoadedDiffIdentity(fixture.changed),
    requireActiveTrace,
    scrollSelector: REVIEW_SCROLL_SELECTOR,
  })
}

async function twoPresentationTimestamp(page: Page) {
  return page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function clickVisible(page: Page, selector: string) {
  await (await visibleLocator(page, selector)).click()
}

async function waitForVisibleSelector(page: Page, selector: string) {
  await page.waitForFunction((query) => Array.from(document.querySelectorAll<HTMLElement>(query)).some((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }), selector, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
}

async function optionalVisibleLocator(page: Page, selector: string) {
  const index = await page.evaluate((query) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(query))
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements[index]!
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") return index
    }
    return -1
  }, selector)
  return index < 0 ? undefined : page.locator(selector).nth(index)
}

async function visibleLocator(page: Page, selector: string) {
  const locator = await optionalVisibleLocator(page, selector)
  if (!locator) throw new Error(`Claxedo has no visible control for ${selector}`)
  return locator
}

async function indexByText(page: Page, selector: string, text: string, visible = false) {
  return page.evaluate(({ selector: query, text: expected, visible: requireVisible }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(query))
    return elements.findIndex((element) => {
      if (!element.innerText.includes(expected)) return false
      if (!requireVisible) return true
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    })
  }, { selector, text, visible })
}

async function activateExact(page: Page, target: PanelTarget, hooks?: ActivationHooks) {
  const result = await measureSessionActivation(page, target, hooks)
  if (result.state !== "exact") throw new Error(`Claxedo session activation failed: ${result.reason}`)
  return result
}

async function markCounterEnd(page: Page, at: number) {
  await page.evaluate(({ endMark, at }) => {
    performance.clearMarks(endMark)
    performance.mark(endMark, { startTime: at })
  }, { endMark: COUNTER_END_MARK, at })
}

async function beginTrace(
  page: Page,
  options: { openFilesExpectedCount?: number } = {},
): Promise<TraceRecording> {
  const events: TraceEvent[] = []
  let resolveComplete = () => {}
  const complete = new Promise<void>((resolve) => { resolveComplete = resolve })
  const stopData = page.onProtocolEvent("Tracing.dataCollected", (event) => events.push(...((event as { value?: TraceEvent[] }).value ?? [])))
  const stopComplete = page.onProtocolEvent("Tracing.tracingComplete", resolveComplete)
  await page.rawCommand("Tracing.start", { categories: "devtools.timeline,blink.user_timing,toplevel", transferMode: "ReportEvents", options: "record-until-full" })
  await page.evaluate(({ startMark, endMark, openFilesExpectedCount }) => {
    const root = window as typeof window & { __claxedoPublicPanelTrace?: any }
    if (root.__claxedoPublicPanelTrace) throw new Error("A Claxedo public renderer trace is already active")
    performance.clearMarks(endMark)
    const trace: any = {
      active: true,
      frames: [],
      milestones: [],
      loafs: [],
      trustedInputAt: undefined,
      lastTrustedInputAt: undefined,
      openFiles: openFilesExpectedCount === undefined ? undefined : {
        expectedFiles: openFilesExpectedCount,
        shellVisible: undefined,
        animationSettled: undefined,
        dataReady: undefined,
        aboveFoldPainted: undefined,
        lastSignature: "",
        stable: 0,
      },
    }
    trace.pointer = (event: PointerEvent) => {
      if (!event.isTrusted) return
      const at = performance.now()
      trace.lastTrustedInputAt = at
      if (trace.trustedInputAt !== undefined) return
      performance.clearMarks(startMark)
      trace.trustedInputAt = performance.mark(startMark).startTime
      trace.milestones.push({ id: "trusted-input", at: trace.trustedInputAt })
    }
    document.addEventListener("pointerdown", trace.pointer, true)
    trace.frame = (at: number) => {
      if (!trace.active) return
      if (trace.frames.length < 600) trace.frames.push(at)
      const openFiles = trace.openFiles
      if (trace.trustedInputAt !== undefined && openFiles) {
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        const visible = (element: HTMLElement | null | undefined) => {
          if (!element) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        if (visible(shell) && openFiles.shellVisible === undefined) openFiles.shellVisible = at
        if (openFiles.shellVisible !== undefined && shell?.dataset.shellSettled === "true" && openFiles.animationSettled === undefined) {
          openFiles.animationSettled = at
        }
        const navigator = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']") ?? [])
          .find((element) => visible(element))
        const rows = navigator?.querySelectorAll("[data-file-tree-path], [data-component='filetree'] button").length ?? 0
        const dataReady = !!navigator && navigator.dataset.fileTreeDataReady === "true" && rows > 0 &&
          !navigator.querySelector("[data-file-tree-loading], [aria-label='Loading files']")
        if (dataReady && openFiles.dataReady === undefined) openFiles.dataReady = at
        const signature = dataReady
          ? JSON.stringify([shell?.dataset.stateWorkspaceDir, rows, navigator?.innerText.length, openFiles.expectedFiles])
          : ""
        openFiles.stable = dataReady && openFiles.shellVisible !== undefined && signature === openFiles.lastSignature
          ? openFiles.stable + 1
          : dataReady ? 1 : 0
        openFiles.lastSignature = signature
        if (openFiles.stable >= 2 && openFiles.aboveFoldPainted === undefined) openFiles.aboveFoldPainted = at
      }
      requestAnimationFrame(trace.frame)
    }
    if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
      trace.observer = new PerformanceObserver((list: PerformanceObserverEntryList) => {
        for (const raw of list.getEntries() as any) {
          if (trace.loafs.length >= 100) break
          trace.loafs.push({
            start: raw.startTime, duration: raw.duration, blockingDuration: raw.blockingDuration ?? 0,
            renderStart: Number(raw.renderStart ?? raw.startTime), styleAndLayoutStart: Number(raw.styleAndLayoutStart ?? raw.startTime),
            scripts: Array.from(raw.scripts ?? []).slice(0, 32).map((script: any) => ({
              sourceURL: (() => { const value = String(script.sourceURL ?? ""); try { return new URL(value).pathname.split("/").slice(-3).join("/").slice(0, 500) } catch { return value.split("/").slice(-3).join("/").slice(0, 500) } })(),
              functionName: String(script.sourceFunctionName ?? "").slice(0, 300), invokerType: String(script.invokerType ?? script.invoker ?? "").slice(0, 120),
              duration: Number(script.duration ?? 0), forcedStyleAndLayoutDuration: Number(script.forcedStyleAndLayoutDuration ?? 0),
            })),
          })
        }
      })
      trace.observer.observe({ type: "long-animation-frame", buffered: false } as PerformanceObserverInit)
    }
    root.__claxedoPublicPanelTrace = trace
    requestAnimationFrame(trace.frame)
  }, { startMark: COUNTER_START_MARK, endMark: COUNTER_END_MARK, openFilesExpectedCount: options.openFilesExpectedCount })
  return { events, complete, stopListening: () => { stopData(); stopComplete() } }
}

async function waitForTracedOpenFiles(page: Page) {
  return page.evaluate(async () => {
    const deadline = performance.now() + 30_000
    return new Promise<{ shellVisible: number; animationSettled: number; dataReady: number; aboveFoldPainted: number }>((resolve, reject) => {
      const frame = () => {
        const trace = (window as any).__claxedoPublicPanelTrace
        const readiness = trace?.openFiles
        if (!trace?.active || !readiness) return reject(new Error("Claxedo panel-open readiness observer was not armed before input"))
        if ([readiness.shellVisible, readiness.animationSettled, readiness.dataReady, readiness.aboveFoldPainted].every(Number.isFinite)) {
          return resolve({
            shellVisible: readiness.shellVisible,
            animationSettled: readiness.animationSettled,
            dataReady: readiness.dataReady,
            aboveFoldPainted: readiness.aboveFoldPainted,
          })
        }
        if (performance.now() >= deadline) {
          return reject(new Error(`Claxedo prearmed panel-open observer did not reach readiness: ${JSON.stringify(readiness)}`))
        }
        requestAnimationFrame(frame)
      }
      frame()
    })
  })
}

async function addMilestones(page: Page, milestones: Array<{ id: string; at: number }>) {
  await page.evaluate((items) => {
    const trace = (window as any).__claxedoPublicPanelTrace
    if (!trace?.active) throw new Error("No active Claxedo public renderer trace")
    trace.milestones.push(...items)
  }, milestones)
}

async function readLastTrustedInput(page: Page) {
  const at = await page.evaluate(() => (window as any).__claxedoPublicPanelTrace?.lastTrustedInputAt ?? Number.NaN)
  if (!Number.isFinite(at)) throw new Error("Claxedo trace did not observe the second trusted input")
  return at
}

async function finishMeasuredTrace(page: Page, recording: TraceRecording) {
  const trace = await page.evaluate(({ endMark }) => {
    const current = (window as any).__claxedoPublicPanelTrace
    if (!current?.active || !Number.isFinite(current.trustedInputAt)) throw new Error("Claxedo measured action has no trusted input")
    const end = performance.getEntriesByName(endMark, "mark").at(-1)?.startTime ?? performance.mark(endMark).startTime
    current.milestones.push({ id: "interactive", at: end }, { id: "complete", at: end })
    current.active = false
    document.removeEventListener("pointerdown", current.pointer, true)
    current.observer?.disconnect()
    delete (window as any).__claxedoPublicPanelTrace
    return {
      clock: "performance.now" as const,
      transitionMode: "animated" as const,
      milestones: current.milestones.toSorted((a: any, b: any) => a.at - b.at),
      frameTimestampsMs: current.frames.filter((at: number) => at >= current.trustedInputAt && at <= end),
      longAnimationFrames: current.loafs.filter((entry: any) => entry.start >= current.trustedInputAt && entry.start + entry.duration <= end + 0.5),
      counterInterval: { start: current.trustedInputAt, end },
    }
  }, { endMark: COUNTER_END_MARK })
  await page.rawCommand("Tracing.end")
  await Promise.race([recording.complete, new Promise((_, reject) => setTimeout(() => reject(new Error("Claxedo renderer trace did not finish")), READINESS_TIMEOUT_MS))])
  recording.stopListening()
  const rendererTrace: RendererTrace = { ...trace, counters: rendererCounters(recording.events) }
  const clock: Clock = { kind: "single-monotonic-clock", clock: "performance.now", start: trace.counterInterval.start, end: trace.counterInterval.end }
  return { clock, rendererTrace }
}

async function abortTrace(page: Page, recording: TraceRecording) {
  await page.evaluate(() => {
    const trace = (window as any).__claxedoPublicPanelTrace
    if (trace) {
      trace.active = false
      document.removeEventListener("pointerdown", trace.pointer, true)
      trace.observer?.disconnect()
      delete (window as any).__claxedoPublicPanelTrace
    }
  }).catch(() => undefined)
  await page.rawCommand("Tracing.end").catch(() => undefined)
  await recording.complete.catch(() => undefined)
  recording.stopListening()
}

function rendererCounters(events: TraceEvent[]) {
  const start = events.find((event) => event.name === COUNTER_START_MARK)
  const end = events.find((event) => event.name === COUNTER_END_MARK && event.pid === start?.pid && event.tid === start?.tid)
  if (!start || !end) throw new Error("Claxedo counter trace is missing its action boundary marks")
  return {
    scriptDurationMs: traceDuration(events, new Set(["EventDispatch", "TimerFire", "FireAnimationFrame", "RunMicrotasks"]), start, end),
    styleRecalcDurationMs: traceDuration(events, new Set(["UpdateLayoutTree", "RecalculateStyles", "RecalculateStyle"]), start, end),
    layoutDurationMs: traceDuration(events, new Set(["Layout"]), start, end),
    taskDurationMs: traceDuration(events, new Set(["RunTask"]), start, end),
  }
}

function traceDuration(events: TraceEvent[], names: Set<string>, start: TraceEvent, end: TraceEvent) {
  const intervals = events
    .filter((event) => event.pid === start.pid && event.tid === start.tid && event.ph === "X" && Number.isFinite(event.ts) && Number.isFinite(event.dur) && [...names].some((name) => event.name === name || event.name?.endsWith(`::${name}`)))
    .map((event) => [Math.max(start.ts!, event.ts!), Math.min(end.ts!, event.ts! + event.dur!)] as const)
    .filter(([left, right]) => right > left)
    .toSorted(([left], [right]) => left - right)
  let total = 0
  let left = Number.NaN
  let right = Number.NaN
  for (const [nextLeft, nextRight] of intervals) {
    if (!Number.isFinite(left)) { left = nextLeft; right = nextRight; continue }
    if (nextLeft <= right) { right = Math.max(right, nextRight); continue }
    total += right - left
    left = nextLeft
    right = nextRight
  }
  if (Number.isFinite(left)) total += right - left
  return total / 1_000
}
