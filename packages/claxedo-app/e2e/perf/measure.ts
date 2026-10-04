import type { Browser, CDPSession, Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { installPaintedFrames } from "../harness/painted-frames"
import { acpScriptToken } from "../../../harness/e2e/harness/acp/script"
import type { ClaxedoApi } from "../harness/api"
import type { Stack } from "../harness/stack"
import { sessionRoute } from "../harness/ui-names"
import type { Workspace } from "../../../harness/e2e/harness/workspaces"
import type { AppOrigin } from "./origin"
import type { Options, Variant } from "./options"
import { longReplyScript, STREAM_END, streamScript } from "./stream-script"
import { loafScripts, summarize, type Metrics, type Probe, type Profile } from "./summary"

export type Run = {
  browser: Browser
  variant: Variant
  origin: AppOrigin
  api: ClaxedoApi
  stack: Stack
  workspace: Workspace
  sessionId: string
  run: number
  options: Options
  lastSeedText: string
}

const QUIET_MS = 1000
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "v8.execute",
  "blink.user_timing",
  "loading",
  "latencyInfo",
]

async function until(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function quiet(page: Page) {
  return until(
    () => page.evaluate((ms) => performance.now() - (window as unknown as { __streamProbe: { lastMutationAt: number } }).__streamProbe.lastMutationAt > ms, QUIET_MS),
    "a quiet DOM",
  )
}

function idle(api: ClaxedoApi, workspace: Workspace, sessionId: string) {
  return until(async () => {
    const status = (await api.status(workspace.directory))[sessionId]
    return !status || status.type === "idle"
  }, "the session to go idle")
}

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const result = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }
  return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]))
}

async function usedHeap(cdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage")
  return ((await cdp.send("Runtime.getHeapUsage")) as { usedSize: number }).usedSize
}

async function startTrace(cdp: CDPSession) {
  const chunks: unknown[] = []
  cdp.on("Tracing.dataCollected", (event: { value: unknown[] }) => chunks.push(...event.value))
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: TRACE_CATEGORIES } })
  return async (file: string) => {
    const done = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()))
    await cdp.send("Tracing.end")
    await done
    await fs.writeFile(file, JSON.stringify({ traceEvents: chunks }))
  }
}

function probeCall(page: Page, method: "start" | "stop") {
  return page.evaluate((name) => (window as unknown as { __streamProbe: Record<string, () => void> }).__streamProbe[name](), method)
}

async function streamTurn(input: Run, page: Page) {
  const { api, stack, workspace, sessionId, variant, run, options } = input
  const script = `stream-${variant.name}-${run}`
  await stack.acp.write(script, options.long ? longReplyScript(workspace.directory) : streamScript(workspace.directory))
  const sentAt = Date.now()
  await api.promptAsync(workspace.directory, sessionId, `Write the long report. ${acpScriptToken(script)}`)
  await page.getByText(STREAM_END).first().waitFor({ state: "visible", timeout: 180_000 })
  const streamMs = Date.now() - sentAt
  await idle(api, workspace, sessionId)
  await quiet(page)
  return streamMs
}

async function recorded(input: Run, page: Page, cdp: CDPSession) {
  const { options } = input
  const base = path.join(options.out, `${options.label}-${input.variant.name}-run${input.run}`)
  if (options.throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.throttle })
  await cdp.send("Performance.enable", { timeDomain: "timeTicks" })
  await cdp.send("HeapProfiler.enable")
  const heapBefore = await usedHeap(cdp)
  if (options.heap) await cdp.send("HeapProfiler.startSampling", { samplingInterval: 16384 })
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 })
  const endTrace = options.trace ? await startTrace(cdp) : undefined
  await cdp.send("Profiler.start")
  const before = await metrics(cdp)
  await probeCall(page, "start")
  const streamMs = await streamTurn(input, page)
  await probeCall(page, "stop")
  const after = await metrics(cdp)
  const { profile } = (await cdp.send("Profiler.stop")) as { profile: Profile }
  await endTrace?.(`${base}.trace.json`)
  const heapAfter = await usedHeap(cdp)
  const nodes = (await metrics(cdp)).Nodes ?? 0
  if (options.heap) {
    const { profile: heapProfile } = (await cdp.send("HeapProfiler.stopSampling")) as { profile: unknown }
    await fs.writeFile(`${base}.heapprofile`, JSON.stringify(heapProfile))
  }
  const probe = (await page.evaluate(() => {
    const { startedAt, stoppedAt, arrivals, latencies, frames, loafs, gaps } = (window as unknown as { __streamProbe: Probe }).__streamProbe
    return { startedAt, stoppedAt, arrivals, latencies, frames, loafs, gaps }
  })) as Probe
  await fs.writeFile(`${base}.cpuprofile`, JSON.stringify(profile))
  const summary = { app: input.variant.name, run: input.run, label: options.label, streamMs, ...summarize({ probe, before, after, profile, heap: { before: heapBefore, after: heapAfter, nodes } }) }
  const loafTop = loafScripts(probe)
  await fs.writeFile(`${base}.json`, JSON.stringify({ ...summary, loafTop, loafs: probe.loafs, frames: probe.frames, latencies: probe.latencies }, null, 1))
  return { ...summary, loafTop }
}

export async function measure(input: Run) {
  const context = await input.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-US", timezoneId: "UTC" })
  await context.addInitScript("globalThis.__name = (target) => target")
  await context.addInitScript(installPaintedFrames)
  await context.addInitScript({ path: path.join(import.meta.dirname, "probe.js") })
  try {
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await page.goto(new URL(sessionRoute(input.workspace.id, input.sessionId), input.origin.url).toString())
    await page.getByText(input.lastSeedText).first().waitFor({ state: "visible", timeout: 60_000 })
    await quiet(page)
    return await recorded(input, page, cdp)
  } finally {
    await context.close()
  }
}
