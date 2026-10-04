import type { CDPSession, Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { acpScriptToken } from "../../../../harness/e2e/harness/acp/script"
import { sessionRoute } from "../../harness/ui-names"
import { longReplyScript, streamScript } from "../stream-script"
import { recordScreen } from "./screen"
import { desktopSurface, dwell, mainThreadIdle, seedSession, turnStarted, webSurface, type Surface } from "./surface"
const SEED_TURNS = Number(process.env.SEED_TURNS ?? "8")
const SWITCHES = Number(process.env.SWITCHES ?? "30")
const SCENARIO = process.env.SCENARIO ?? "one"
const THROTTLE = Number(process.env.THROTTLE ?? "1")
const SCALE = Number(process.env.SCALE ?? "1")
const COLD = Number(process.env.COLD ?? "4")
const ROUNDS = Number(process.env.ROUNDS ?? "3")
const PROFILE = process.env.PROFILE === "1"
const TRACE_FROM = Number(process.env.TRACE_FROM ?? "-1")
const TRACE_COUNT = Number(process.env.TRACE_COUNT ?? "4")
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "v8.execute",
  "blink.user_timing",
  "latencyInfo",
  "cc",
  "viz",
  "gpu",
]

async function startTrace(cdp: CDPSession) {
  const chunks: unknown[] = []
  cdp.on("Tracing.dataCollected", (event) => chunks.push(...event.value))
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: TRACE_CATEGORIES } })
  return async (file: string) => {
    const done = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()))
    await cdp.send("Tracing.end")
    await done
    await fs.writeFile(file, JSON.stringify({ traceEvents: chunks }))
  }
}
const OUT = process.env.OUT ?? path.join(process.env.HOME ?? "", "test/claxedo-perf-private/perf/stream-switch/run")
const TARGET = process.env.TARGET ?? "web"
const VIDEO = process.env.VIDEO === "1"

type ScreencastFrame = { wall: number; data: Buffer }

async function startStream(surface: Surface, sessionId: string, name: string) {
  const { api, workspace } = surface
  await surface.writeScript(name, process.env.STREAM === "report" ? streamScript(workspace.directory) : longReplyScript(workspace.directory))
  const before = (await api.messages(workspace.directory, sessionId)).length
  await api.promptAsync(workspace.directory, sessionId, `Write the long report. ${acpScriptToken(name)}`)
  await turnStarted(surface, sessionId, before)
}

async function startScreencast(cdp: CDPSession, frames: ScreencastFrame[]) {
  cdp.on("Page.screencastFrame", (event) => {
    frames.push({ wall: (event.metadata.timestamp ?? 0) * 1000, data: Buffer.from(event.data, "base64") })
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined)
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 })
}

async function railRow(page: Page, sessionId: string) {
  const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`)
  const box = await row.boundingBox({ timeout: 5000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(OUT, "missing-row.png") })
    throw error
  })
  if (!box) throw new Error(`no rail row for ${sessionId}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function jitter(index: number) {
  return 450 + ((index * 7919) % 900)
}

function plan(scenario: string, cold: number) {
  const coldTitles = Array.from({ length: cold }, (_, index) => `Cold ${index + 1}`)
  if (scenario === "cold") return { seeded: ["Alpha", ...coldTitles], streaming: ["Alpha", ...coldTitles], clicks: coldTitles.flatMap((title) => [title, "Alpha"]) }
  const clicks = Array.from({ length: SWITCHES }, (_, index) => (index % 2 === 0 ? "Beta" : "Alpha"))
  return { seeded: ["Alpha", "Beta"], streaming: scenario === "both" ? ["Alpha", "Beta"] : ["Alpha"], clicks }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const surface = TARGET === "desktop" ? await desktopSurface() : await webSurface(SCALE)
  try {
    const { workspace } = surface
    const steps = plan(SCENARIO, COLD)
    const ids: Record<string, string> = {}
    for (const title of steps.seeded) ids[title] = await seedSession(surface, title, SEED_TURNS)
    console.log(`[switch] seeded ${steps.seeded.length} sessions, ${SEED_TURNS} turns each`)
    const { page, cdp, bounds } = await surface.open()
    const seeded = page.getByText(`Seed turn ${SEED_TURNS} done.`).first()
    const first = steps.seeded.includes("Beta") ? ids.Beta : ids.Alpha
    if (TARGET === "desktop") {
      await page.reload()
      await page.locator('[data-testid="rail-sidebar-session-row"]').first().waitFor({ state: "visible", timeout: 60_000 })
      await page.mouse.click(...Object.values(await railRow(page, first)) as [number, number])
    } else {
      await page.goto(`${surface.url}${sessionRoute(workspace.id, first)}`)
    }
    await seeded.waitFor({ state: "visible", timeout: 60_000 })
    if (first !== ids.Alpha) {
      await page.mouse.click(...Object.values(await railRow(page, ids.Alpha)) as [number, number])
      await seeded.waitFor({ state: "visible", timeout: 60_000 })
    }
    if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })
    const screencast: ScreencastFrame[] = []
    await startScreencast(cdp, screencast)
    const video = VIDEO ? recordScreen(bounds, path.join(OUT, "screen.mov"), Math.ceil((steps.clicks.length * 1.0 + 4) * (SCENARIO === "cold" ? ROUNDS : 1))) : undefined
    await page.evaluate(() => (window as unknown as { __switchProbe: { start(): void } }).__switchProbe.start())
    for (const title of steps.streaming) await startStream(surface, ids[title], `stream-${title.replace(/ /g, "-")}`)
    await mainThreadIdle(page)
    if (PROFILE) {
      await cdp.send("Profiler.enable")
      await cdp.send("Profiler.setSamplingInterval", { interval: 250 })
      await cdp.send("Profiler.start")
    }
    const clicks: { title: string; wall: number }[] = []
    const rounds: unknown[] = []
    let endTrace: ((file: string) => Promise<void>) | undefined
    for (let round = 0; round < (SCENARIO === "cold" ? ROUNDS : 1); round += 1) {
      if (round > 0) {
        rounds.push(await page.evaluate(() => (window as unknown as { __switchProbe: { stop(): unknown } }).__switchProbe.stop()))
        await page.reload()
        await page.locator('[data-testid="session-page-root"] [data-timeline-key]').first().waitFor({ state: "visible", timeout: 60_000 })
        await mainThreadIdle(page)
        await page.evaluate(() => (window as unknown as { __switchProbe: { start(): void } }).__switchProbe.start())
      }
      for (const [index, title] of steps.clicks.entries()) {
        if (index === TRACE_FROM) endTrace = await startTrace(cdp)
        if (index === TRACE_FROM + TRACE_COUNT && endTrace) {
          await endTrace(path.join(OUT, "switch.trace.json"))
          endTrace = undefined
        }
        const row = await railRow(page, ids[title])
        clicks.push({ title, wall: Date.now() })
        await page.mouse.click(row.x, row.y)
        await dwell(jitter(index))
      }
    }
    await mainThreadIdle(page)
    if (PROFILE) {
      const { profile } = (await cdp.send("Profiler.stop")) as { profile: unknown }
      await fs.writeFile(path.join(OUT, "switch.cpuprofile"), JSON.stringify(profile))
    }
    rounds.push(await page.evaluate(() => (window as unknown as { __switchProbe: { stop(): unknown } }).__switchProbe.stop()))
    await cdp.send("Page.stopScreencast")
    await video?.done
    const framesDir = path.join(OUT, "frames")
    await fs.mkdir(framesDir, { recursive: true })
    const index = screencast.map((frame, n) => ({ n, wall: frame.wall, file: `f${String(n).padStart(5, "0")}.jpg` }))
    await Promise.all(screencast.map((frame, n) => fs.writeFile(path.join(framesDir, index[n].file), frame.data)))
    await fs.writeFile(path.join(OUT, "recording.json"), JSON.stringify({ target: TARGET, alpha: ids.Alpha, beta: ids.Beta, ids, scenario: SCENARIO, clicks, videoStartedAt: video?.startedAt, bounds, screencast: index, rounds }))
    console.log(`[switch] ${clicks.length} switches, ${screencast.length} screencast frames, out ${OUT}`)
  } finally {
    await surface.close()
  }
}

await main()
