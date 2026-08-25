// TEMP probe (read-only diagnosis): attributes the `open_close_interrupt`
// phase of the `workspace-lifecycle` scenario — which requests land inside its
// trusted window, and what the panel actually does while the interrupting
// close is waiting to be acknowledged.
//
// It reproduces phases 1 and 2 of browser-runner.ts -> workspaceLifecycle
// (cold open, close, dwell, then open-interrupted-by-close, the last repeated
// PROBE_REPEATS times because the driver's leak is intermittent) and prints:
//   - BOOT TIMELINE       every request from transcript-ready onward, each
//                         stamped relative to the cold-open click, so the
//                         review surface's chunk loads are visible with the
//                         moment they happened and are never inferred
//   - RAIL / API DEBUG    the app's own `claxedo.debug.sidebar-requests` and
//                         `claxedo.debug.request-loop` channels, which name the
//                         caller behind each `/session/status` batch
//   - TOGGLE CYCLE        requests in the neighbourhood of a plain
//                         open-then-close toggle pair, to separate traffic the
//                         toggle causes from traffic that merely coincides
//   - INTERRUPT PHASE     per repeat: ack, in-window requests with URL and
//                         initiator, and the script/style/layout split
//
// What it established: the review surface's chunks (review-workspace,
// select-file, role-guarded-terminal, time, popover) are requested exactly ONCE
// per page — at the boot idle warm-up, about 28ms after transcript-ready — and
// never again, so they cannot appear in a later interrupt window. The requests
// that do land there are unrelated background traffic (the rail's
// session-status batch, /global/health, /api/wr/runtime-events).
//
// Run (about 60s with a prebuilt dist):
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked port> \
//     bun src/debug-warm-race-probe.ts [--early]
// `--early` drops the settle wait before the cold open so the phase pair runs
// at the driver's own early page-clock position. See debug-session-switch-probe.ts
// for why those two env vars exist and how to read the baked mock port.
//
// The probe never touches application source; it only drives the built app.
import { chromium, type Page } from "@playwright/test"
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
import {
  ISOLATED_INTERACTION_TIMEOUT_MS,
  measureIsolatedInteraction,
  prepareTrustedInteraction,
  prepareTrustedWindowInteraction,
  settleBeforeNextInteraction,
} from "./isolated-interaction"
import { seedForScenario } from "./seed"
import {
  WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS,
  WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS,
} from "./workspace-lifecycle-contract"

const SCENARIO = "workspace-lifecycle" as const
const TOGGLE = "[data-testid='workspace-panel-toggle']"
const EARLY = process.argv.includes("--early")

const syntheticVisibleClick = async (page: Page, selector: string, mark?: string) => {
  await page.evaluate(({ selector, mark }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)
    if (!target) throw new Error(`No visible element for synthetic click: ${selector}`)
    if (mark) {
      performance.clearMarks(mark)
      performance.mark(mark)
    }
    target.click()
  }, { selector, mark: mark ?? undefined })
}

const relayNextTrustedPointerdown = async (page: Page) => {
  await page.evaluate((selector) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    window.addEventListener(
      "pointerdown",
      function relay(event) {
        if (!event.isTrusted) return
        window.removeEventListener("pointerdown", relay, true)
        Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)?.click()
      },
      { capture: true },
    )
  }, TOGGLE)
}

const waitForClosed = async (page: Page) => {
  await page.waitForFunction(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
    return !shell || (
      shell.dataset.open === "false" &&
      (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
    )
  }, undefined, { timeout: 5_000 })
}

const headerInertPoint = async (page: Page) => {
  const rect = await page.locator("[data-testid='workbench-shell-header']").first().boundingBox()
  if (!rect) throw new Error("workbench shell header had no bounds")
  return { x: rect.x + 60, y: rect.y + rect.height / 2 }
}

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", (error.stack ?? String(error)).slice(0, 800)))

// The rail's own request-loop debug channel names WHY each status batch went
// out (fetch-group / skip-fresh / skip-in-flight / target-groups).
await page.addInitScript(() => {
  try {
    localStorage.setItem("claxedo.debug.sidebar-requests", "1")
    localStorage.setItem("claxedo.debug.request-loop", "1")
  } catch {}
})
const consoleLines: Array<{ atMs: number; text: string }> = []
page.on("console", (message) => {
  const text = message.text()
  if (!text.includes("claxedo:sidebar-requests") && !text.includes("claxedo:api-fetch")) return
  if (text.includes("claxedo:api-fetch") && !text.includes("start")) return
  consoleLines.push({ atMs: performance.now(), text: text.slice(0, 700) })
})

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const session = fixture.sessions[0]!
console.log(`[probe] mode=${EARLY ? "early (click before any idle slice)" : "default"} corpus=${fixture.changedFiles.length}`)
await launchTo(page, app, sessionPath(session, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
const readyAt = await page.evaluate(() => {
  performance.setResourceTimingBufferSize?.(2_000)
  return performance.now()
})
console.log(`[probe] transcript ready at page-clock ${Math.round(readyAt)}ms`)

if (!EARLY) await page.waitForTimeout(1_500)

// Phase 1: cold open.
const coldControl = await prepareTrustedInteraction(page, page.locator(`${TOGGLE}:visible`).last(), "probe-cold-open")
const coldClickAt = await page.evaluate(() => performance.now())
await page.mouse.click(coldControl.x, coldControl.y)
await page.waitForFunction(() => {
  const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
  return !!shell && !!shell.querySelector("[data-review-file]")
}, undefined, { timeout: 12_000 })

const bootTimeline = await page.evaluate(({ readyAt, coldClickAt }) => {
  return performance
    .getEntriesByType("resource")
    .filter((entry) => !entry.name.startsWith("data:"))
    .map((entry) => ({
      name: entry.name.replace(/^https?:\/\/[^/]+/, ""),
      startMs: Math.round(entry.startTime),
      sinceReadyMs: Math.round(entry.startTime - readyAt),
      sinceColdClickMs: Math.round(entry.startTime - coldClickAt),
      durationMs: Math.round(entry.duration),
    }))
    .filter((entry) => entry.startMs >= readyAt - 5)
}, { readyAt, coldClickAt })

console.log(`\n=== BOOT TIMELINE (requests at/after transcript-ready; cold click at +${Math.round(coldClickAt - readyAt)}ms)`)
for (const entry of bootTimeline) {
  console.log(
    `  ${String(entry.sinceReadyMs).padStart(6)}ms  (click${entry.sinceColdClickMs >= 0 ? "+" : ""}${entry.sinceColdClickMs}ms)  ${String(entry.durationMs).padStart(4)}ms  ${entry.name}`,
  )
}
if (bootTimeline.length === 0) console.log("  (none)")

console.log(`\n=== RAIL / API DEBUG LINES (probe clock)`)
for (const line of consoleLines) console.log(`  ${Math.round(line.atMs)}  ${line.text}`)

await settleBeforeNextInteraction(page)
await syntheticVisibleClick(page, TOGGLE)
await waitForClosed(page)
await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
await settleBeforeNextInteraction(page)

// Phase 2: open interrupted by close, measured exactly as the driver does.
// Repeated, because the request leak the driver reports is intermittent and
// one sample cannot tell a clean build from a lucky window.
// Toggle-attribution pass: plain open, wait the interrupt delay, close — the
// same input shape as the measured phase, but with the app's own rail debug
// lines and every request in the toggle's neighbourhood printed together.
for (let cycle = 1; cycle <= 4; cycle++) {
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
  await settleBeforeNextInteraction(page)
  const before = consoleLines.length
  const openAt = await page.evaluate(() => performance.now())
  await syntheticVisibleClick(page, TOGGLE)
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS)
  await syntheticVisibleClick(page, TOGGLE)
  await waitForClosed(page)
  await page.waitForTimeout(300)
  const around = await page.evaluate((openAt) =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => entry.startTime >= openAt - 50 && entry.startTime <= openAt + 400)
      .map((entry) => ({
        name: entry.name.replace(/^https?:\/\/[^/]+/, "").split("?")[0],
        atMs: Math.round(entry.startTime - openAt),
      })),
  openAt)
  console.log(`\n=== TOGGLE CYCLE #${cycle} (open at 0ms, close at +${WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS}ms)`)
  for (const entry of around) console.log(`    request  +${String(entry.atMs).padStart(4)}ms  ${entry.name}`)
  for (const line of consoleLines.slice(before)) console.log(`    rail     ${line.text}`)
}

const REPEATS = Number(process.env.PROBE_REPEATS ?? "8")
for (let repeat = 1; repeat <= REPEATS; repeat++) {
await runInterrupt(repeat)
await waitForClosed(page)
await page.waitForTimeout(WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS)
await settleBeforeNextInteraction(page)
}

await browser.close()
await stopApp(app)

async function runInterrupt(repeat: number) {
const inertPoint = await headerInertPoint(page)
const control = await prepareTrustedWindowInteraction(page, "probe-open-close-interrupt")
const openMark = `probe-open-${crypto.randomUUID()}`
const interrupt = await measureIsolatedInteraction<{
  completionMs: number
  acknowledgedMs?: number
  timedOut: boolean
  requests: Array<{ name: string; startMs: number; durationMs: number; initiator: string }>
  openToCloseMs?: number
}>(page, "probe-open-close-interrupt", async () => {
  await relayNextTrustedPointerdown(page)
  await syntheticVisibleClick(page, TOGGLE, openMark)
  await page.waitForTimeout(WORKSPACE_LIFECYCLE_INTERRUPT_DELAY_MS)
  await page.mouse.click(inertPoint.x, inertPoint.y)
  return await page.evaluate(async ({ mark, openMark, timeoutMs }) => {
    const openedAt = performance.getEntriesByName(openMark, "mark").at(-1)?.startTime
    const started = performance.getEntriesByName(mark, "mark").at(-1)?.startTime
    if (started === undefined) throw new Error("probe: trusted interrupting close did not emit pointerdown")
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
        if (closed) return resolve(elapsed)
        if (elapsed >= timeoutMs) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    // Every request that STARTED at or after the trusted pointerdown — the
    // same crop the frame sampler's causal recorder applies.
    const requests = performance
      .getEntriesByType("resource")
      .filter((entry) => !entry.name.startsWith("data:") && entry.startTime >= started)
      .map((entry) => ({
        name: entry.name.replace(/^https?:\/\/[^/]+/, ""),
        startMs: Math.round(entry.startTime - started),
        durationMs: Math.round(entry.duration),
        initiator: (entry as PerformanceResourceTiming).initiatorType,
      }))
    performance.clearMarks(mark)
    performance.clearMarks(openMark)
    return {
      completionMs,
      acknowledgedMs,
      timedOut: completionMs >= timeoutMs,
      requests,
      openToCloseMs: openedAt === undefined ? undefined : started - openedAt,
    }
  }, { mark: control.mark, openMark, timeoutMs: ISOLATED_INTERACTION_TIMEOUT_MS })
})

const observation = interrupt.observation
console.log(`\n=== INTERRUPT PHASE #${repeat}`)
console.log(`  ack ${observation.acknowledgedMs?.toFixed(1)}ms  completion ${observation.completionMs.toFixed(1)}ms  open->close offset ${observation.openToCloseMs?.toFixed(1)}ms`)
console.log(`  in-window requests: ${observation.requests.length}`)
for (const request of observation.requests) {
  console.log(`    +${String(request.startMs).padStart(4)}ms  ${String(request.durationMs).padStart(4)}ms  [${request.initiator}]  ${request.name}`)
}
console.log(`  sampler-cropped count: ${interrupt.metric.causal?.resources?.filter((r) => !r.name.startsWith("data:")).length ?? "n/a"}`)
console.log(`  script ${interrupt.metric.causal?.performance?.scriptMs?.toFixed(1)}ms  style ${interrupt.metric.causal?.performance?.recalcStyleMs?.toFixed(1)}ms  layout ${interrupt.metric.causal?.performance?.layoutMs?.toFixed(1)}ms`)
for (const frame of interrupt.metric.causal?.longAnimationFrames ?? []) {
  console.log(`    LoAF start=${frame.startTime.toFixed(0)} dur=${frame.duration.toFixed(0)}ms blocking=${frame.blockingDuration.toFixed(0)}ms`)
  for (const script of frame.scripts) {
    console.log(`       script ${script.invokerType} ${script.invoker.slice(0, 90)} dur=${script.duration.toFixed(0)}ms fn=${script.sourceFunctionName}`)
  }
}
for (const task of interrupt.metric.causal?.longTasks ?? []) {
  console.log(`    longtask start=${task.startTime.toFixed(0)} dur=${task.duration.toFixed(0)}ms ${task.name}`)
}
}
