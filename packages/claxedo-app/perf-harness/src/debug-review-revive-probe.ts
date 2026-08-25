// TEMP probe (read-only diagnosis): the fast meter for the
// `session-switch-workspace` experiment loop.
//
// It reproduces the scenario driver's FULL 12-cell matrix (browser-runner.ts ->
// sessionSwitchWorkspace: blocks closed / open_file / open_review x within /
// across x cold / warm) end to end in well under a `bun run run` pass, and per
// cell prints completion, session-ready, script/style/layout, the stability
// counters, plus four attribution sections that name WHY a cell is slow:
//   - READY-GATE STAGES     when each clause of the session-ready conjunction
//                           first held (a slow cell names the clause it waits on)
//   - IN-WINDOW REQUESTS    every network read inside the switch window, with
//                           start and duration relative to the trusted pointerdown
//   - ACTIVATION MARKS      the app's own renderer-trace marks (rail message
//                           prefetch start/end, destination timeline mount)
//   - TRACE TASKS           main-thread tasks over 10ms with their top events
// It then runs one extra attribution cell with the review corpus suppressed via
// `content-visibility: hidden`, to size how much of session-readiness is
// coupled to the workspace corpus's rendering work.
//
// For the ONE measured switch (`session_switch_open_review_across_warm`) it
// additionally prints:
//   - session-ready ms                    (destination transcript usable)
//   - destination-workspace-ready ms      (destination panel body above-fold)
//   - old-surface-released ms + outcome   (previous review root detached, or
//                                          retained under a provably inert
//                                          body host)
//   - renderer task intervals > 16.67ms   (each duration, both traced main-
//                                          thread tasks and rAF intervals)
//   - JS / style / layout attribution     (exact trusted-window trace delta)
//   - stability counters                  (mock-authoritative vcs/file/
//                                          workspace/sse requests, plus the
//                                          data-review-rendered-files writes)
// It then drives the A-B-A-B PING-PONG: three further cross-workspace
// switches between the same two workspaces. Those return switches are the
// panel body LRU's win case — the destination body was constructed by an
// earlier switch and is still retained, so the switch is a display flip
// instead of a reconstruction. On a build without retention they are three
// more full constructions, which is exactly the A/B.
//
// and, for the cheap surrounding cells, the two hard stability gates that are
// currently failing on SAME-workspace switches:
//   (a) panel CLOSED, same workspace: expected 0 vcs + 0 workspace requests
//   (b) Review OPEN,  same workspace: expected 0 data-review-rendered-files
//       rewrites (no review recomputation on session activation)
//
// Run (about 25s, of which ~15s is the deliberate staleness idle below):
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=46087 \
//     bun src/debug-session-switch-probe.ts
// Add PROBE_SKIP_STALE_IDLE=1 for an ~11s run that measures the switch but
// cannot see stability gate (a).
//
// Why those two env vars:
//   CLAXEDO_PERF_SKIP_BUILD=1 makes startApp() serve the EXISTING
//     packages/claxedo-app/dist via `vite preview` instead of spending ~40s
//     rebuilding it, which is the whole point of a fast meter.
//   CLAXEDO_PERF_MOCK_PORT must equal the mock port BAKED INTO that dist at
//     build time (VITE_CLAXEDO_SERVER_URL / VITE_OPENCODE_SERVER_PORT). The
//     bundle hard-codes the backend origin, so a mismatched port means the app
//     talks to a port nothing is routed on and the probe hangs on an empty
//     screen. Read the baked port out of the dist with:
//       grep -ohE '127\.0\.0\.1:[0-9]{4,5}' ../dist/assets/*.js | sort | uniq -c
//     (the frequent one is the mock port; 3000 is an unrelated default). At
//     the time of writing that is 46087. Drop CLAXEDO_PERF_SKIP_BUILD to have
//     startApp() rebuild the dist for whatever port you pass instead.
//
// The probe never touches application source; it only drives the built app.
import { chromium, type Locator, type Page } from "@playwright/test"
// Causal attribution (script/style/layout + the trusted-window trace) is
// opt-in inside frame-sampler, read at call time. The probe exists to print
// that attribution, so it turns the flag on for itself unless overridden.
process.env.CLAXEDO_PERF_CAUSAL ??= "1"

import { frameSamplingLaunchArgs, type FrameMetric } from "./frame-sampler"
import {
  fixtureFor,
  installMockApi,
  installSeedState,
  launchTo,
  monitorPage,
  sessionPath,
  startApp,
  stopApp,
  waitForTranscript,
} from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import {
  ISOLATED_INTERACTION_TIMEOUT_MS,
  measureIsolatedInteraction,
  prepareTrustedInteraction,
  settleBeforeNextInteraction,
} from "./isolated-interaction"
import { seedForScenario } from "./seed"
import {
  SESSION_SWITCH_SUBSTANTIAL_FILE_PATH,
  sessionSwitchCellPrefix,
  type SessionSwitchBlock,
  type SessionSwitchScope,
  type SessionSwitchTemperature,
  RETAINED_PANEL_BODY_HOST_SELECTOR,
  RETAINED_PANEL_BODY_INERT_ATTRIBUTE,
  type OldWorkspaceRelease,
  type StabilityRequestCounts,
} from "./session-switch-workspace-contract"

const SCENARIO = "session-switch-workspace" as const
const RENDERER_DEADLINE_MS = 16.67
const WORKSPACE_PANEL_TOGGLE_SELECTOR = "[data-testid='workspace-panel-toggle']"
const PANEL_CONTENT_SELECTOR = "[data-testid='review-pane-root']"
const REVIEW_TAB_SELECTOR =
  "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button"

/**
 * The session-ready gate is a conjunction. `stageMs` records when each of its
 * clauses FIRST held, so a slow cell names the clause that is still false
 * instead of leaving the whole gate as one opaque number.
 */
const READY_STAGES = [
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
type ReadyStage = (typeof READY_STAGES)[number]

type ProbeObservation = {
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
 * in browser-runner.ts, both module-private): `cross: false` waits only on the
 * destination session's own clock, `cross: true` additionally runs the old-
 * surface-disposal and destination-workspace clocks. Keep in sync with the
 * driver — this probe is only useful while it measures the same thing.
 */
const observeSwitch = async (params: {
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

const round = (value: number) => Math.round(value * 100) / 100
const ms = (value: number | undefined) => (value === undefined ? "n/a" : `${round(value)}ms`)

async function syntheticVisibleClick(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)
    if (!target) throw new Error(`No visible element for synthetic click: ${selector}`)
    target.click()
  }, selector)
}

async function waitForWorkspaceReviewContent(page: Page, expectedTotal: number) {
  await page.waitForFunction((expectedTotal) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    if (!shell || !visible(shell) || shell.getBoundingClientRect().width <= 120) return false
    const root = Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    if (!root) return false
    const corpus = root.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    if (!corpus || Number(corpus.dataset.reviewTotalFiles ?? "0") !== expectedTotal) return false
    if (!Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)) return false
    return !root.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
  }, expectedTotal, { timeout: 20_000 })
}

/**
 * The files navigator lives behind the panel's "Open Files" control (inside
 * `[data-testid='workspace-navigator-overlay']`), which the driver reaches via
 * measureWorkspaceFiles before it opens a file tab.
 */
async function openFilesNavigator(page: Page) {
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
async function openWorkspaceFileTab(page: Page, filePath: string) {
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
async function openFirstReviewDiff(page: Page) {
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

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const expectedTotal = fixture.changedFiles.length
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
// Stack, not just the message: a probe that only prints "RangeError" cannot
// tell you which surface produced it.
page.on("pageerror", (error) => console.log("[pageerror]", (error.stack ?? String(error)).slice(0, 2000)))
page.on("console", (message) => {
  if (message.type() === "error") console.log("[console error]", message.text().slice(0, 300))
})

const probeStarted = performance.now()
const elapsed = () => `${Math.round(performance.now() - probeStarted)}ms`

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const sessions = fixture.sessions
const home = sessions[0]!
console.log(`[probe] app=${app.baseUrl} mock=${app.mockPort} corpus=${expectedTotal} files`)
console.log(`[probe] workspace A=${fixture.workspaceDirectories[0]}  workspace B=${fixture.workspaceDirectories[1]}`)

await launchTo(page, app, sessionPath(home, home.id))
await waitForTranscript(page, fixture, home.id, home.title)
console.log(`[probe] home session ready (${elapsed()})`)

// --- The measured-cell machinery, mirroring sessionSwitchWorkspace's runCell.

// ============ Minimal repro: review revival after file tab ============
async function dumpReviewClauses(page2: Page, label: string) {
  const snapshot = await page2.evaluate(() => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']"))
    return {
      shell: shell ? { visible: visible(shell), width: shell.getBoundingClientRect().width } : null,
      roots: roots.map((root) => {
        const corpus = root.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
        const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]"))
        const first = rows[0]
        const host = root.closest("[data-testid='workspace-panel-body']") as HTMLElement | null
        return {
          rootVisible: visible(root),
          rootRect: { w: Math.round(root.getBoundingClientRect().width), h: Math.round(root.getBoundingClientRect().height) },
          rootCV: getComputedStyle(root).contentVisibility,
          hostInert: host?.getAttribute("data-panel-body-inert") ?? null,
          hostAria: host?.getAttribute("aria-hidden") ?? null,
          hostCV: host ? getComputedStyle(host).contentVisibility : null,
          corpus: corpus ? { rendered: corpus.dataset.reviewRenderedFiles, total: corpus.dataset.reviewTotalFiles, rect: { w: Math.round(corpus.getBoundingClientRect().width), h: Math.round(corpus.getBoundingClientRect().height) } } : null,
          rowCount: rows.length,
          visibleRows: rows.filter(visible).length,
          firstRow: first ? { rect: { w: Math.round(first.getBoundingClientRect().width), h: Math.round(first.getBoundingClientRect().height) }, cv: getComputedStyle(first).contentVisibility, display: getComputedStyle(first).display, ariaAncestor: !!first.closest("[aria-hidden='true']") } : null,
          ariaOwner: (() => {
            const owner = first?.closest("[aria-hidden='true']") as HTMLElement | null
            if (!owner) return null
            const dataset = Object.fromEntries(Object.entries(owner.dataset).slice(0, 8))
            return { tag: owner.tagName, cls: owner.className.slice(0, 120), dataset, cv: getComputedStyle(owner).contentVisibility, inert: owner.hasAttribute("inert") }
          })(),
        }
      }),
    }
  })
  console.log(`[clauses ${label}]`, JSON.stringify(snapshot, null, 1))
}

console.log("\n=== REPRO: open panel (review) ===")
await syntheticVisibleClick(page, WORKSPACE_PANEL_TOGGLE_SELECTOR)
try {
  await waitForWorkspaceReviewContent(page, expectedTotal)
  console.log(`[repro] STEP1 first review render OK (${elapsed()})`)
} catch {
  console.log(`[repro] STEP1 FIRST RENDER FAILED (${elapsed()})`)
  await dumpReviewClauses(page, "step1-fail")
  process.exit(1)
}

console.log("\n=== REPRO: open substantial file tab ===")
await openWorkspaceFileTab(page, SESSION_SWITCH_SUBSTANTIAL_FILE_PATH)
console.log(`[repro] STEP2 file tab open (${elapsed()})`)

console.log("\n=== REPRO: click review tab (no session switches in between) ===")
await syntheticVisibleClick(page, REVIEW_TAB_SELECTOR)
try {
  await waitForWorkspaceReviewContent(page, expectedTotal)
  console.log(`[repro] STEP3 review revival OK without switches (${elapsed()})`)
} catch {
  console.log(`[repro] STEP3 REVIVAL FAILED without switches (${elapsed()})`)
  await dumpReviewClauses(page, "step3-fail")
  await app.close?.()
  process.exit(2)
}

// With a warm within-workspace session switch between file tab and revival.
console.log("\n=== REPRO: file tab again, then a session switch, then review tab ===")
await syntheticVisibleClick(page, `[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='file'] > button`)
await page.waitForTimeout(500)
// In-app switch via the rail, exactly like the scenario driver — a page
// reload would reset the in-memory panel state and prove nothing.
{
  const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessions[2]!.id}"]`).first()
  const activate = row.locator('[data-slot="navigation-row-activate"]').first()
  await ((await activate.count()) ? activate : row).click()
}
await waitForTranscript(page, fixture, sessions[2]!.id, sessions[2]!.title)
console.log(`[repro] switched to session 2 (${elapsed()})`)
const tabStrip = await page.evaluate(() => {
  const visible = (element: Element) => {
    if (element.closest("[aria-hidden='true']")) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
  return {
    shellOpen: shell?.getAttribute("data-open") ?? "no-shell",
    shellWidth: shell ? Math.round(shell.getBoundingClientRect().width) : 0,
    tabs: Array.from(document.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']")).map((tab) => ({
      kind: tab.getAttribute("data-workspace-tab-kind"),
      visible: visible(tab),
      inShell: !!tab.closest("[data-testid='workspace-panel-shell']"),
    })),
    headerTestIds: Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid='workspace-panel-shell'] [data-testid]"),
    ).slice(0, 12).map((el) => el.dataset.testid),
  }
})
console.log("[repro] tab strip after switch:", JSON.stringify(tabStrip))
await syntheticVisibleClick(page, REVIEW_TAB_SELECTOR)
try {
  await waitForWorkspaceReviewContent(page, expectedTotal)
  console.log(`[repro] STEP4 review revival OK after switch (${elapsed()})`)
} catch {
  console.log(`[repro] STEP4 REVIVAL FAILED after switch (${elapsed()})`)
  await dumpReviewClauses(page, "step4-fail")
  await app.close?.()
  process.exit(3)
}
// STEP5: the full Block-B shape — file tab in front, then the four
// switches (within cold, within warm, ACROSS cold, ACROSS warm) that swap
// retained bodies, then back to the review tab. This is the sequence the
// scenario driver and the 12-cell probe die on.
console.log("\n=== REPRO: Block-B switch sequence, then review tab ===")
await syntheticVisibleClick(page, `[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='file'] > button`)
await page.waitForTimeout(300)
const railSwitch = async (target: (typeof sessions)[number]) => {
  const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${target.id}"]`).first()
  const activate = row.locator('[data-slot="navigation-row-activate"]').first()
  await ((await activate.count()) ? activate : row).click()
  await waitForTranscript(page, fixture, target.id, target.title)
  await page.waitForTimeout(400)
}
await railSwitch(sessions[4]!)
console.log(`[repro] within cold done (${elapsed()})`)
await railSwitch(home)
console.log(`[repro] within warm done (${elapsed()})`)
await railSwitch(sessions[3]!)
console.log(`[repro] ACROSS cold done (${elapsed()})`)
await railSwitch(home)
console.log(`[repro] ACROSS warm done (${elapsed()})`)
await dumpReviewClauses(page, "step5-before-review-click")
await syntheticVisibleClick(page, REVIEW_TAB_SELECTOR)
try {
  await waitForWorkspaceReviewContent(page, expectedTotal)
  console.log(`[repro] STEP5 review revival OK after Block-B switches (${elapsed()})`)
} catch {
  console.log(`[repro] STEP5 REVIVAL FAILED after Block-B switches (${elapsed()})`)
  await dumpReviewClauses(page, "step5-fail")
  process.exit(5)
}
console.log("[repro] ALL STEPS PASSED")
await app.close?.()
process.exit(0)
