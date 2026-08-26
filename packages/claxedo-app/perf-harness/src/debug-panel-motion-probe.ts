// TEMP probe (read-only diagnosis): which element actually animates the
// workspace panel's opening motion, and whether its transition events arrive
// early enough for `createShellSettle`'s two-frame arming checkpoint to see
// them.
//
// `createShellSettle` decides "is a motion running?" at the SECOND animation
// frame after the open flip: it only holds the construction gate for a motion
// whose `transitionrun` has arrived by then. This probe records, per open,
// every transition event on both candidate elements plus the timestamps of the
// first two animation frames, so the ordering is observed rather than assumed:
//   - workbench column   [data-testid='workbench-column']       margin-right
//   - panel shell        [data-testid='workspace-panel-shell']  transform
//
// It drives a fresh open (shell mounted by the click), a re-open (shell
// retained at its closed transform) and a settled dwell, printing each phase's
// event log stamped against the open click.
//
// Run (about 45s with a prebuilt dist):
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked port> \
//     bun src/debug-panel-motion-probe.ts
//
// The probe never touches application source; it only drives the built app.
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
import { WORKSPACE_LIFECYCLE_CLOSE_DWELL_MS } from "./workspace-lifecycle-contract"

const SCENARIO = "workspace-lifecycle" as const
const TOGGLE = "[data-testid='workspace-panel-toggle']"
const COLUMN = "[data-testid='workbench-column']"
const SHELL = "[data-testid='workspace-panel-shell']"

type MotionRecord = {
  label: string
  /** Page clock at the click, so app-side marks can be stamped against it. */
  startedAt: number
  events: Array<{ atMs: number; kind: string; target: string; property: string }>
  frames: number[]
  marks: Array<{ atMs: number; name: string }>
}

declare global {
  interface Window {
    __motionProbe?: {
      start: (label: string) => void
      read: () => MotionRecord | undefined
    }
  }
}

const installProbe = async (page: import("@playwright/test").Page) => {
  await page.evaluate(({ COLUMN, SHELL }) => {
    let record: MotionRecord | undefined
    const targetName = (node: EventTarget | null) => {
      const element = node as HTMLElement | null
      if (!element?.dataset) return "?"
      return element.dataset.testid ?? element.tagName.toLowerCase()
    }
    window.__motionProbe = {
      start(label: string) {
        const started = performance.now()
        performance.clearMarks()
        const current: MotionRecord = { label, startedAt: started, events: [], frames: [], marks: [] }
        record = current
        const listen = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector)
          if (!element) return
          for (const kind of ["transitionrun", "transitionstart", "transitionend", "transitioncancel"]) {
            element.addEventListener(kind, (event) => {
              const transition = event as TransitionEvent
              if (transition.target !== element) return
              current.events.push({
                atMs: performance.now() - started,
                kind,
                target: targetName(transition.target),
                property: transition.propertyName,
              })
            })
          }
        }
        listen(COLUMN)
        listen(SHELL)
        // Mirror the gate's own arming: two animation frames, then watch the
        // shell's published settle flag.
        requestAnimationFrame(() => {
          current.frames.push(performance.now() - started)
          requestAnimationFrame(() => {
            current.frames.push(performance.now() - started)
          })
        })
      },
      read() {
        if (!record) return undefined
        record.marks = performance.getEntriesByType("mark")
          .filter((entry) => entry.name.startsWith("LANE-"))
          .map((entry) => ({ atMs: entry.startTime - record!.startedAt, name: entry.name }))
        return record
      },
    }
  }, { COLUMN, SHELL })
}

const clickToggle = async (page: import("@playwright/test").Page, label: string) => {
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
    window.__motionProbe?.start(label)
    target.click()
  }, label)
}

const report = async (page: import("@playwright/test").Page) => {
  await page.waitForTimeout(1_200)
  const record = await page.evaluate(() => {
    const value = window.__motionProbe?.read()
    return value ? JSON.parse(JSON.stringify(value)) as MotionRecord : undefined
  })
  if (!record) {
    console.log("  (no record)")
    return
  }
  console.log(`\n=== ${record.label}`)
  console.log(`  frames (rAF#1, rAF#2): ${record.frames.map((value) => `${value.toFixed(1)}ms`).join(", ") || "(none)"}`)
  if (!record.events.length) console.log("  events: (none — no transition ran on either element)")
  const timeline = [
    ...record.events.map((event) => ({
      atMs: event.atMs,
      text: `${event.kind.padEnd(17)} ${event.target.padEnd(24)} ${event.property}`,
    })),
    ...record.marks.map((mark) => ({ atMs: mark.atMs, text: mark.name })),
  ].sort((a, b) => a.atMs - b.atMs)
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

// Phase 1: FRESH OPEN — the panel shell is mounted by this very click.
await clickToggle(page, "FRESH OPEN (shell mounted by the click)")
await page.waitForFunction(() => {
  const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
  return !!shell && !!shell.querySelector("[data-review-file]")
}, undefined, { timeout: 12_000 })
await report(page)

// Phase 2: CLOSE.
await settleBeforeNextInteraction(page)
await clickToggle(page, "CLOSE")
await waitForClosed(page)
await report(page)

// Phase 3: RETAINED RE-OPEN — open, close, then re-open INSIDE the close grace,
// so the shell is still mounted at its closed transform and its own transform
// transition runs alongside the column's margin.
await settleBeforeNextInteraction(page)
await clickToggle(page, "warm-up open")
await page.waitForFunction(() => !!document.querySelector("[data-testid='workspace-panel-shell'][data-open='true']"), undefined, { timeout: 12_000 })
await settleBeforeNextInteraction(page)
await clickToggle(page, "warm-up close")
await page.waitForTimeout(40)
await installProbe(page)
await clickToggle(page, "RETAINED RE-OPEN (shell still mounted, inside close grace)")
await page.waitForFunction(() => !!document.querySelector("[data-testid='workspace-panel-shell'][data-open='true']"), undefined, { timeout: 12_000 })
await report(page)

await browser.close()
await stopApp(app)
