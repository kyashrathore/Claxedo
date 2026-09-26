import type { CDPSession, Page } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installRecorder, type Predicate, type Recording } from "./recorder"
import { createSourceMapper, summarizeProfile, summarizeTrace, type CpuProfile, type TraceEvent } from "./trace"

export const OUT = process.env.PANEL_OUT ?? path.join(os.tmpdir(), "panel-perf")
const TRACE_CATEGORIES = process.env.PANEL_TRACE_ALL === "1"
  ? ["blink", "cc", "gpu", "v8", "loading", "fonts", "renderer", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink.user_timing", "disabled-by-default-blink.debug.layout", "disabled-by-default-v8.compile", "disabled-by-default-cc.debug", "disabled-by-default-blink.debug.display_lock", "disabled-by-default-devtools.timeline.layers", "disabled-by-default-devtools.timeline.picture"]
  : ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink.user_timing", "v8.execute"]

export type Result = {
  readonly variant: string
  readonly workspace: string
  readonly interaction: string
  readonly run: number
  readonly inputToReadyMs: number
  readonly clickToReadyMs: number
  readonly inputToClickMs: number
  readonly readyFrame: number
  readonly readyFrameFromClick: number
  readonly inputToReadyFrameEndMs: number
  readonly inputToSettledMs: number
  readonly inputToShellSettledMs: number | undefined
  readonly worstFrameMs: number
  readonly framesOver16_7: number
  readonly frameCount: number
  readonly worstFrameToQuietMs: number
  readonly worstFrameToQuietAtMs: number
  readonly framesOver16_7ToQuiet: number
  readonly loafs: Recording["loafs"]
  readonly requests: readonly { readonly url: string; readonly ms: number; readonly startMs: number }[]
  readonly load: string
  readonly trace: string
  readonly cpu: readonly string[]
}

const load = () => os.loadavg().map((value) => value.toFixed(2)).join(" ")
export class Runner {
  private cdp: CDPSession | undefined
  private results: Result[] = []
  private requests: { url: string; ms: number; startMs: number }[] = []
  private windowStart = 0
  private serial = 0
  variant = "app"
  constructor(private readonly page: Page, private mapper: ReturnType<typeof createSourceMapper>) {}

  useVariant(name: string, distDir: string) {
    this.variant = name
    this.mapper = createSourceMapper(distDir)
  }

  private listening = false

  async attach() {
    this.cdp ??= await this.page.context().newCDPSession(this.page)
    await this.page.evaluate(installRecorder)
    if (this.listening) return
    this.listening = true
    this.page.on("requestfinished", (request) => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith("/api/")) return
      const timing = request.timing()
      this.requests.push({ url: `${url.pathname}${url.search}`.slice(0, 160), ms: Math.round(timing.responseEnd), startMs: timing.startTime })
    })
  }

  async measure(workspace: string, interaction: string, run: number, predicate: Predicate, act: () => Promise<void>) {
    const cdp = this.cdp
    if (!cdp) throw new Error("attach first")
    const chunks: TraceEvent[] = []
    const collect = (event: { value: unknown[] }) => chunks.push(...(event.value as TraceEvent[]))
    cdp.on("Tracing.dataCollected", collect)
    await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: TRACE_CATEGORIES } })
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 })
    await cdp.send("Profiler.start")
    await this.page.evaluate((predicate) => window.__panelRec!.arm(predicate), predicate)
    const done = this.page.evaluate(() => window.__panelRec!.done())
    void done.catch(() => undefined)
    this.requests = []
    const before = await this.page.evaluate(() => performance.now())
    const pageEpoch = await this.page.evaluate(() => performance.timeOrigin)
    await act()
    const recording = await done
    const actAt = recording.actAt
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile }
    const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()))
    await cdp.send("Tracing.end")
    await complete
    cdp.off("Tracing.dataCollected", collect)
    this.serial += 1
    const traceFile = path.join(OUT, `${this.variant}-${workspace}-${interaction}-${run}.trace.json`)
    await fs.writeFile(traceFile, JSON.stringify({ traceEvents: chunks }))
    const summary = summarizeTrace(chunks, this.mapper)
    const cpu = summarizeProfile(profile, this.mapper)
    await fs.writeFile(traceFile.replace(".trace.json", ".cpuprofile"), JSON.stringify(profile))
    const frames = recording.frames
    const cutoff = recording.settledAt ?? recording.readyAt ?? Number.POSITIVE_INFINITY
    const deltas = frames.filter((at) => at <= cutoff + 1).map((at, index, all) => (index === 0 ? at - recording.inputAt : at - all[index - 1]!))
    const quietDeltas = frames.map((at, index, all) => (index === 0 ? at - recording.inputAt : at - all[index - 1]!))
    const worstQuiet = Math.max(0, ...quietDeltas)
    const worstQuietAt = quietDeltas.indexOf(worstQuiet) >= 0 ? (frames[quietDeltas.indexOf(worstQuiet)] ?? 0) - recording.inputAt : -1
    const requests = this.requests.map((request) => ({ ...request, startMs: Math.round(request.startMs - pageEpoch - recording.inputAt) })).filter((request) => request.startMs >= -5)
    void before
    const result: Result = {
      variant: this.variant, workspace, interaction, run,
      inputToReadyMs: recording.readyAt === undefined ? -1 : recording.readyAt - recording.inputAt,
      readyFrame: recording.readyFrame ?? -1,
      clickToReadyMs: recording.readyAt === undefined || recording.actAt === undefined ? -1 : recording.readyAt - recording.actAt,
      inputToClickMs: recording.actAt === undefined ? -1 : recording.actAt - recording.inputAt,
      readyFrameFromClick: recording.readyFrame === undefined || actAt === undefined ? -1 : recording.readyFrame - recording.frames.filter((at) => at < actAt).length,
      inputToReadyFrameEndMs: recording.readyFrameEnd === undefined ? -1 : recording.readyFrameEnd - recording.inputAt,
      inputToSettledMs: recording.settledAt === undefined ? -1 : recording.settledAt - recording.inputAt,
      inputToShellSettledMs: recording.shellSettledAt === undefined ? undefined : recording.shellSettledAt - recording.inputAt,
      worstFrameMs: Math.max(0, ...deltas), framesOver16_7: deltas.filter((delta) => delta > 16.7).length, frameCount: deltas.length,
      worstFrameToQuietMs: worstQuiet, worstFrameToQuietAtMs: worstQuietAt, framesOver16_7ToQuiet: quietDeltas.filter((delta) => delta > 16.7).length,
      loafs: recording.loafs.filter((loaf) => loaf.start + loaf.duration >= recording.inputAt - 1 && loaf.start <= cutoff),
      requests, load: load(), trace: traceFile, cpu,
    }
    this.results.push(result)
    const loafText = result.loafs.map((loaf) => `LoAF ${loaf.duration.toFixed(1)}ms(block ${loaf.blocking.toFixed(0)}) [${loaf.scripts.map((script) => `${script.fn || "(anon)"} ${script.duration.toFixed(1)}ms${script.forced ? ` forced ${script.forced.toFixed(1)}` : ""}`).join("; ")}]`).join("\n      ")
    console.log(`[${this.variant}/${workspace}] ${interaction} #${run}: ready ${result.inputToReadyMs.toFixed(1)}ms frame#${result.readyFrame} (click +${result.inputToClickMs.toFixed(1)} -> ready ${result.clickToReadyMs.toFixed(1)} frame#${result.readyFrameFromClick}) (frame end ${result.inputToReadyFrameEndMs.toFixed(1)}) settled ${result.inputToSettledMs.toFixed(1)} shell ${result.inputToShellSettledMs?.toFixed(1) ?? "-"} worst ${result.worstFrameMs.toFixed(1)}ms over16.7=${result.framesOver16_7}/${result.frameCount} quiet-worst ${result.worstFrameToQuietMs.toFixed(1)}ms@${result.worstFrameToQuietAtMs.toFixed(0)} over=${result.framesOver16_7ToQuiet} load ${result.load}`)
    if (process.env.PANEL_DEBUG === "1") console.log(`      frames: ${recording.signatures.slice(0, 6).join(" || ")}`)
    if (requests.length) console.log(`      requests: ${requests.map((request) => `${request.url} +${request.startMs}ms ${request.ms}ms`).join(" | ")}`)
    if (loafText) console.log(`      ${loafText}`)
    for (const task of summary.tasks) console.log(`      task +${task.startMs.toFixed(1)}ms ${task.durMs.toFixed(1)}ms\n        ${task.children.join("\n        ")}`)
    console.log(`      cpu: ${cpu.join(" | ")}`)
    return result
  }

  async flush() {
    await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify(this.results, null, 1))
  }

  get all() {
    return this.results
  }
}
