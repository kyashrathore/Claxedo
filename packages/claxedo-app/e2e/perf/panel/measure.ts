import { chromium, type CDPSession, type Locator, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SCRIPTED_ACP_HARNESS } from "../../harness/acp/connection"
import { acpScriptToken } from "../../harness/acp/script"
import { ClaxedoApi } from "../../harness/api"
import { appDistDir } from "../../harness/app"
import { git } from "../../harness/git"
import { prepareHarness } from "../../harness/global-setup"
import { startStack, type Stack } from "../../harness/stack"
import { sessionRoute } from "../../harness/ui-names"
import { installRecorder, type Predicate, type Recording } from "./recorder"
import { createSourceMapper, summarizeProfile, summarizeTrace, type CpuProfile, type TraceEvent } from "./trace"

const OUT = process.env.PANEL_OUT ?? path.join(os.tmpdir(), "panel-perf")
const RUNS = Number(process.env.PANEL_RUNS ?? "5")
const LARGE_SOURCE = process.env.PANEL_LARGE_REPO ?? "/Users/yashvardhansingh/test/opencode"
const BENCHMARK = process.env.PANEL_BENCHMARK ?? "/Users/yashvardhansingh/test/agent-app-benchmark"
const TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink.user_timing", "v8.execute"]

type Workspace = { readonly id: string; readonly directory: string; readonly name: string; readonly sessions: readonly string[]; readonly files: readonly string[]; readonly changed: readonly string[] }

type Result = {
  readonly workspace: string
  readonly interaction: string
  readonly run: number
  readonly inputToReadyMs: number
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

async function registerWorkspace(stack: Stack, directory: string, name: string) {
  const resolved = await fetch(`${stack.url}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  if (!resolved.ok) throw new Error(`resolve ${directory}: ${resolved.status} ${await resolved.text()}`)
  const project = await fetch(`${stack.url}/api/claxedo/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, source: { kind: "directory", directory } }) })
  if (!project.ok) throw new Error(`project ${directory}: ${project.status} ${await project.text()}`)
  return ((await resolved.json()) as { workspaceId: string }).workspaceId
}

async function seedSessions(stack: Stack, api: ClaxedoApi, directory: string, label: string, count: number) {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const session = await api.createSession(directory, { title: `${label} ${index + 1}`, harness: SCRIPTED_ACP_HARNESS })
    for (let turn = 1; turn <= 3; turn += 1) {
      const script = `${label}-${index}-${turn}`
      await stack.acp.write(script, { steps: [{ kind: "text", text: `Reply ${turn} for ${label} ${index + 1}: ${"lorem ipsum dolor sit amet ".repeat(30)}` }] })
      await api.prompt(directory, session.id, `Question ${turn}. ${acpScriptToken(script)}`)
    }
    ids.push(session.id)
  }
  return ids
}

async function benchmarkWorkspace(stack: Stack, api: ClaxedoApi): Promise<Workspace> {
  const fixture = await import(path.join(BENCHMARK, "src/workspace-fixture.mjs")) as {
    buildWorkspaceFixtureManifest: (load: Record<string, number | string>, seed: string) => { directories: string[]; files: { path: string; changed: boolean; byteLength: number; hunks: unknown[] }[]; changedFilePaths: string[] }
    generateWorkspaceFileBytes: (seed: string, file: unknown, revision: "initial" | "current") => Uint8Array
  }
  const seed = "panel-switch-lane"
  const manifest = fixture.buildWorkspaceFixtureManifest({ generator: "agent-app-workspace-v1", directoryCount: 16, sourceFileCount: 160, sourceFileBytes: 32768, changedFileCount: 24, diffHunksPerFile: 8, diffLinesPerHunk: 24, openFileTabCount: 4 }, seed)
  const directory = path.join(stack.dataDir, "workspaces", "bench")
  await fs.mkdir(directory, { recursive: true })
  await git(directory, "init", "-q", "--initial-branch=main")
  for (const revision of ["initial", "current"] as const) {
    for (const file of manifest.files) {
      const target = path.join(directory, file.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, fixture.generateWorkspaceFileBytes(seed, file, revision))
    }
    if (revision === "initial") {
      await git(directory, "add", "-A")
      await git(directory, "commit", "-qm", "benchmark corpus")
    }
  }
  const id = await registerWorkspace(stack, directory, "Bench")
  const sessions = await seedSessions(stack, api, directory, "bench", 2)
  return { id, directory, name: "bench", sessions, files: manifest.files.map((file) => file.path), changed: manifest.changedFilePaths }
}

async function largeWorkspace(stack: Stack, api: ClaxedoApi): Promise<Workspace> {
  const directory = path.join(stack.dataDir, "workspaces", "large")
  execFileSync("git", ["clone", "-q", "--local", "--no-checkout", LARGE_SOURCE, directory], { stdio: "pipe" })
  execFileSync("git", ["-C", directory, "checkout", "-q", "HEAD"], { stdio: "pipe" })
  const tracked = execFileSync("git", ["-C", directory, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
  const candidates = tracked.filter((file) => file.startsWith("packages/claxedo-app/src/") && file.endsWith(".ts") && !file.endsWith(".test.ts"))
  const changed = candidates.filter((_, index) => index % Math.floor(candidates.length / 40) === 0).slice(0, 40)
  for (const file of changed) {
    const target = path.join(directory, file)
    const text = await fs.readFile(target, "utf8")
    const lines = text.split("\n")
    for (let hunk = 0; hunk < 6; hunk += 1) {
      const at = Math.min(lines.length - 1, Math.floor(((hunk + 1) * lines.length) / 7))
      lines.splice(at, 0, ...Array.from({ length: 12 }, (_, index) => `// changed line ${hunk}-${index} in ${path.basename(file)}`))
    }
    await fs.writeFile(target, lines.join("\n"))
  }
  const id = await registerWorkspace(stack, directory, "Large")
  const sessions = await seedSessions(stack, api, directory, "large", 2)
  return { id, directory, name: "large", sessions, files: tracked, changed }
}

class Runner {
  private cdp: CDPSession | undefined
  private results: Result[] = []
  private requests: { url: string; ms: number; startMs: number }[] = []
  private windowStart = 0
  private serial = 0
  constructor(private readonly page: Page, private readonly mapper: ReturnType<typeof createSourceMapper>) {}

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
    const collect = (event: { value: TraceEvent[] }) => chunks.push(...event.value)
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
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile }
    const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()))
    await cdp.send("Tracing.end")
    await complete
    cdp.off("Tracing.dataCollected", collect)
    this.serial += 1
    const traceFile = path.join(OUT, `${workspace}-${interaction}-${run}.trace.json`)
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
      workspace, interaction, run,
      inputToReadyMs: recording.readyAt === undefined ? -1 : recording.readyAt - recording.inputAt,
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
    console.log(`[${workspace}] ${interaction} #${run}: ready ${result.inputToReadyMs.toFixed(1)}ms (frame end ${result.inputToReadyFrameEndMs.toFixed(1)}) settled ${result.inputToSettledMs.toFixed(1)} shell ${result.inputToShellSettledMs?.toFixed(1) ?? "-"} worst ${result.worstFrameMs.toFixed(1)}ms over16.7=${result.framesOver16_7}/${result.frameCount} quiet-worst ${result.worstFrameToQuietMs.toFixed(1)}ms@${result.worstFrameToQuietAtMs.toFixed(0)} over=${result.framesOver16_7ToQuiet} load ${result.load}`)
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

const shellSelector = "[data-testid='workspace-panel-shell']"

async function settle(page: Page) {
  await page.waitForFunction((selector) => {
    const shell = document.querySelector<HTMLElement>(selector)
    return !shell || shell.dataset.shellSettled === "true"
  }, shellSelector, { polling: "raf" })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function panelOpen(page: Page) {
  return page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.dataset.open === "true", shellSelector)
}

function toggle(page: Page, open: boolean): Locator {
  return page.locator(`[data-testid='workspace-panel-toggle'][aria-label='${open ? "Open" : "Close"} workspace panel']`)
}

async function ensureOpen(page: Page) {
  await settle(page)
  if (!(await panelOpen(page))) {
    await toggle(page, true).click()
    await settle(page)
  }
}

async function ensureNavigator(page: Page, navigator: "files" | "changes") {
  await ensureOpen(page)
  const label = navigator === "files" ? "Files" : "Changes"
  const open = page.locator(`button[aria-label='Open ${label}']`)
  if (await open.count()) await open.click()
  await page.waitForFunction((kind) => document.querySelector(`[data-testid='workspace-navigator-overlay'][data-navigator-kind='${kind}'][data-open='true']`) !== null, navigator, { polling: "raf" })
  await settle(page)
}

const navigatorScroller = "[data-testid='workspace-files-navigator'][data-mode='files'] [data-scrollable], [data-testid='workspace-files-navigator'][data-mode='files'] [data-slot='scroll-view-viewport']"

async function scrollTreeTo(page: Page, rowPath: string): Promise<Locator> {
  const row = page.locator(`[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path='${rowPath}']`).first()
  const scroller = page.locator(navigatorScroller).first()
  await scroller.evaluate((element) => (element.scrollTop = 0))
  for (let step = 0; step < 200; step += 1) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded()
      return row
    }
    const atEnd = await scroller.evaluate((element) => {
      const next = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + element.clientHeight * 0.8)
      const done = next <= element.scrollTop
      element.scrollTop = next
      return done
    })
    if (atEnd) break
  }
  throw new Error(`tree row ${rowPath} not found`)
}

async function treeRow(page: Page, file: string): Promise<Locator> {
  const segments = file.split("/")
  for (let depth = 1; depth < segments.length; depth += 1) {
    const dir = segments.slice(0, depth).join("/")
    const expanded = await page.locator(`[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path^='${dir}/']`).count()
    if (expanded > 0) continue
    const row = await scrollTreeTo(page, dir)
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click()
  }
  return scrollTreeTo(page, file)
}

function fileTab(page: Page, file: string): Locator {
  return page.locator(`[data-slot='workspace-tab'][data-workspace-tab-kind='file'][data-workspace-tab-id$='${file}'] > button`)
}

function reviewTab(page: Page): Locator {
  return page.locator("[data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button")
}

function railRow(page: Page, sessionId: string): Locator {
  return page.locator(`[data-testid='rail-sidebar-session-row'][data-session-id='${sessionId}']`)
}

const SECTIONS = (process.env.PANEL_SECTIONS ?? "open,navigator,tabs,tree,review,maximize,session").split(",")

async function section(name: string, run: () => Promise<void>) {
  if (!SECTIONS.includes(name)) return
  await run()
}

async function goToSession(page: Page, sessionId: string) {
  await railRow(page, sessionId).click()
  await page.waitForFunction((id) => document.querySelector(`[data-testid='session-page-root'][data-session-id='${id}'] [data-component='prompt-input']`) !== null, sessionId, { polling: "raf" })
}

async function openFileTabs(page: Page, files: readonly string[]) {
  for (const file of files) {
    if (await fileTab(page, file).count()) continue
    await (await treeRow(page, file)).click()
    await page.waitForFunction((path) => [...document.querySelectorAll<HTMLElement>("[data-testid='tab-file-root']")].some((root) => root.dataset.tabFilePath === path && root.dataset.tabFileRenderState === "painted"), file, { polling: "raf" })
  }
}

async function walk(page: Page, runner: Runner, workspace: Workspace, stack: Stack) {
  const name = workspace.name
  const [sessionA, sessionB] = workspace.sessions
  if (!sessionA || !sessionB) throw new Error("two sessions needed")
  await page.goto(`${stack.url}${sessionRoute(workspace.id, sessionA)}`)
  await page.locator("[data-testid='session-page-root'][data-session-id='" + sessionA + "'] [data-component='prompt-input']").waitFor({ timeout: 60_000 })
  const cleared = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((key) => key.includes("panel:navigator") || key.includes("panel:width"))
    for (const key of keys) localStorage.removeItem(key)
    return keys
  })
  if (cleared.length) {
    console.log(`[panel] cleared ${cleared.join(", ")}`)
    await page.reload()
    await page.locator("[data-testid='session-page-root'][data-session-id='" + sessionA + "'] [data-component='prompt-input']").waitFor({ timeout: 60_000 })
  }
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)))
  await runner.attach()
  const openFiles = workspace.files.filter((file) => !workspace.changed.includes(file)).slice(0, 12)
  const tabFiles = openFiles.slice(0, 3)
  const [first, second, third] = tabFiles
  if (!first || !second || !third) throw new Error("three tab files needed")

  await section("open", async () => {
    await runner.measure(name, "open-panel-first", 0, { kind: "panel-open-files" }, () => toggle(page, true).click())
    await settle(page)
    await openFileTabs(page, tabFiles)
    await reviewTab(page).click()
    await settle(page)
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "close-panel", run, { kind: "panel-closed" }, () => toggle(page, false).click())
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
      await runner.measure(name, "open-panel-warm", run, { kind: "panel-open-files" }, () => toggle(page, true).click())
      await settle(page)
    }
  })
  await ensureNavigator(page, "files")
  await openFileTabs(page, tabFiles)
  await section("navigator", async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "files-to-changes", run, { kind: "navigator", navigator: "changes" }, () => page.locator("button[aria-label='Open Changes']").click())
      await settle(page)
      await runner.measure(name, "changes-to-files", run, { kind: "navigator", navigator: "files" }, () => page.locator("button[aria-label='Open Files']").click())
      await settle(page)
    }
  })
  await section("tabs", async () => {
    await reviewTab(page).click()
    await settle(page)
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "review-to-file-tab", run, { kind: "file-tab", path: first }, () => fileTab(page, first).click())
      await runner.measure(name, "file-tab-to-file-tab", run, { kind: "file-tab", path: second }, () => fileTab(page, second).click())
      await runner.measure(name, "file-tab-to-review", run, { kind: "review" }, () => reviewTab(page).click())
    }
  })
  await section("tree", async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const file = openFiles[3 + run]
      if (!file) break
      const row = await treeRow(page, file)
      await settle(page)
      await runner.measure(name, "open-file-from-tree", run, { kind: "file-tab", path: file }, () => row.click())
      await reviewTab(page).click()
      await settle(page)
    }
  })
  await section("review", async () => {
    await ensureNavigator(page, "changes")
    await reviewTab(page).click()
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-review-total-files]")?.dataset.reviewRenderedFiles ?? 0) > 0, undefined, { polling: "raf" })
    await settle(page)
    const changedCount = workspace.changed.length
    for (let run = 1; run <= Math.min(RUNS, 3); run += 1) {
      await runner.measure(name, "expand-all", run, { kind: "review", openCount: changedCount }, () => page.locator("button[aria-label='Expand all']").click())
      await runner.measure(name, "collapse-all", run, { kind: "review", openCount: 0 }, () => page.locator("button[aria-label='Collapse all']").click())
    }
    await runner.measure(name, "expand-one", 1, { kind: "review", openCount: 1 }, () => page.locator(`button[aria-label='Toggle diff for ${workspace.changed[0]}']`).click())
    await runner.measure(name, "collapse-one", 1, { kind: "review", openCount: 0 }, () => page.locator(`button[aria-label='Toggle diff for ${workspace.changed[0]}']`).click())
  })
  await section("maximize", async () => {
    for (let run = 1; run <= Math.min(RUNS, 3); run += 1) {
      await runner.measure(name, "maximize", run, { kind: "maximized", maximized: true }, () => page.locator("button[aria-label='Maximize workspace panel']").click())
      await settle(page)
      await runner.measure(name, "restore", run, { kind: "maximized", maximized: false }, () => page.locator("button[aria-label='Restore workspace panel width']").click())
      await settle(page)
    }
  })
  await section("session", async () => {
    await ensureNavigator(page, "files")
    await goToSession(page, sessionB)
    await ensureNavigator(page, "files")
    await settle(page)
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "session-switch-panel-files", run, { kind: "session", sessionId: sessionA, panel: "files" }, () => railRow(page, sessionA).click())
      await settle(page)
      await runner.measure(name, "session-switch-panel-files-back", run, { kind: "session", sessionId: sessionB, panel: "files" }, () => railRow(page, sessionB).click())
      await settle(page)
    }
    await ensureNavigator(page, "changes")
    await goToSession(page, sessionA)
    await ensureNavigator(page, "changes")
    await settle(page)
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "session-switch-panel-changes", run, { kind: "session", sessionId: sessionB, panel: "changes" }, () => railRow(page, sessionB).click())
      await settle(page)
      await runner.measure(name, "session-switch-panel-changes-back", run, { kind: "session", sessionId: sessionA, panel: "changes" }, () => railRow(page, sessionA).click())
      await settle(page)
    }
    await goToSession(page, sessionB)
    await ensureOpen(page)
    await settle(page)
    await toggle(page, false).click()
    await settle(page)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
    for (let run = 1; run <= Math.min(RUNS, 3); run += 1) {
      await runner.measure(name, "session-switch-panel-restores-open", run, { kind: "session", sessionId: sessionA, panel: "changes" }, () => railRow(page, sessionA).click())
      await settle(page)
      await runner.measure(name, "session-switch-panel-restores-closed", run, { kind: "session", sessionId: sessionB, panel: "closed" }, () => railRow(page, sessionB).click())
      await settle(page)
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
    }
  })
}

async function memory(page: Page, cdp: CDPSession, label: string) {
  await cdp.send("HeapProfiler.collectGarbage")
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }
  const pick = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0
  console.log(`[memory] ${label}: nodes ${pick("Nodes")} listeners ${pick("JSEventListeners")} heap ${(pick("JSHeapUsedSize") / 1048576).toFixed(1)} MiB / ${(pick("JSHeapTotalSize") / 1048576).toFixed(1)} MiB`)
  void page
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  console.log(`[panel] out ${OUT}, load ${load()}, runs ${RUNS}`)
  await prepareHarness()
  const stack = await startStack({ label: "panel-switch" })
  try {
    const api = new ClaxedoApi(stack.url)
    const wanted = (process.env.PANEL_WORKSPACES ?? "bench,large").split(",")
    const workspaces: Workspace[] = []
    if (wanted.includes("bench")) workspaces.push(await benchmarkWorkspace(stack, api))
    if (wanted.includes("large")) workspaces.push(await largeWorkspace(stack, api))
    console.log(`[panel] workspaces ${workspaces.map((workspace) => `${workspace.name}(${workspace.files.length} files, ${workspace.changed.length} changed)`).join(", ")}`)
    const browser = await chromium.launch({ channel: "chromium", headless: process.env.PANEL_HEADED !== "1" })
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-US", timezoneId: "UTC" })
      const page = await context.newPage()
      const mapper = createSourceMapper(appDistDir())
      const runner = new Runner(page, mapper)
      const cdp = await context.newCDPSession(page)
      await cdp.send("Performance.enable")
      for (const workspace of workspaces) {
        await walk(page, runner, workspace, stack)
        await memory(page, cdp, `after ${workspace.name} walk`)
        await runner.flush()
      }
      await memory(page, cdp, "end")
    } finally {
      await browser.close()
    }
  } finally {
    await stack.close()
  }
}

await main()
