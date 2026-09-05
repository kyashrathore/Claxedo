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
import { chromium, type Page } from "@playwright/test"
// Causal attribution (script/style/layout + the trusted-window trace) is
// opt-in inside frame-sampler, read at call time. The probe exists to print
// that attribution, so it turns the flag on for itself unless overridden.
process.env.CLAXEDO_PERF_CAUSAL ??= "1"

import { frameSamplingLaunchArgs } from "./frame-sampler"
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
import { seedForScenario } from "./seed"
import { SESSION_SWITCH_SUBSTANTIAL_FILE_PATH } from "./session-switch-workspace-contract"

const SCENARIO = "session-switch-workspace" as const
const WORKSPACE_PANEL_TOGGLE_SELECTOR = "[data-testid='workspace-panel-toggle']"
const REVIEW_TAB_SELECTOR =
  "[data-testid='workspace-panel-shell'][data-open='true'] [data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button"

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

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const expectedTotal = fixture.changedFiles.length
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const shutdown = async (code: number): Promise<never> => {
  await browser.close()
  await stopApp(app)
  process.exit(code)
}
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
  await shutdown(1)
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
  await shutdown(2)
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
  await shutdown(3)
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
  await shutdown(5)
}
console.log("[repro] ALL STEPS PASSED")
await shutdown(0)
