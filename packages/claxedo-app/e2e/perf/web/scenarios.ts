import type { Browser, BrowserContext, CDPSession, Page } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installPaintedFrames } from "../../harness/painted-frames"
import { createSourceMapper, summarizeProfile } from "../panel/trace"
import { profileSelfByUrl, summarizeMainThread, type MainThreadSummary } from "./main-thread"
import { installWebProbe, type ProbeState } from "./probe"
import type { Profile } from "./profiles"
import { startRecorder, type Recorder, type Recording } from "./recorder"
import type { Target } from "./target"
import { buildWaterfall, type Waterfall, type WaterfallRow } from "./waterfall"
import { round } from "./numbers"

export type Cache = "cold" | "warm"

export type StepResult = {
  readonly scenario: string
  readonly step: string
  readonly profile: Profile["name"]
  readonly cache: Cache
  readonly rep: number
  readonly reference: "navigation" | "input"
  readonly primary: { readonly name: string; readonly ms: number }
  readonly marks: Readonly<Record<string, number>>
  readonly lcp: ProbeState["lcp"]
  readonly railRows: number
  readonly keys: { readonly p50: number; readonly p95: number; readonly max: number; readonly n: number } | undefined
  readonly waterfall: Waterfall
  readonly lazyChunks: readonly WaterfallRow[]
  readonly mainThread: MainThreadSummary | undefined
  readonly cpu: { readonly byChunk: readonly { readonly url: string; readonly ms: number }[]; readonly top: readonly string[] } | undefined
  readonly probeLongTasks: { readonly count: number; readonly tbtMs: number }
  readonly hostLoad: string
  readonly traceFile: string | undefined
}

export type RunInput = {
  readonly browser: Browser
  readonly target: Target
  readonly profile: Profile
  readonly cpu: number
  readonly rep: number
  readonly out: string
  readonly label: string
  readonly log: (line: string) => void
}

type Session = { context: BrowserContext; page: Page; cdp: CDPSession; recorder: Recorder; timeOriginTs: number | undefined }

const MARK_TIMEOUT_MS = 90_000
const SETTLE_TIMEOUT_MS = 5_000
const QUIET_FRAMES = 30
const TYPED = "Measuring how the composer keeps up"
const SWITCHES = 4

export function hostLoad() {
  return `load ${os.loadavg().map((value) => value.toFixed(2)).join(" ")}, ${(os.freemem() / 2 ** 30).toFixed(1)} GiB free of ${(os.totalmem() / 2 ** 30).toFixed(0)}`
}

function quantile(values: readonly number[], q: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

async function openSession(input: RunInput, signedIn: boolean): Promise<Session> {
  const context = await input.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-US", timezoneId: "UTC", ignoreHTTPSErrors: true })
  if (signedIn) await context.addCookies(input.target.cookies)
  await context.addInitScript("globalThis.__name = (target) => target")
  await context.addInitScript(installPaintedFrames)
  await context.addInitScript(installWebProbe)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const recorder = await startRecorder(cdp)
  if (input.profile.name !== "none") {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: input.profile.latencyMs, downloadThroughput: input.profile.downloadBytesPerSecond, uploadThroughput: input.profile.uploadBytesPerSecond })
  }
  if (input.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: input.cpu })
  return { context, page, cdp, recorder, timeOriginTs: undefined }
}

function readProbe(page: Page) {
  return page.evaluate(() => {
    if (!window.__webPerf) throw new Error("the web perf probe is not installed in this page")
    return window.__webPerf.read()
  })
}

async function paintedFrames(page: Page, count: number) {
  const seen = await page.evaluate(() => window.__webPerf?.read().frames ?? 0)
  await page.waitForFunction((target) => (window.__webPerf?.read().frames ?? 0) >= target, seen + count, { timeout: MARK_TIMEOUT_MS, polling: 50 })
}

async function waitForMark(page: Page, name: string, timeoutMs: number) {
  try {
    await page.waitForFunction((mark) => window.__webPerf?.read().marks.some((entry) => entry.name === mark) ?? false, name, { timeout: timeoutMs, polling: 50 })
    return true
  } catch (error) {
    if (timeoutMs < MARK_TIMEOUT_MS) return false
    const state = await readProbe(page).catch(() => undefined)
    throw new Error(`${name} never painted within ${timeoutMs} ms at ${page.url()}; marks so far: ${JSON.stringify(state?.marks ?? [])}`, { cause: error })
  }
}

type Measure = {
  readonly scenario: string
  readonly step: string
  readonly cache: Cache
  readonly reference: "navigation" | "input"
  readonly required: readonly string[]
  readonly settle: string | undefined
  readonly act: () => Promise<void>
}

async function measure(input: RunInput, session: Session, spec: Measure): Promise<StepResult> {
  const { page, recorder } = session
  await recorder.begin({ trace: true, profile: true })
  let recording: Recording | undefined
  try {
    if (spec.reference === "input") await page.evaluate(() => window.__webPerf?.arm())
    await spec.act()
    for (const name of spec.required) await waitForMark(page, name, MARK_TIMEOUT_MS)
    if (spec.settle) await waitForMark(page, spec.settle, SETTLE_TIMEOUT_MS)
    await paintedFrames(page, QUIET_FRAMES)
  } finally {
    recording = await recorder.end()
  }
  const state = await readProbe(page)
  return summarizeStep(input, session, spec, recording, state)
}

async function summarizeStep(input: RunInput, session: Session, spec: Measure, recording: Recording, state: ProbeState): Promise<StepResult> {
  const document = [...recording.requests].reverse().find((record) => record.type === "Document")
  if (spec.reference === "navigation") {
    if (!document || !state.navigation) throw new Error(`${spec.scenario}/${spec.step} recorded no document request`)
    session.timeOriginTs = document.startTs - state.navigation.fetchStart / 1000
  }
  if (session.timeOriginTs === undefined) throw new Error(`${spec.scenario}/${spec.step} has no navigation to count from`)
  const input0 = spec.reference === "input" ? state.inputs.at(-1) : undefined
  if (spec.reference === "input" && !input0) throw new Error(`${spec.scenario}/${spec.step} saw no trusted input`)
  const referenceMs = input0?.at ?? 0
  const referenceTs = session.timeOriginTs + referenceMs / 1000
  const marks = Object.fromEntries(state.marks.filter((mark) => mark.at >= referenceMs - 1).map((mark) => [mark.name, round(mark.at - referenceMs)]))
  const required = spec.required.map((name) => marks[name] ?? 0)
  const lastKeyMs = Math.max(0, ...state.keys.filter((key) => key.at >= referenceMs).map((key) => key.at + key.latencyMs - referenceMs))
  const endMs = Math.max(...required, lastKeyMs, spec.settle && marks[spec.settle] !== undefined ? marks[spec.settle] : 0)
  const requests = recording.requests.filter((record) => record.startTs >= referenceTs - 0.005)
  const waterfall = buildWaterfall(requests, referenceTs)
  const initial = input.target.bytes?.initial
  const lazyChunks = waterfall.rows.filter((row) => (row.kind === "script" || row.kind === "stylesheet") && row.url.includes("/assets/") && !(initial?.has(new URL(row.url).pathname) ?? false))
  const mapper = input.target.distDir ? createSourceMapper(input.target.distDir) : undefined
  const windowUs = { fromUs: referenceTs * 1_000_000, toUs: (referenceTs + endMs / 1000) * 1_000_000 }
  const mainThread = recording.traceEvents.length > 0 ? summarizeMainThread(recording.traceEvents, windowUs, mapper) : undefined
  const cpu = recording.profile ? { byChunk: profileSelfByUrl(recording.profile).slice(0, 12), top: mapper ? summarizeProfile(recording.profile, mapper) : [] } : undefined
  const longTasks = state.longTasks.filter((task) => task.start >= referenceMs && task.start <= referenceMs + endMs)
  const keys = state.keys.filter((key) => key.at >= referenceMs).map((key) => key.latencyMs)
  const traceFile = recording.traceEvents.length > 0 ? path.join(input.out, `${input.label}-${input.profile.name}-${spec.scenario}-${spec.step}-rep${input.rep}.trace.json`) : undefined
  if (traceFile) await fs.writeFile(traceFile, JSON.stringify({ traceEvents: recording.traceEvents }))
  const first = spec.required[0]
  const result: StepResult = {
    scenario: spec.scenario, step: spec.step, profile: input.profile.name, cache: spec.cache, rep: input.rep, reference: spec.reference,
    primary: first ? { name: first, ms: marks[first] ?? Number.NaN } : { name: "key p50", ms: round(quantile(keys, 0.5)) },
    marks, lcp: spec.reference === "navigation" ? state.lcp : undefined, railRows: state.railRows,
    keys: keys.length > 0 ? { p50: round(quantile(keys, 0.5)), p95: round(quantile(keys, 0.95)), max: round(Math.max(...keys)), n: keys.length } : undefined,
    waterfall, lazyChunks, mainThread, cpu,
    probeLongTasks: { count: longTasks.length, tbtMs: round(longTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0)) },
    hostLoad: hostLoad(), traceFile,
  }
  input.log(`${input.profile.name} ${spec.scenario}/${spec.step} rep ${input.rep}: ${result.primary.name} ${result.primary.ms} ms; ${waterfall.requests} requests, ${(waterfall.transferBytes / 1000).toFixed(0)} kB, ${waterfall.waves} waves; TBT ${mainThread?.tbtMs ?? "—"} ms; ${result.hostLoad}`)
  return result
}

async function pressRailRow(page: Page, sessionId: string) {
  const row = page.locator(`[data-slot="session-navigation-row"][data-session-id="${sessionId}"] [data-slot="navigation-row-activate"]`)
  await row.scrollIntoViewIfNeeded()
  const box = await row.boundingBox()
  if (!box) throw new Error(`the rail lists no row for ${sessionId}`)
  await page.mouse.click(box.x + Math.min(box.width / 2, 120), box.y + box.height / 2)
}

async function pressByRole(page: Page, locate: () => ReturnType<Page["locator"]>) {
  const element = locate()
  await element.waitFor({ state: "visible", timeout: 30_000 })
  const box = await element.boundingBox()
  if (!box) throw new Error("the element to press has no box")
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

const sessionMarks = (id: string) => ({ required: [`session-text:${id}`], settle: `session-settled:${id}` })

export type ScenarioRun = { readonly results: readonly StepResult[]; readonly failures: readonly string[] }

export async function runScenarios(input: RunInput): Promise<ScenarioRun> {
  const { target } = input
  const [first, second] = target.sessions
  if (!first || !second) throw new Error("the target names fewer than two sessions")
  const results: StepResult[] = []
  const failures: string[] = []
  const attempt = async (name: string, page: Page | undefined, run: () => Promise<StepResult>) => {
    try {
      results.push(await run())
    } catch (error) {
      const shot = page ? path.join(input.out, `${input.label}-${input.profile.name}-${name.replace(/\//g, "-")}-rep${input.rep}-failed.png`) : undefined
      if (shot) await page?.screenshot({ path: shot }).catch(() => undefined)
      const message = `${input.profile.name} ${name} rep ${input.rep} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}${shot ? ` (${shot})` : ""}`
      failures.push(message)
      input.log(message)
    }
  }
  const coldStep = async (scenario: string, url: string, signedIn: boolean, until: { required: readonly string[]; settle?: string }) => {
    const session = await openSession(input, signedIn)
    try {
      await attempt(`${scenario}/boot`, session.page, () => measure(input, session, { scenario, step: "boot", cache: "cold", reference: "navigation", required: until.required, settle: until.settle, act: () => session.page.goto(url, { waitUntil: "commit" }).then(() => undefined) }))
      return session
    } catch (error) {
      await session.context.close()
      throw error
    }
  }
  const root = await coldStep("cold-root", `${target.url}/`, true, { required: ["rail"] })
  await root.context.close()

  const chain = await coldStep("cold-session", first.url, true, sessionMarks(first.id))
  const { page } = chain
  try {
    await attempt("warm-session/reload", page, () => measure(input, chain, { scenario: "warm-session", step: "reload", cache: "warm", reference: "navigation", ...sessionMarks(first.id), act: () => page.goto(first.url, { waitUntil: "commit" }).then(() => undefined) }))
    await attempt("open-session/press", page, () => measure(input, chain, { scenario: "open-session", step: "press", cache: "warm", reference: "input", ...sessionMarks(second.id), act: () => pressRailRow(page, second.id) }))
    await attempt("open-session/type", page, async () => {
      await pressByRole(page, () => page.locator('[data-component="prompt-input"][contenteditable="true"]').first())
      return measure(input, chain, { scenario: "open-session", step: "type", cache: "warm", reference: "input", required: [], settle: undefined, act: async () => {
        await page.keyboard.type(TYPED, { delay: 80 })
        await page.waitForFunction((count) => (window.__webPerf?.read().keys.length ?? 0) >= count, TYPED.length, { timeout: MARK_TIMEOUT_MS, polling: 50 })
      } })
    })
    for (let index = 0; index < SWITCHES; index += 1) {
      const destination = index % 2 === 0 ? first : second
      await attempt(`switch-sessions/return-${index + 1}`, page, () => measure(input, chain, { scenario: "switch-sessions", step: `return-${index + 1}`, cache: "warm", reference: "input", ...sessionMarks(destination.id), act: () => pressRailRow(page, destination.id) }))
    }
    await attempt("lazy-pages/marketplace", page, () => measure(input, chain, { scenario: "lazy-pages", step: "marketplace", cache: "warm", reference: "input", required: ["marketplace"], settle: undefined, act: () => pressByRole(page, () => page.getByRole("button", { name: /Marketplace/ }).first()) }))
    await attempt("lazy-pages/settings", page, async () => {
      await pressByRole(page, () => page.getByTestId("rail-account-trigger"))
      return measure(input, chain, { scenario: "lazy-pages", step: "settings", cache: "warm", reference: "input", required: ["settings"], settle: undefined, act: () => pressByRole(page, () => page.getByRole("menuitem", { name: "Settings", exact: true })) })
    })
  } finally {
    await chain.context.close()
  }

  const signedOut = await coldStep("signed-out-login", `${target.url}/`, false, { required: ["login"] })
  await signedOut.context.close()
  return { results, failures }
}
