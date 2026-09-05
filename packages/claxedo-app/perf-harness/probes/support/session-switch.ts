import type { Page } from "playwright-core"
import type { OldWorkspaceRelease } from "../../src/browser/scenarios/session-switch-workspace-contract"

/**
 * The session-ready gate is a conjunction. `stageMs` records when each of its
 * clauses FIRST held, so a slow cell names the clause that is still false
 * instead of leaving the whole gate as one opaque number.
 */
export const READY_STAGES = [
  "root",
  "firstFoldReady",
  "messagesReady",
  "messageCount",
  "timelineRoot",
  "revealReady",
  "progressiveReady",
  "visible",
  "keyCount",
  "rowText",
] as const

export type ReadyStage = (typeof READY_STAGES)[number]

export type ProbeObservation = {
  completionMs: number
  acknowledgedMs?: number
  timedOut: boolean
  sessionReadyMs?: number
  oldWorkspaceReleasedMs?: number
  oldWorkspaceRelease?: OldWorkspaceRelease
  destinationWorkspaceReadyMs?: number
  stageMs?: Partial<Record<ReadyStage, number>>
  activationMarks?: Array<{ name: string; atMs: number }>
  requests?: Array<{ name: string; startMs: number; durationMs: number }>
}

/**
 * In-page readiness loop. One serialized copy of the two loops the driver
 * uses (`observeSessionSwitchReady` and `observeCrossWorkspaceSessionSwitch`
 * in browser/scenarios/session-switch-workspace.ts): `cross: false` waits only on the
 * destination session's own clock, `cross: true` additionally runs the old-
 * surface-disposal and destination-workspace clocks. Keep in sync with the
 * driver — this probe is only useful while it measures the same thing.
 */
export const observeSwitch = async (params: {
  mark: string
  timeoutMs: number
  sessionId: string
  cross: boolean
  newDirectory: string
  oldDirectory: string
  expectedTotal: number
  bodyHostSelector: string
  bodyInertAttribute: string
}): Promise<ProbeObservation> => {
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
  const stageMs: Partial<Record<ReadyStage, number>> = {}
  const stage = (name: ReadyStage, held: boolean, elapsed: number) => {
    if (held && stageMs[name] === undefined) stageMs[name] = elapsed
    return held
  }
  const sessionReady = (elapsed: number) => {
    const target = root()
    if (!stage("root", !!target && !target.closest("[aria-hidden='true']"), elapsed) || !target) return false
    const foldReady = stage("firstFoldReady", target.dataset.sessionFirstFoldReady === "true", elapsed)
    const messagesReady = stage("messagesReady", target.dataset.sessionMessagesReady === "true", elapsed)
    const counted = stage(
      "messageCount",
      Number(target.dataset.sessionMessageCount ?? target.dataset.sessionConversationCount ?? "0") > 0,
      elapsed,
    )
    const timeline = target.querySelector<HTMLElement>("[data-session-timeline-root]")
    if (!stage("timelineRoot", !!timeline, elapsed) || !timeline) return false
    const revealReady = stage("revealReady", timeline.dataset.sessionTimelineRevealReady === "true", elapsed)
    const progressiveReady = stage("progressiveReady", timeline.dataset.sessionTimelineProgressiveReady === "true", elapsed)
    const shown = stage("visible", getComputedStyle(timeline).visibility !== "hidden", elapsed)
    const keyed = stage("keyCount", Number(timeline.dataset.sessionTimelineKeyCount ?? "0") > 0, elapsed)
    const texted = stage(
      "rowText",
      Array.from(timeline.querySelectorAll<HTMLElement>("[data-timeline-key]")).some((row) => (row.textContent ?? "").trim()),
      elapsed,
    )
    return foldReady && messagesReady && counted && revealReady && progressiveReady && shown && keyed && texted
  }
  const shell = () => document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
  const oldContent = (window as unknown as { __claxedoPerfOldPanelContent?: HTMLElement }).__claxedoPerfOldPanelContent
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
    if (dir === params.oldDirectory || !dir.includes(params.newDirectory)) return false
    const reviewRoot = Array.from(current.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    if (!reviewRoot) return false
    const corpus = reviewRoot.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    const reviewReady = !!corpus && Number(corpus.dataset.reviewTotalFiles ?? "0") === params.expectedTotal &&
      Array.from(reviewRoot.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)
    const fileReady = Array.from(current.querySelectorAll<HTMLElement>("[data-testid='tab-file-root'][data-tab-file-state='ready']"))
      .some(visible)
    const navigator = Array.from(current.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator']")).find(visible)
    const navigatorReady = navigator?.getAttribute("data-file-tree-data-ready") === "true" ||
      !!navigator?.querySelector("[data-file-tree-path]")
    return reviewReady || fileReady || navigatorReady
  }
  let acknowledgedMs: number | undefined
  let sessionReadyMs: number | undefined
  let oldWorkspaceReleasedMs: number | undefined
  let oldWorkspaceRelease: OldWorkspaceRelease | undefined
  let destinationWorkspaceReadyMs: number | undefined
  let stableFrames = 0
  const completionMs = await new Promise<number>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - started
      if (acknowledgedMs === undefined && root()) acknowledgedMs = elapsed
      if (sessionReadyMs === undefined && sessionReady(elapsed)) sessionReadyMs = elapsed
      if (params.cross) {
        if (oldWorkspaceReleasedMs === undefined) {
          const release = readOldWorkspaceRelease()
          if (release) {
            oldWorkspaceRelease = release
            oldWorkspaceReleasedMs = elapsed
          }
        }
        if (destinationWorkspaceReadyMs === undefined && destinationReady()) destinationWorkspaceReadyMs = elapsed
      }
      const done = params.cross
        ? sessionReadyMs !== undefined && oldWorkspaceReleasedMs !== undefined && destinationWorkspaceReadyMs !== undefined
        : sessionReadyMs !== undefined
      stableFrames = done ? stableFrames + 1 : 0
      if (stableFrames >= 2 || elapsed >= params.timeoutMs) return resolve(elapsed)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const requests = performance.getEntriesByType("resource")
    .filter((entry) => entry.startTime >= started && !entry.name.startsWith("data:"))
    .map((entry) => {
      const url = new URL(entry.name)
      return { name: `${url.pathname}${url.search}`.slice(0, 110), startMs: entry.startTime - started, durationMs: entry.duration }
    })
  const activationMarks = performance.getEntriesByType("mark")
    // The app's own activation marks (renderer-trace.ts): when the rail issued
    // the session's message prefetch, when it landed, and when the destination
    // timeline mounted. They are what separate transport wait from render work.
    .filter((entry) => (entry.name.startsWith("sessionActivate.") || entry.name.startsWith("timeline.")) && entry.startTime >= started)
    .map((entry) => ({ name: entry.name, atMs: entry.startTime - started }))
  for (const entry of activationMarks) performance.clearMarks(entry.name)
  performance.clearMarks(params.mark)
  delete (window as unknown as { __claxedoPerfOldPanelContent?: HTMLElement }).__claxedoPerfOldPanelContent
  return {
    completionMs,
    acknowledgedMs,
    timedOut: completionMs >= params.timeoutMs,
    sessionReadyMs,
    stageMs,
    activationMarks,
    requests,
    ...(params.cross ? { oldWorkspaceReleasedMs, oldWorkspaceRelease, destinationWorkspaceReadyMs } : {}),
  }
}

/**
 * The files navigator lives behind the panel's "Open Files" control (inside
 * `[data-testid='workspace-navigator-overlay']`), which the driver reaches via
 * measureWorkspaceFiles before it opens a file tab.
 */
export async function openFilesNavigator(page: Page) {
  await page.evaluate(() => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
    }
    const control = Array.from(document.querySelectorAll<HTMLElement>(
      "button[aria-label='Open Files'], [role='button'][aria-label='Open Files']",
    )).find(visible)
    if (!control) throw new Error("no visible 'Open Files' control on the workspace panel")
    control.click()
  })
  await page.waitForFunction(() => {
    const navigator = document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    if (!navigator) return false
    const overlay = navigator.closest<HTMLElement>("[data-testid='workspace-navigator-overlay']")
    if (overlay && (overlay.dataset.open !== "true" || overlay.getAttribute("aria-hidden") === "true")) return false
    return navigator.getAttribute("data-file-tree-data-ready") === "true" ||
      !!navigator.querySelector("[data-file-tree-path]")
  }, undefined, { timeout: 10_000 })
}

/** Same precondition the driver's Block B establishes: one substantial file tab open. */
export async function openWorkspaceFileTab(page: Page, filePath: string) {
  await openFilesNavigator(page)
  const navigator = page.locator("[data-testid='workspace-files-navigator'][data-mode='files']").last()
  const search = navigator.locator("input[placeholder='Search files...']").first()
  await search.waitFor({ state: "visible", timeout: 5_000 })
  await search.fill(filePath)
  const row = navigator.locator(`[data-file-tree-path="${filePath}"]`).first()
  await row.waitFor({ state: "visible", timeout: 5_000 })
  await row.click({ timeout: 5_000 })
  await page.waitForFunction((filePath) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    return !!shell?.querySelector(
      `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(filePath)}"][data-tab-file-state='ready']`,
    )
  }, filePath, { timeout: 10_000 })
}

/** Same precondition the driver's Block C establishes: first diff expanded. */
export async function openFirstReviewDiff(page: Page) {
  const item = page.locator("#review-panel [data-review-file]").first()
  await item.waitFor({ state: "visible", timeout: 5_000 })
  const trigger = item.locator('[data-testid$="-trigger"]').first()
  const renderedBefore = await page.evaluate(() => Number(
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .find((node) => !node.closest("[aria-hidden='true']"))
      ?.dataset.reviewRenderedHunks ?? "0",
  ))
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click({ timeout: 5_000 })
  await page.waitForFunction((before) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .some((node) => !node.closest("[aria-hidden='true']") && Number(node.dataset.reviewRenderedHunks ?? "0") > before),
  renderedBefore, { timeout: 10_000 })
  await page.waitForFunction(() => {
    const review = document.querySelector("#review-panel [data-review-diff-style]")
    return !!review?.getAttribute("data-review-diff-style") && Number(review.getAttribute("data-review-rendered-hunks") ?? "0") > 0
  }, undefined, { timeout: 10_000 })
}
