// TEMP probe (read-only diagnosis): how the panel body's construction task is
// composed, and whether splitting it at a chunk boundary bounds the task the
// open-close interrupt's close click has to wait behind.
//
// It records, per open, every `CC-` mark the instrumented app emits plus every
// long task the renderer reports, stamped against the opening click. Phase 2
// repeats the lifecycle scenario's interrupt (open, then close mid-motion) and
// reports the acknowledgement delay the same way the contract measures it.
//
// Run (about 60s with a prebuilt dist):
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked port> \
//     bun src/debug-construct-chunk-probe.ts
//
// The probe never modifies application source; it only drives the built app.
import { chromium } from "@playwright/test"
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
import { settleBeforeNextInteraction } from "./isolated-interaction"
import { seedForScenario } from "./seed"

const SCENARIO = "workspace-lifecycle" as const

type ChunkRecord = {
  label: string
  startedAt: number
  marks: Array<{ atMs: number; name: string }>
  tasks: Array<{ atMs: number; durationMs: number }>
  ackMs?: number
  rows?: number
}

declare global {
  interface Window {
    __chunkProbe?: {
      start: (label: string) => void
      ack: () => void
      read: () => ChunkRecord | undefined
    }
  }
}

const installProbe = async (page: import("@playwright/test").Page) => {
  await page.evaluate(() => {
    let record: ChunkRecord | undefined
    let observer: PerformanceObserver | undefined
    window.__chunkProbe = {
      start(label: string) {
        const started = performance.now()
        performance.clearMarks()
        const current: ChunkRecord = { label, startedAt: started, marks: [], tasks: [] }
        record = current
        observer?.disconnect()
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            current.tasks.push({ atMs: entry.startTime - started, durationMs: entry.duration })
          }
        })
        try {
          observer.observe({ entryTypes: ["longtask"] })
        } catch {
          observer = undefined
        }
      },
      // Clocks the close exactly as the lifecycle contract does: from the
      // interrupting click to the first frame that observes `data-open=false`.
      ack() {
        if (!record) return
        performance.mark("CC-close")
        const closedAt = performance.now()
        const poll = () => {
          if (!record || record.ackMs !== undefined) return
          const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
          if (!shell || shell.dataset.open === "false") {
            record.ackMs = performance.now() - closedAt
            return
          }
          requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
      },
      read() {
        if (!record) return undefined
        record.rows = document.querySelectorAll("[data-review-file]").length
        record.marks = performance.getEntriesByType("mark")
          .filter((entry) => entry.name.startsWith("CC-"))
          .map((entry) => ({ atMs: entry.startTime - record!.startedAt, name: entry.name }))
          .sort((a, b) => a.atMs - b.atMs)
        return record
      },
    }
  })
}

const clickToggle = async (page: import("@playwright/test").Page, label: string | undefined) => {
  await page.evaluate((label) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const target = Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid='workspace-panel-toggle']"),
    ).filter(visible).at(-1)
    if (!target) throw new Error("no visible workspace panel toggle")
    if (label !== undefined) window.__chunkProbe?.start(label)
    target.click()
  }, label)
}

const report = async (page: import("@playwright/test").Page) => {
  const record = await page.evaluate(() => {
    const value = window.__chunkProbe?.read()
    return value ? JSON.parse(JSON.stringify(value)) as ChunkRecord : undefined
  })
  if (!record) {
    console.log("  (no record)")
    return
  }
  console.log(`\n=== ${record.label}`)
  if (record.ackMs !== undefined) console.log(`  close ack: ${record.ackMs.toFixed(1)}ms`)
  console.log(`  review rows in DOM: ${record.rows}`)
  const timeline = [
    ...record.marks.map((mark) => ({ atMs: mark.atMs, text: mark.name })),
    ...record.tasks.map((task) => ({
      atMs: task.atMs,
      text: `[longtask ${task.durationMs.toFixed(1)}ms]`,
    })),
  ].sort((a, b) => a.atMs - b.atMs)
  if (!timeline.length) console.log("  (no marks, no long tasks)")
  for (const entry of timeline) {
    console.log(`  ${entry.atMs.toFixed(1).padStart(8)}ms  ${entry.text}`)
  }
}

const waitForClosed = async (page: import("@playwright/test").Page) => {
  await page.waitForFunction(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
    return !shell || (
      shell.dataset.open === "false" &&
      (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
    )
  }, undefined, { timeout: 5_000 })
}

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", (error.stack ?? String(error)).slice(0, 800)))

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const session = fixture.sessions[0]!
await launchTo(page, app, sessionPath(session, session.id))
await waitForTranscript(page, fixture, session.id, session.title)
await page.waitForTimeout(1_500)
await installProbe(page)

// Phase 1: FRESH OPEN — the construction the interrupt has to survive.
await clickToggle(page, "FRESH OPEN — construction composition")
await page.waitForFunction(() => {
  const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
  return !!shell && !!shell.querySelector("[data-review-file]")
}, undefined, { timeout: 12_000 })
await page.waitForTimeout(600)
await report(page)

const isOpen = (page: import("@playwright/test").Page) =>
  page.evaluate(() => !!document.querySelector("[data-testid='workspace-panel-shell'][data-open='true']"))

// Phase 2: the lifecycle contract's open-close interrupt, three times.
for (let attempt = 1; attempt <= 3; attempt += 1) {
  await settleBeforeNextInteraction(page)
  if (await isOpen(page)) {
    await clickToggle(page, undefined)
    await waitForClosed(page)
  }
  await page.waitForTimeout(400)
  await installProbe(page)
  await clickToggle(page, `INTERRUPT ${attempt} — close at +40ms`)
  await page.waitForTimeout(40)
  await page.evaluate(() => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const target = Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid='workspace-panel-toggle']"),
    ).filter(visible).at(-1)
    if (!target) throw new Error("no visible workspace panel toggle")
    window.__chunkProbe?.ack()
    target.click()
  })
  await waitForClosed(page)
  await page.waitForTimeout(600)
  await report(page)
}

await browser.close()
await stopApp(app)
