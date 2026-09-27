import { chromium, type CDPSession, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { SCRIPTED_ACP_HARNESS } from "../../harness/acp/connection"
import { acpScriptToken } from "../../harness/acp/script"
import { ClaxedoApi } from "../../harness/api"
import { git } from "../../harness/git"
import { prepareHarness } from "../../harness/global-setup"
import { startStack, type Stack } from "../../harness/stack"
import { sessionRoute } from "../../harness/ui-names"
import type { Workspace } from "../../harness/workspaces"
import { longReplyScript, seedTurnScript, streamScript } from "../stream-script"

const SEED_TURNS = Number(process.env.SEED_TURNS ?? "8")
const SWITCHES = Number(process.env.SWITCHES ?? "30")
const SCENARIO = process.env.SCENARIO ?? "one"
const THROTTLE = Number(process.env.THROTTLE ?? "1")
const SCALE = Number(process.env.SCALE ?? "1")
const COLD = Number(process.env.COLD ?? "4")
const ROUNDS = Number(process.env.ROUNDS ?? "3")
const PROFILE = process.env.PROFILE === "1"
const OUT = process.env.OUT ?? path.join(process.env.HOME ?? "", "test/claxedo-perf-private/perf/stream-switch/run")

type ScreencastFrame = { wall: number; data: Buffer }

async function makeWorkspace(stack: Stack) {
  const workspace = await stack.daemon.makeWorkspace("switch", "Switch")
  await fs.mkdir(path.join(workspace.directory, "src"), { recursive: true })
  await fs.writeFile(path.join(workspace.directory, "src/values.ts"), "export const value0 = 0\n")
  await git(workspace.directory, "add", "--", "src/values.ts")
  await git(workspace.directory, "commit", "-q", "-m", "values", "--", "src/values.ts")
  return workspace
}

async function seedSession(api: ClaxedoApi, stack: Stack, workspace: Workspace, title: string) {
  const session = await api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  for (let turn = 1; turn <= SEED_TURNS; turn += 1) {
    const script = `${title}-seed-${turn}`
    await stack.acp.write(script, seedTurnScript(workspace.directory, turn))
    await api.prompt(workspace.directory, session.id, `Earlier question ${turn}. ${acpScriptToken(script)}`)
  }
  return session.id
}

async function startStream(api: ClaxedoApi, stack: Stack, workspace: Workspace, sessionId: string, name: string) {
  await stack.acp.write(name, process.env.STREAM === "report" ? streamScript(workspace.directory) : longReplyScript(workspace.directory))
  await api.promptAsync(workspace.directory, sessionId, `Write the long report. ${acpScriptToken(name)}`)
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
  await prepareHarness()
  const stack = await startStack({ label: "stream-switch" })
  const browser = await chromium.launch({ channel: "chromium" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await makeWorkspace(stack)
    const steps = plan(SCENARIO, COLD)
    const ids: Record<string, string> = {}
    for (const title of steps.seeded) ids[title] = await seedSession(api, stack, workspace, title)
    console.log(`[switch] seeded ${steps.seeded.length} sessions, ${SEED_TURNS} turns each`)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE, colorScheme: "light", locale: "en-US", timezoneId: "UTC" })
    await context.addInitScript({ path: path.join(import.meta.dirname, "probe.js") })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const seeded = page.getByText(`Seed turn ${SEED_TURNS} done.`).first()
    if (steps.seeded.includes("Beta")) {
      await page.goto(`${stack.url}${sessionRoute(workspace.id, ids.Beta)}`)
      await seeded.waitFor({ state: "visible", timeout: 60_000 })
      await page.mouse.click(...Object.values(await railRow(page, ids.Alpha!)) as [number, number])
    } else {
      await page.goto(`${stack.url}${sessionRoute(workspace.id, ids.Alpha)}`)
    }
    await seeded.waitFor({ state: "visible", timeout: 60_000 })
    if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })
    const screencast: ScreencastFrame[] = []
    await startScreencast(cdp, screencast)
    await page.evaluate(() => (window as unknown as { __switchProbe: { start(): void } }).__switchProbe.start())
    for (const title of steps.streaming) await startStream(api, stack, workspace, ids[title]!, `stream-${title.replace(/ /g, "-")}`)
    await page.waitForTimeout(1500)
    if (PROFILE) {
      await cdp.send("Profiler.enable")
      await cdp.send("Profiler.setSamplingInterval", { interval: 250 })
      await cdp.send("Profiler.start")
    }
    const clicks: { title: string; wall: number }[] = []
    const rounds: unknown[] = []
    for (let round = 0; round < (SCENARIO === "cold" ? ROUNDS : 1); round += 1) {
      if (round > 0) {
        rounds.push(await page.evaluate(() => (window as unknown as { __switchProbe: { stop(): unknown } }).__switchProbe.stop()))
        await page.reload()
        await page.locator('[data-testid="session-page-root"] [data-timeline-key]').first().waitFor({ state: "visible", timeout: 60_000 })
        await page.waitForTimeout(800)
        await page.evaluate(() => (window as unknown as { __switchProbe: { start(): void } }).__switchProbe.start())
      }
      for (const [index, title] of steps.clicks.entries()) {
        const row = await railRow(page, ids[title]!)
        clicks.push({ title, wall: Date.now() })
        await page.mouse.click(row.x, row.y)
        await page.waitForTimeout(jitter(index))
      }
    }
    await page.waitForTimeout(500)
    if (PROFILE) {
      const { profile } = (await cdp.send("Profiler.stop")) as { profile: unknown }
      await fs.writeFile(path.join(OUT, "switch.cpuprofile"), JSON.stringify(profile))
    }
    rounds.push(await page.evaluate(() => (window as unknown as { __switchProbe: { stop(): unknown } }).__switchProbe.stop()))
    await cdp.send("Page.stopScreencast")
    const framesDir = path.join(OUT, "frames")
    await fs.mkdir(framesDir, { recursive: true })
    const index = screencast.map((frame, n) => ({ n, wall: frame.wall, file: `f${String(n).padStart(5, "0")}.jpg` }))
    await Promise.all(screencast.map((frame, n) => fs.writeFile(path.join(framesDir, index[n]!.file), frame.data)))
    await fs.writeFile(path.join(OUT, "recording.json"), JSON.stringify({ alpha: ids.Alpha, beta: ids.Beta, ids, scenario: SCENARIO, clicks, screencast: index, rounds }))
    console.log(`[switch] ${clicks.length} switches, ${screencast.length} screencast frames, out ${OUT}`)
    await context.close()
  } finally {
    await browser.close()
    await stack.close()
  }
}

await main()
