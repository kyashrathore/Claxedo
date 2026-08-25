import type { WorkspaceFixtureManifest } from "agent-app-benchmark/driver-sdk"

import type { BenchmarkPage as Page } from "./agent-cdp-page"
import { measureSessionActivation, type SessionReadinessTarget } from "./agent-browser-observer"

const READINESS_TIMEOUT_MS = 30_000
const COUNTER_START_MARK = "claxedo-public-panel-counter-start"
const COUNTER_END_MARK = "claxedo-public-panel-counter-end"

export type PanelProfile = "closed" | "files" | "diff"

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

type FixtureEvidence = {
  manifest: WorkspaceFixtureManifest
  files: string[]
  changed: string[]
  openFiles: string[]
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
      return measureSettledAction(page, async () => clickVisible(page, "button[aria-label='Collapse all']"), async () => {
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
  const recording = await beginTrace(page)
  try {
    if (cold) await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Open workspace panel']")
    else await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Open workspace panel']")
    const readiness = await waitForOpenFiles(page, fixture)
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

async function waitForOpenFiles(page: Page, fixture: FixtureEvidence) {
  return page.evaluate(async ({ expectedFiles }) => {
    const deadline = performance.now() + 30_000
    let shellVisible: number | undefined
    let animationSettled: number | undefined
    let dataReady: number | undefined
    let lastSignature = ""
    let stable = 0
    return new Promise<{ shellVisible: number; animationSettled: number; dataReady: number; aboveFoldPainted: number }>((resolve, reject) => {
      const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      }
      const frame = (at: number) => {
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        if (shell && visible(shell) && shellVisible === undefined) shellVisible = at
        if (shell?.dataset.shellSettled === "true" && animationSettled === undefined) animationSettled = at
        const navigator = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']") ?? [])
          .find((element) => visible(element))
        const rows = navigator?.querySelectorAll("[data-file-tree-path], [data-component='filetree'] button").length ?? 0
        const ready = !!navigator && visible(navigator) && navigator.dataset.fileTreeDataReady === "true" && rows > 0 && !navigator.querySelector("[data-file-tree-loading], [aria-label='Loading files']")
        if (ready && dataReady === undefined) dataReady = at
        const signature = ready ? JSON.stringify([shell?.dataset.stateWorkspaceDir, rows, navigator?.innerText.length, expectedFiles]) : ""
        stable = ready && shellVisible !== undefined && animationSettled !== undefined && signature === lastSignature ? stable + 1 : ready ? 1 : 0
        lastSignature = signature
        if (stable >= 2 && shellVisible !== undefined && animationSettled !== undefined && dataReady !== undefined) {
          resolve({ shellVisible, animationSettled, dataReady, aboveFoldPainted: at })
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
  }, { expectedFiles: fixture.files.length })
}

async function waitForPanelProfile(page: Page, profile: Exclude<PanelProfile, "closed">, fixture: FixtureEvidence) {
  if (profile === "files") return (await waitForOpenFiles(page, fixture)).aboveFoldPainted
  return page.evaluate(async ({ changed }) => {
    const deadline = performance.now() + 30_000
    let prior = ""
    let stable = 0
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
        const root = shell?.querySelector<HTMLElement>("[data-testid='review-pane-root']")
        const corpus = root?.querySelector<HTMLElement>("[data-review-total-files]")
        const rendered = Number(corpus?.dataset.reviewRenderedFiles)
        const ready = shell?.dataset.shellSettled === "true" && shell.dataset.stateMode === "review" && !!root && Number(corpus?.dataset.reviewTotalFiles) === changed && rendered === changed && !root.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
        const signature = ready ? JSON.stringify([rendered, root.innerText.length]) : ""
        stable = ready && signature === prior ? stable + 1 : ready ? 1 : 0
        prior = signature
        if (stable >= 2) return resolve(at)
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
  }, { changed: fixture.changed.length })
}

async function waitForPanelClosed(page: Page) {
  return page.evaluate(async () => {
    const deadline = performance.now() + 30_000
    let stable = 0
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
        const rect = shell?.getBoundingClientRect()
        const closed = !shell || (shell.dataset.open === "false" && !!rect && rect.left >= window.innerWidth - 1)
        stable = closed ? stable + 1 : 0
        if (stable >= 2) return resolve(at)
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
  })
}

async function waitForPanelOwner(page: Page, profile: PanelProfile, target: PanelTarget, fixture: FixtureEvidence) {
  return page.evaluate(async ({ profile, sessionId, directory, files, changed, endMark }) => {
    const deadline = performance.now() + 30_000
    let stable = 0
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
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
            ready = ownerExact &&
              shell?.dataset.stateNavigator === "changes" &&
              visible(root) &&
              Number(corpus?.dataset.reviewTotalFiles) === changed.length &&
              Number(corpus?.dataset.reviewRenderedFiles) === changed.length &&
              renderedFiles.length > 0 &&
              canonicalFile &&
              !root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
            signature = ready ? JSON.stringify([directory, sessionId, renderedFiles, root?.innerText.length]) : ""
          }
        }
        stable = ready ? stable + 1 : 0
        if (stable >= 2) {
          const trace = (window as any).__claxedoPublicPanelTrace
          const terminal = trace?.active
            ? (performance.clearMarks(endMark), performance.mark(endMark).startTime)
            : at
          return resolve(terminal)
        }
        if (performance.now() >= deadline) return reject(new Error(`Claxedo workspace panel did not reach atomic destination readiness: ${JSON.stringify({
          profile,
          shell: shell ? { ...shell.dataset } : undefined,
          signature,
          stable,
        })}`))
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, {
    profile,
    sessionId: target.sessionId,
    directory: target.workspaceDirectory,
    files: fixture.files,
    changed: fixture.changed,
    endMark: COUNTER_END_MARK,
  })
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

async function waitForPaintedFile(page: Page, file: string) {
  await page.evaluate(async (expected) => {
    const deadline = performance.now() + 30_000
    let previous = ""
    let stable = 0
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
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
        if (stable >= 2) return resolve(at)
        if (performance.now() >= deadline) return reject(new Error(`Claxedo file did not reach painted readiness: ${expected}`))
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, file)
}

async function fileRowLocator(page: Page, file: string) {
  return treeRowLocator(page, file, true)
}

async function treeRowLocator(page: Page, file: string, allowUniqueBasename = false) {
  const selector = "[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path]"
  const index = await page.evaluate(({ selector: query, expected, allowUniqueBasename }) => {
    const basename = expected.slice(expected.lastIndexOf("/") + 1)
    const rows = Array.from(document.querySelectorAll<HTMLElement>(query))
    return rows.findIndex((row) => {
      const path = row.dataset.fileTreePath ?? ""
      const rect = row.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && (path === expected || path.endsWith(`/${expected}`) || (allowUniqueBasename && row.innerText.includes(basename)))
    })
  }, { selector, expected: file, allowUniqueBasename })
  if (index < 0) throw new Error(`Claxedo has no visible canonical file row for ${file}`)
  return page.locator(selector).nth(index)
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
  const state = await readDiffState(page)
  const expected = expanded ? fixture.changed.length : 0
  if (state.openCount === expected) return
  await clickVisible(page, `button[aria-label='${expanded ? "Expand" : "Collapse"} all']`)
  await waitForDiffState(page, fixture, { openCount: expected })
}

async function readDiffState(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-testid='review-pane-root'] [data-review-diff-style]")
    return {
      style: root?.dataset.reviewDiffStyle,
      openCount: Number(root?.dataset.reviewOpenDiffCount ?? -1),
      loadedCount: Number(root?.dataset.reviewLoadedDiffCount ?? -1),
    }
  })
}

async function waitForDiffState(page: Page, fixture: FixtureEvidence, expected: { style?: "unified" | "split"; openCount?: number }) {
  return page.evaluate(async ({ changed, expected }) => {
    const deadline = performance.now() + 30_000
    let stable = 0
    let previous = ""
    return new Promise<number>((resolve, reject) => {
      const frame = (at: number) => {
        const root = document.querySelector<HTMLElement>("[data-testid='review-pane-root'] [data-review-diff-style]")
        const openCount = Number(root?.dataset.reviewOpenDiffCount ?? -1)
        const loadedCount = Number(root?.dataset.reviewLoadedDiffCount ?? -1)
        const ready = !!root && loadedCount >= 0 && loadedCount <= changed && (expected.style === undefined || root.dataset.reviewDiffStyle === expected.style) && (expected.openCount === undefined || openCount === expected.openCount)
        const signature = ready ? JSON.stringify([root.dataset.reviewDiffStyle, openCount, loadedCount, root.dataset.reviewRenderedHunks]) : ""
        stable = ready && signature === previous ? stable + 1 : ready ? 1 : 0
        previous = signature
        if (stable >= 2) return resolve(at)
        if (performance.now() >= deadline) return reject(new Error("Claxedo Diff state did not reach its authoritative endpoint"))
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, { changed: fixture.changed.length, expected })
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

async function activateExact(page: Page, target: PanelTarget) {
  const result = await measureSessionActivation(page, target)
  if (result.state !== "exact") throw new Error(`Claxedo session activation failed: ${result.reason}`)
  return result
}

async function beginTrace(page: Page): Promise<TraceRecording> {
  const events: TraceEvent[] = []
  let resolveComplete = () => {}
  const complete = new Promise<void>((resolve) => { resolveComplete = resolve })
  const stopData = page.onProtocolEvent("Tracing.dataCollected", (event) => events.push(...((event as { value?: TraceEvent[] }).value ?? [])))
  const stopComplete = page.onProtocolEvent("Tracing.tracingComplete", resolveComplete)
  await page.rawCommand("Tracing.start", { categories: "devtools.timeline,blink.user_timing,toplevel", transferMode: "ReportEvents", options: "record-until-full" })
  await page.evaluate(({ startMark, endMark }) => {
    const root = window as typeof window & { __claxedoPublicPanelTrace?: any }
    if (root.__claxedoPublicPanelTrace) throw new Error("A Claxedo public renderer trace is already active")
    performance.clearMarks(endMark)
    const trace: any = { active: true, frames: [], milestones: [], loafs: [], trustedInputAt: undefined, lastTrustedInputAt: undefined }
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
  }, { startMark: COUNTER_START_MARK, endMark: COUNTER_END_MARK })
  return { events, complete, stopListening: () => { stopData(); stopComplete() } }
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
