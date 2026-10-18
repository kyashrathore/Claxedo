import type { CDPSession, Page } from "@playwright/test"
import { traceEventsFrom, type TraceEvent } from "../../harness/trace-events"
import type { CpuProfile } from "../panel/trace"

export type Target =
  | { kind: "session"; sessionId: string; replyIds: string[]; start: "navigation" | "pointerdown" | "now" }
  | { kind: "text"; sessionId: string; text: string; start: "now" }

export type Census = { railRows: number; timelineRows: number; elements: number; removed: number; attributes: number; text: number }
export type Ready = { startAt: number; readyAt: number; markNow: number }
export type Probed = { rail: { at: number; count: number }[]; counts: Census }

export type Capture = {
  events: TraceEvent[]
  profile: CpuProfile & { startTime: number; endTime: number }
  ready: Ready
  probed: Probed
}

const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "v8.execute",
  "blink.user_timing",
  "loading",
  "toplevel",
  ...(process.env.MT_TRACE_EXTRA?.split(",") ?? []),
]
const QUIET_MS = 1000
const QUIET_CAP_MS = 20_000
const READY_TIMEOUT_MS = 180_000

type MainThread = { __mainThread: { arm(target: Target): void; done(): Promise<Ready>; finish(): Probed; quietFor(): number } }

export const dwell = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function quiet(page: Page) {
  const deadline = Date.now() + QUIET_CAP_MS
  while (Date.now() < deadline && (await page.evaluate(() => (window as unknown as MainThread).__mainThread.quietFor())) < QUIET_MS) await dwell(100)
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 5_000 })))
}

export function arm(page: Page, target: Target) {
  return page.evaluate((value) => (window as unknown as MainThread).__mainThread.arm(value), target)
}

async function readyOf(page: Page) {
  return page.evaluate((timeout) => Promise.race([
    (window as unknown as MainThread).__mainThread.done(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the page never reached its ready state")), timeout)),
  ]), READY_TIMEOUT_MS)
}

export async function startCapture(cdp: CDPSession) {
  const events: TraceEvent[] = []
  const collect = (payload: unknown) => events.push(...traceEventsFrom(payload))
  cdp.on("Tracing.dataCollected", collect)
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: CATEGORIES } })
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 })
  await cdp.send("Profiler.start")
  return async (page: Page): Promise<Capture> => {
    const ready = await readyOf(page)
    await quiet(page)
    const probed = await page.evaluate(() => (window as unknown as MainThread).__mainThread.finish())
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: Capture["profile"] }
    const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()))
    await cdp.send("Tracing.end")
    await complete
    cdp.off("Tracing.dataCollected", collect)
    return { events, profile, ready, probed }
  }
}
