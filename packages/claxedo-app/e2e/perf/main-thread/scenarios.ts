import type { Browser, CDPSession, Page, Request } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { acpScriptToken } from "../../../../harness/e2e/harness/acp/script"
import type { ClaxedoApi } from "../../harness/api"
import { installPaintedFrames } from "../../harness/painted-frames"
import type { Stack } from "../../harness/stack"
import { sessionRoute } from "../../harness/ui-names"
import { STREAM_END, streamScript } from "../stream-script"
import { analyze, type Analysis } from "./analyze"
import type { Fixture, SessionTarget } from "./fixture"
import { dwell } from "../stream-switch/surface"
import { arm, quiet, startCapture, type Capture, type Census, type Target } from "./record"
import type { Mapper } from "./trace-names"

export type ScenarioRow = { variant: string; run: number; scenario: string; readyMs: number; railReadyMs?: number; census: Census; analysis: Analysis }

export type RunInput = {
  browser: Browser
  originUrl: string
  variant: string
  run: number
  short: SessionTarget
  fixture: Fixture
  api: ClaxedoApi
  stack: Stack
  throttle: number
  census: boolean
  mapper: Mapper
  traceDir?: string
  out: string
  onRow: (row: ScenarioRow) => void
}

const PROBE = path.join(import.meta.dirname, "probe.js")

function windowOf(capture: Capture) {
  const mark = capture.events.filter((event) => event.name === "mt:ready").at(-1)
  if (!mark) throw new Error("the trace has no ready mark")
  const toTrace = (at: number) => mark.ts - (capture.ready.markNow - at) * 1000
  const last = capture.events.reduce((latest, event) => (event.pid === mark.pid && event.tid === mark.tid ? Math.max(latest, event.ts + (event.dur ?? 0)) : latest), mark.ts)
  return { window: { start: toTrace(capture.ready.startAt), ready: toTrace(capture.ready.readyAt), end: last }, thread: { pid: mark.pid, tid: mark.tid } }
}

function railReady(capture: Capture) {
  const final = capture.probed.rail.at(-1)
  const first = capture.probed.rail.find((entry) => entry.count === final?.count)
  return first ? first.at - capture.ready.startAt : undefined
}

async function row(input: RunInput, scenario: string, capture: Capture): Promise<ScenarioRow> {
  const { window, thread } = windowOf(capture)
  if (input.traceDir) {
    const base = path.join(input.traceDir, `${input.variant}-${input.run}-${scenario}`)
    await fs.writeFile(`${base}.trace.json`, JSON.stringify({ traceEvents: capture.events }))
    await fs.writeFile(`${base}.cpuprofile`, JSON.stringify(capture.profile))
  }
  const result: ScenarioRow = {
    variant: input.variant,
    run: input.run,
    scenario,
    readyMs: capture.ready.readyAt - capture.ready.startAt,
    railReadyMs: scenario === "boot" ? railReady(capture) : undefined,
    census: capture.probed.counts,
    analysis: analyze(capture.events, capture.profile, window, input.mapper, thread),
  }
  input.onRow(result)
  return result
}

const sessionTarget = (session: SessionTarget, start: "navigation" | "pointerdown"): Target => ({ kind: "session", sessionId: session.id, replyIds: session.replyIds, start })

async function openPage(input: RunInput) {
  const context = await input.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-US", timezoneId: "UTC" })
  await context.addInitScript("globalThis.__name = (target) => target")
  await context.addInitScript(installPaintedFrames)
  await context.addInitScript(`window.__mainThreadCensus = ${input.census}; window.__mainThreadBoot = ${JSON.stringify(sessionTarget(input.short, "navigation"))}`)
  await context.addInitScript({ path: PROBE })
  const page = await context.newPage()
  page.on("pageerror", (error) => console.log(`[page error] ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[console error] ${message.text().slice(0, 300)}`)
  })
  page.on("requestfailed", (request) => console.log(`[request failed] ${request.url().slice(0, 160)} ${request.failure()?.errorText ?? ""}`))
  const pending = new Set<Request>()
  page.on("request", (request) => pending.add(request))
  page.on("requestfinished", (request) => pending.delete(request))
  page.on("requestfailed", (request) => pending.delete(request))
  await page.goto(new URL("/favicon-v3.svg", input.originUrl).toString())
  const cdp = await context.newCDPSession(page)
  if (input.throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: input.throttle })
  return { context, page, cdp, pending }
}

async function railRow(page: Page, session: SessionTarget) {
  const locator = page.locator(`[data-slot="session-navigation-row"][data-session-id="${session.id}"]`).first()
  for (let more = 0; more < 20 && (await locator.count()) === 0; more += 1) {
    await page.getByRole("button", { name: "Load more" }).first().click()
    await dwell(300)
  }
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error(`no rail row for ${session.id}`)
  const point = { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 }
  await page.mouse.move(point.x, point.y)
  await dwell(300)
  await quiet(page)
  return point
}

async function clickRow(input: RunInput, page: Page, cdp: CDPSession, session: SessionTarget, scenario: string) {
  const point = await railRow(page, session)
  const end = await startCapture(cdp)
  await arm(page, sessionTarget(session, "pointerdown"))
  await page.mouse.click(point.x, point.y)
  return row(input, scenario, await end(page))
}

async function show(page: Page, session: SessionTarget) {
  const shown = await page.locator(`section[data-component="session-screen"][data-session-id="${session.id}"]`).isVisible()
  if (shown) return
  const point = await railRow(page, session)
  await page.mouse.click(point.x, point.y)
  await page.locator(`section[data-component="session-screen"][data-session-id="${session.id}"]`).waitFor({ state: "visible" })
  await quiet(page)
}

async function stream(input: RunInput, page: Page, cdp: CDPSession) {
  const { api, stack, fixture, short } = input
  await show(page, short)
  const script = `stream-${input.variant}-${input.run}`
  await stack.acp.write(script, streamScript(fixture.workspace.directory))
  const end = await startCapture(cdp)
  await arm(page, { kind: "text", sessionId: short.id, text: STREAM_END, start: "now" })
  await api.promptAsync(fixture.workspace.directory, short.id, `Write the long report. ${acpScriptToken(script)}`)
  return row(input, "stream", await end(page))
}

export async function runOnce(input: RunInput, scenarios: readonly string[]): Promise<ScenarioRow[]> {
  const { context, page, cdp, pending } = await openPage(input)
  const rows: ScenarioRow[] = []
  const long = (key: string) => {
    const session = input.fixture.long[key]
    if (!session) throw new Error(`no ${key} session`)
    return session
  }
  try {
    const end = await startCapture(cdp)
    await page.goto(new URL(sessionRoute(input.fixture.workspace.id, input.short.id), input.originUrl).toString())
    rows.push(await row(input, "boot", await end(page)))
    for (const scenario of scenarios) {
      const [kind, key] = scenario.split(":") as [string, string | undefined]
      if (kind === "open" || kind === "return") rows.push(await clickRow(input, page, cdp, key === "short" ? input.short : long(key ?? ""), scenario))
      if (kind === "stream") rows.push(await stream(input, page, cdp))
    }
    return rows
  } catch (error) {
    await page.screenshot({ path: path.join(input.out, `failed-${input.variant}-${input.run}.png`) })
    console.log(`[unanswered] ${[...pending].map((request) => `${request.method()} ${new URL(request.url()).pathname}`).join(" | ")}`)
    throw error
  } finally {
    await context.close()
  }
}
