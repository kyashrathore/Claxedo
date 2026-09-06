import { rejectRemovedExecutionOptions } from "../execution-profile"
import { frameSamplingLaunchArgs } from "../frame-sampler"
import { appRoot, reportsRoot } from "../storage"
import { app } from "../targets"
import type { AppTarget, RunOptions, ScenarioId } from "../types"
import { mkdir, rename } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import { startMockStreamServer } from "./mock-streams"

export type BrowserTarget = {
  target: AppTarget
  baseUrl: string
  mockPort: number
  command: string
  streams: ReturnType<typeof startMockStreamServer>
  process?: Bun.Subprocess
}

// Exported so the heavy-workspace contract test can pin its
// HEAVY_WORKSPACE_VIEWPORT_HEIGHT against the real benchmark window.
export const benchmarkViewport = { width: 1440, height: 960 }

export function launchBenchmarkBrowser(options: RunOptions) {
  return chromium.launch({
    headless: options.headless,
    args: frameSamplingLaunchArgs,
    timeout: 30_000,
  })
}

export async function closeBenchmarkBrowser(browser: Browser) {
  if (!browser.isConnected()) return
  await Promise.race([
    browser.close().catch(() => undefined),
    Bun.sleep(10_000),
  ])
}

export async function startApp(): Promise<BrowserTarget> {
  rejectRemovedExecutionOptions()
  const basePort = await freePort()
  const streams = startMockStreamServer({ port: Number(process.env.CLAXEDO_PERF_MOCK_PORT) || 0 })
  const mockPort = streams.port
  const baseUrl = `http://127.0.0.1:${basePort}`
  const script = process.env.CLAXEDO_PERF_APP_SCRIPT ?? "serve"
  let appProcess: Bun.Subprocess | undefined
  try {
    if (script === "serve" && process.env.CLAXEDO_PERF_SKIP_BUILD !== "1") await buildProductionApp(mockPort)
    // The package script owns the browser build/auth selection for both Vite
    // preview and development. A direct Vite invocation bypasses that contract.
    const cmd = ["bun", "run", script, "--", "--host", "127.0.0.1", "--port", String(basePort)]
    const command = cmd.join(" ")
    const proc = Bun.spawn({
      cmd,
      cwd: appRoot,
      env: {
        ...process.env,
        PORT: String(basePort),
        PLAYWRIGHT_PORT: String(basePort),
        PLAYWRIGHT_SERVER_HOST: "127.0.0.1",
        PLAYWRIGHT_SERVER_PORT: String(mockPort),
        VITE_OPENCODE_SERVER_HOST: "127.0.0.1",
        VITE_OPENCODE_SERVER_PORT: String(mockPort),
        VITE_CLAXEDO_SERVER_URL: `http://127.0.0.1:${mockPort}`,
        VITE_CLAXEDO_E2E: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    appProcess = proc
    void drain(proc.stdout)
    void drain(proc.stderr)
    await waitForServer(baseUrl, proc)
    return { target: app.id, baseUrl, mockPort, command, process: proc, streams }
  } catch (error) {
    await stopApp({ target: app.id, baseUrl, mockPort, command: "startup failed", process: appProcess, streams })
    throw error
  }
}

async function buildProductionApp(mockPort: number) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "build"],
    cwd: appRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_SERVER_HOST: "127.0.0.1",
      PLAYWRIGHT_SERVER_PORT: String(mockPort),
      VITE_OPENCODE_SERVER_HOST: "127.0.0.1",
      VITE_OPENCODE_SERVER_PORT: String(mockPort),
      VITE_CLAXEDO_SERVER_URL: `http://127.0.0.1:${mockPort}`,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await proc.exited === 0) return
  throw new Error("Claxedo production build failed before performance measurement")
}

export async function stopApp(app: BrowserTarget) {
  await app.streams.stop()
  if (!app.process) return
  app.process.kill()
  const exited = await Promise.race([
    app.process.exited.then(() => true).catch(() => true),
    Bun.sleep(10_000).then(() => false),
  ])
  if (exited) return
  app.process.kill("SIGKILL")
  await Promise.race([
    app.process.exited.catch(() => undefined),
    Bun.sleep(2_000),
  ])
}

async function waitForServer(url: string, process: Bun.Subprocess) {
  const started = Date.now()
  while (Date.now() - started < 120_000) {
    if (process.exitCode !== null) throw new Error(`App dev server exited before becoming ready: ${url}`)
    const ok = await fetch(url).then(() => true).catch(() => false)
    if (ok) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for app dev server: ${url}`)
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port")))
    })
    server.on("error", reject)
  })
}

export async function drain(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return
  for await (const _ of stream) {
  }
}

export async function closeContextAndSaveVideo(
  context: BrowserContext,
  page: Page,
  target: AppTarget,
  scenario: ScenarioId,
  iteration: number,
) {
  const video = page.video()
  // Gating runs retain the lightweight isolated context until suite teardown.
  // Closing only the page releases its renderer without a late context-close
  // operation racing the next half of the pair.
  if (!video) {
    await Promise.race([
      page.close().catch(() => undefined),
      Bun.sleep(2_000),
    ])
    return undefined
  }
  const closed = await Promise.race([
    context.close().then(() => true).catch(() => false),
    Bun.sleep(5_000).then(() => false),
  ])
  if (!closed) return undefined
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw || !await Bun.file(raw).exists()) return undefined
  const dir = path.join(reportsRoot, "videos")
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${target}-${scenario}-${iteration + 1}.webm`)
  await rename(raw, file).catch(async () => {
    await Bun.write(file, Bun.file(raw))
  })
  return file
}
