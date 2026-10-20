import type { Browser, BrowserContext, CDPSession, Page } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installPaintedFrames } from "../../harness/painted-frames"
import { createSourceMapper, summarizeProfile } from "../panel/trace"
import { startCoverage, type FileUse } from "./coverage"
import { profileSelfByUrl, summarizeMainThread, type MainThreadSummary } from "./main-thread"
import { installWebProbe, type ProbeCensus, type ProbeState } from "./probe"
import type { StreamReply } from "./options"
import type { Profile } from "./profiles"
import { startRecorder, type Recorder, type Recording } from "./recorder"
import type { Cookie, Target } from "./target"
import { buildWaterfall, describeProtocols, type Waterfall, type WaterfallRow } from "./waterfall"
import { round } from "./numbers"

export type Cache = "cold" | "warm"

export type StepResult = {
  readonly scenario: string
  readonly step: string
  readonly profile: Profile["name"]
  readonly cache: Cache
  readonly rep: number
  readonly reference: Reference
  readonly primary: { readonly name: string; readonly ms: number }
  readonly marks: Readonly<Record<string, number>>
  readonly lcp: ProbeState["lcp"]
  readonly layoutShift: number | undefined
  readonly railRows: number
  readonly keys: { readonly p50: number; readonly p95: number; readonly max: number; readonly n: number } | undefined
  readonly waterfall: Waterfall
  readonly lazyChunks: readonly WaterfallRow[]
  readonly mainThread: MainThreadSummary | undefined
  readonly cpu: { readonly byChunk: readonly { readonly url: string; readonly ms: number }[]; readonly top: readonly string[] } | undefined
  readonly probeLongTasks: { readonly count: number; readonly tbtMs: number }
  readonly census: ProbeCensus | undefined
  readonly coverage: readonly FileUse[] | undefined
  readonly hostLoad: string
  readonly traceFile: string | undefined
}

export type Reference = "navigation" | "input" | "prompt"

export type RunInput = {
  readonly browser: Browser
  readonly target: Target
  readonly profile: Profile
  readonly cpu: number
  readonly rep: number
  readonly out: string
  readonly label: string
  readonly stacks: boolean
  readonly census: boolean
  readonly streamReply: StreamReply | undefined
  readonly coverage: boolean
  readonly onboardingOnly: boolean
  readonly log: (line: string) => void
}

export type Session = { context: BrowserContext; page: Page; cdp: CDPSession; recorder: Recorder; timeOriginTs: number | undefined }

export const MARK_TIMEOUT_MS = 90_000
const SETTLE_TIMEOUT_MS = 5_000
const QUIET_FRAMES = 30

export function hostLoad() {
  return `load ${os.loadavg().map((value) => value.toFixed(2)).join(" ")}, ${(os.freemem() / 2 ** 30).toFixed(1)} GiB free of ${(os.totalmem() / 2 ** 30).toFixed(0)}`
}

function quantile(values: readonly number[], q: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

export async function openSession(input: RunInput, cookies: readonly Cookie[] | undefined): Promise<Session> {
  const context = await input.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-US", timezoneId: "UTC", ignoreHTTPSErrors: true })
  if (cookies) await context.addCookies(cookies)
  await context.addInitScript("globalThis.__name = (target) => target")
  await context.addInitScript(installPaintedFrames)
  if (input.census) await context.addInitScript("window.__webPerfCensus = true")
  await context.addInitScript(installWebProbe)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const recorder = await startRecorder(cdp, { stacks: input.stacks })
  if (input.profile.name !== "none") {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: input.profile.latencyMs, downloadThroughput: input.profile.downloadBytesPerSecond, uploadThroughput: input.profile.uploadBytesPerSecond })
  }
  if (input.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: input.cpu })
  return { context, page, cdp, recorder, timeOriginTs: undefined }
}

export function readProbe(page: Page) {
  return page.evaluate(() => {
    if (!window.__webPerf) throw new Error("the web perf probe is not installed in this page")
    return window.__webPerf.read()
  })
}

async function paintedFrames(page: Page, count: number) {
  const seen = await page.evaluate(() => window.__webPerf?.read().frames ?? 0)
  await page.waitForFunction((target) => (window.__webPerf?.read().frames ?? 0) >= target, seen + count, { timeout: MARK_TIMEOUT_MS, polling: 50 })
}

export async function waitForMark(page: Page, name: string, timeoutMs: number) {
  try {
    await page.waitForFunction((mark) => window.__webPerf?.read().marks.some((entry) => entry.name === mark) ?? false, name, { timeout: timeoutMs, polling: 50 })
    return true
  } catch (error) {
    if (timeoutMs < MARK_TIMEOUT_MS) return false
    const state = await readProbe(page).catch(() => undefined)
    throw new Error(`${name} never painted within ${timeoutMs} ms at ${page.url()}; marks so far: ${JSON.stringify(state?.marks ?? [])}`, { cause: error })
  }
}

export type Measure = {
  readonly scenario: string
  readonly step: string
  readonly cache: Cache
  readonly reference: Reference
  readonly required: readonly string[]
  readonly settle: string | undefined
  readonly before?: () => Promise<void>
  readonly act: () => Promise<void>
}

export async function measure(input: RunInput, session: Session, spec: Measure): Promise<StepResult> {
  const { page, recorder } = session
  const distDir = input.target.distDir
  const coverage = input.coverage && spec.reference === "navigation" && distDir ? await startCoverage(session.cdp, distDir) : undefined
  await recorder.begin({ trace: true, profile: true })
  let recording: Recording | undefined
  try {
    await spec.before?.()
    if (spec.reference === "input") await page.evaluate(() => window.__webPerf?.arm())
    await spec.act()
    for (const name of spec.required) await waitForMark(page, name, MARK_TIMEOUT_MS)
    if (spec.settle) await waitForMark(page, spec.settle, SETTLE_TIMEOUT_MS)
    await paintedFrames(page, QUIET_FRAMES)
  } finally {
    recording = await recorder.end()
  }
  const state = await readProbe(page)
  const used = await coverage?.take(page)
  return { ...(await summarizeStep(input, session, spec, recording, state)), coverage: used }
}

export type Span = { readonly referenceMs: number; readonly endMs: number }

export async function summarizeStep(input: RunInput, session: Session, spec: Measure, recording: Recording, state: ProbeState, span?: Span): Promise<StepResult> {
  const document = [...recording.requests].reverse().find((record) => record.type === "Document")
  if (spec.reference === "navigation") {
    if (!document || !state.navigation) throw new Error(`${spec.scenario}/${spec.step} recorded no document request`)
    session.timeOriginTs = document.startTs - state.navigation.fetchStart / 1000
  }
  if (session.timeOriginTs === undefined) throw new Error(`${spec.scenario}/${spec.step} has no navigation to count from`)
  const input0 = spec.reference === "input" ? state.inputs.at(-1) : undefined
  if (spec.reference === "input" && !input0) throw new Error(`${spec.scenario}/${spec.step} saw no trusted input`)
  const referenceMs = span?.referenceMs ?? input0?.at ?? 0
  const referenceTs = session.timeOriginTs + referenceMs / 1000
  const marks = Object.fromEntries(state.marks.filter((mark) => mark.at >= referenceMs - 1).map((mark) => [mark.name, round(mark.at - referenceMs)]))
  const required = spec.required.map((name) => marks[name] ?? 0)
  const lastKeyMs = Math.max(0, ...state.keys.filter((key) => key.at >= referenceMs).map((key) => key.at + key.latencyMs - referenceMs))
  const endMs = span?.endMs ?? Math.max(...required, lastKeyMs, spec.settle && marks[spec.settle] !== undefined ? marks[spec.settle] : 0)
  const requests = recording.requests.filter((record) => record.startTs >= referenceTs - 0.005)
  const waterfall = buildWaterfall(requests, referenceTs)
  const initial = input.target.bytes?.initial
  const lazyChunks = waterfall.rows.filter((row) => (row.kind === "script" || row.kind === "stylesheet") && row.url.includes("/assets/") && !(initial?.has(new URL(row.url).pathname) ?? false))
  const mapper = input.target.distDir ? createSourceMapper(input.target.distDir) : undefined
  const windowUs = { fromUs: referenceTs * 1_000_000, toUs: (referenceTs + endMs / 1000) * 1_000_000 }
  const mainThread = recording.traceEvents.length > 0 ? summarizeMainThread(recording.traceEvents, windowUs, mapper, recording.profile) : undefined
  const cpu = recording.profile ? { byChunk: profileSelfByUrl(recording.profile).slice(0, 12), top: mapper ? summarizeProfile(recording.profile, mapper) : [] } : undefined
  const longTasks = state.longTasks.filter((task) => task.start >= referenceMs && task.start <= referenceMs + endMs)
  const keys = state.keys.filter((key) => key.at >= referenceMs).map((key) => key.latencyMs)
  const traceFile = recording.traceEvents.length > 0 ? path.join(input.out, `${input.label}-${input.profile.name}-${spec.scenario}-${spec.step}-rep${input.rep}.trace.json`) : undefined
  if (traceFile) await fs.writeFile(traceFile, JSON.stringify({ traceEvents: recording.traceEvents }))
  if (traceFile && recording.profile) await fs.writeFile(traceFile.replace(/\.trace\.json$/, ".cpuprofile"), JSON.stringify(recording.profile))
  const first = spec.required[0]
  const result: StepResult = {
    scenario: spec.scenario, step: spec.step, profile: input.profile.name, cache: spec.cache, rep: input.rep, reference: spec.reference,
    primary: first ? { name: first, ms: marks[first] ?? Number.NaN } : span ? { name: "end", ms: round(span.endMs) } : { name: "key p50", ms: round(quantile(keys, 0.5)) },
    marks, lcp: spec.reference === "navigation" ? state.lcp : undefined, layoutShift: spec.reference === "navigation" ? state.layoutShift : undefined, railRows: state.railRows,
    keys: keys.length > 0 ? { p50: round(quantile(keys, 0.5)), p95: round(quantile(keys, 0.95)), max: round(Math.max(...keys)), n: keys.length } : undefined,
    waterfall, lazyChunks, mainThread, cpu,
    probeLongTasks: { count: longTasks.length, tbtMs: round(longTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0)) },
    census: state.census, coverage: undefined, hostLoad: hostLoad(), traceFile,
  }
  input.log(`${input.profile.name} ${spec.scenario}/${spec.step} rep ${input.rep}: ${result.primary.name} ${result.primary.ms} ms; ${waterfall.requests} requests (${describeProtocols(waterfall.protocols)}), ${(waterfall.transferBytes / 1000).toFixed(0)} kB, ${waterfall.waves} waves; TBT ${mainThread?.tbtMs ?? "—"} ms; ${result.hostLoad}`)
  return result
}

const HOVER_FRAMES = 10
const LOAD_MORE_PAGES = 20

async function railRowPoint(page: Page, sessionId: string) {
  const row = page.locator(`[data-slot="session-navigation-row"][data-session-id="${sessionId}"] [data-slot="navigation-row-activate"]`)
  for (let pages = 0; pages < LOAD_MORE_PAGES && (await row.count()) === 0; pages += 1) await page.getByRole("button", { name: "Load more" }).first().click()
  await row.scrollIntoViewIfNeeded()
  const box = await row.boundingBox()
  if (!box) throw new Error(`the rail lists no row for ${sessionId}`)
  return { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 }
}

export function railPress(page: Page, sessionId: string): Pick<Measure, "before" | "act"> {
  let point: { x: number; y: number } | undefined
  return {
    before: async () => {
      point = await railRowPoint(page, sessionId)
      await page.mouse.move(point.x, point.y)
      await paintedFrames(page, HOVER_FRAMES)
    },
    act: async () => {
      if (!point) throw new Error(`the rail row for ${sessionId} was never found`)
      await page.mouse.click(point.x, point.y)
    },
  }
}

export async function pressByRole(page: Page, locate: () => ReturnType<Page["locator"]>) {
  const element = locate()
  await element.waitFor({ state: "visible", timeout: 30_000 })
  const box = await element.boundingBox()
  if (!box) throw new Error("the element to press has no box")
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}


export const sessionMarks = (id: string) => ({ required: [`session-text:${id}`], settle: `session-settled:${id}` })
