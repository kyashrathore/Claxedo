import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { chromium } from "playwright-core"
import { installAgentBrowserObserver, measureSessionActivation, type SessionReadinessTarget } from "./agent-browser-observer"
import { processFamily, readProcessTable, sameProcessIdentity, type ProcessSnapshot } from "./agent-process-family"
import { connectCdpPage, type BenchmarkPage } from "./agent-cdp-page"
import { AGENT_APP_WINDOW } from "./agent-display-contract"
import type { ClaxedoLaunch, OwnedProcess } from "./agent-claxedo-launcher"
import { createCommittedRendererHandshake } from "./agent-claxedo-web-handshake"

export async function launchClaxedoWeb(input: {
  appRoot: string
  isolatedProfilePath: string
  dataDirectory: string
  readinessTargets: readonly SessionReadinessTarget[]
  serverPort: number
  previewPort: number
  timeoutMs?: number
  extraEnv?: Record<string, string>
}): Promise<ClaxedoLaunch> {
  const timeoutMs = input.timeoutMs ?? Number(process.env.CLAXEDO_BENCHMARK_LAUNCH_TIMEOUT_MS ?? "60000")
  await Promise.all([
    mkdir(input.isolatedProfilePath, { recursive: true, mode: 0o700 }),
    mkdir(input.dataDirectory, { recursive: true, mode: 0o700 }),
    ...["SingletonCookie", "SingletonLock", "SingletonSocket"].map((name) =>
      rm(path.join(input.isolatedProfilePath, name), { force: true, recursive: true }),
    ),
  ])
  const debugPort = await availablePort()
  const startTimestamp = performance.now()
  const application = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "agent-claxedo-web-root.ts")],
    cwd: input.appRoot,
    env: {
      ...process.env,
      CLAXEDO_DATA_DIR: input.dataDirectory,
      CLAXEDO_WEB_APP_ROOT: input.appRoot,
      CLAXEDO_WEB_BROWSER_EXECUTABLE: chromium.executablePath(),
      CLAXEDO_WEB_SERVER_ENTRY: path.join(input.appRoot, "../claxedo-desktop/resources/claxedo-server/index.js"),
      CLAXEDO_WEB_ENGINE_ENTRY: path.join(input.appRoot, "../opencode/dist/node/node.js"),
      CLAXEDO_WEB_PROFILE: input.isolatedProfilePath,
      CLAXEDO_WEB_SERVER_PORT: String(input.serverPort),
      CLAXEDO_WEB_PREVIEW_PORT: String(input.previewPort),
      CLAXEDO_WEB_DEBUG_PORT: String(debugPort),
      GOMAXPROCS: process.env.GOMAXPROCS ?? "2",
      ...(input.extraEnv ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const rootOutput: string[] = []
  const previewDocumentUrl = `http://127.0.0.1:${input.previewPort}/index.local.html`
  const rendererHandshake = createCommittedRendererHandshake(previewDocumentUrl)
  void drain(application.stdout, rootOutput, rendererHandshake)
  void drain(application.stderr, rootOutput)

  let page: BenchmarkPage | undefined
  try {
    const previewUrl = `http://127.0.0.1:${input.previewPort}/`
    // The root publishes this only after Playwright observes DOMContentLoaded
    // for the exact preview document. Attach after that event so CDP cannot bind
    // to Chromium's provisional target during the initial navigation.
    await waitForCommittedRenderer(rendererHandshake.committed, application.exited, timeoutMs)
    page = await connectCdpPage({
      port: debugPort,
      process: application,
      timeoutMs,
      targetUrlIncludes: `127.0.0.1:${input.previewPort}/`,
    })
    const connectedPage = page
    await connectedPage.rawCommand("Emulation.setDeviceMetricsOverride", {
      width: AGENT_APP_WINDOW.width,
      height: AGENT_APP_WINDOW.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    // Require the committed HTTP document before observing application semantics.
    try {
      await connectedPage.waitForFunction(
        (origin) => location.origin === origin && document.documentElement !== null,
        new URL(previewUrl).origin,
        { timeout: timeoutMs },
      )
    } catch (error) {
      const snapshot = await connectedPage.evaluate(() => ({
        href: location.href,
        origin: location.origin,
        documentUrl: document.URL,
        readyState: document.readyState,
        title: document.title,
        text: document.body?.innerText.slice(0, 500) ?? "",
      })).catch((snapshotError) => ({ snapshotError: String(snapshotError) }))
      throw new Error(`Claxedo web target did not reach its HTTP origin: ${JSON.stringify(snapshot)}`, { cause: error })
    }
    await connectedPage.evaluate(() => {
      const target = window as typeof window & { __claxedoWebBenchmarkErrors?: string[] }
      target.__claxedoWebBenchmarkErrors = []
      addEventListener("error", (rawEvent) => {
        const event = rawEvent as ErrorEvent
        target.__claxedoWebBenchmarkErrors?.push(event.error?.stack ?? event.message)
      })
      addEventListener("unhandledrejection", (rawEvent) => {
        const event = rawEvent as PromiseRejectionEvent
        target.__claxedoWebBenchmarkErrors?.push(event.reason instanceof Error ? event.reason.stack ?? event.reason.message : String(event.reason))
      })
    })
    await installAgentBrowserObserver(connectedPage)
    let reloadCount = 0
    let crashCount = 0
    let ready = false
    connectedPage.on("framenavigated", (frame) => {
      if (ready && frame === connectedPage.mainFrame()) reloadCount++
    })
    connectedPage.on("crash", () => crashCount++)
    try {
      await connectedPage.waitForFunction(
        (sessionIds) => sessionIds.some((sessionId) => {
          const row = document.querySelector<HTMLElement>(
            `[data-testid="rail-sidebar-session-row"][data-session-id="${CSS.escape(sessionId)}"]`,
          )
          if (!row) return false
          const bounds = row.getBoundingClientRect()
          return bounds.width > 0 && bounds.height > 0 && getComputedStyle(row).visibility !== "hidden"
        }),
        input.readinessTargets.map((target) => target.sessionId),
        { timeout: timeoutMs },
      )
    } catch (error) {
      const snapshot = await connectedPage.evaluate(async (serverPort) => {
        const storedServer = localStorage.getItem("opencode.global.dat:server")
        const stored = storedServer ? JSON.parse(storedServer) as {
          projects?: { local?: Array<{ worktree?: string }> }
        } : undefined
        const probes = await Promise.all((stored?.projects?.local ?? []).slice(0, 4).map(async (project) => {
          const directory = project.worktree ?? ""
          const url = new URL(`http://127.0.0.1:${serverPort}/api/claxedo/session-list`)
          url.searchParams.set("scope", "workspace")
          url.searchParams.set("limit", "20")
          url.searchParams.set("directory", directory)
          try {
            const response = await fetch(url, { headers: { "x-opencode-directory": directory } })
            return { directory, url: url.toString(), status: response.status, body: (await response.text()).slice(0, 1_000) }
          } catch (probeError) {
            return { directory, url: url.toString(), error: String(probeError) }
          }
        }))
        return {
          probes,
          errors: (window as typeof window & { __claxedoWebBenchmarkErrors?: string[] }).__claxedoWebBenchmarkErrors,
          url: location.href,
          title: document.title,
          text: document.body?.innerText.slice(0, 1_500) ?? "",
          claxedo: Boolean(document.querySelector("[data-claxedo]")),
          rows: [...document.querySelectorAll<HTMLElement>('[data-testid="rail-sidebar-session-row"]')]
            .slice(0, 20)
            .map((row) => ({ id: row.dataset.sessionId, text: row.innerText.slice(0, 120) })),
          fields: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
            .slice(0, 10)
            .map((field) => field.value.slice(0, 500)),
          storedServer,
          resources: performance.getEntriesByType("resource").slice(-30).map((entry) => entry.name),
        }
      }, input.serverPort).catch((snapshotError) => ({ snapshotError: String(snapshotError) }))
      throw new Error(
        `Claxedo web semantic readiness timed out (rootExit=${String(application.exitCode)}, rootOutput=${JSON.stringify(rootOutput.slice(-12))}): ${JSON.stringify(snapshot)}`,
        { cause: error },
      )
    }
    const exactViewport = await connectedPage.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    if (exactViewport.width !== AGENT_APP_WINDOW.width || exactViewport.height !== AGENT_APP_WINDOW.height) {
      throw new Error(`Claxedo web could not establish the fixed viewport: ${JSON.stringify(exactViewport)}`)
    }
    const readinessTarget = input.readinessTargets[0]
    if (!readinessTarget) throw new Error("Claxedo web readiness requires a canonical session target")
    const semanticReadiness = await measureSessionActivation(connectedPage, readinessTarget)
    if (semanticReadiness.state !== "exact") throw new Error(`Claxedo web strict readiness failed: ${semanticReadiness.reason}`)
    await stablePaint(connectedPage)
    ready = true
    const token = `cold-ready-${crypto.randomUUID()}`
    await connectedPage.evaluate((value) => window.__CLAXEDO_AGENT_APP_BENCHMARK__?.armAction(value), token)
    await connectedPage.keyboard.press("Tab")
    const trusted = await connectedPage.evaluate(
      async (value) => await window.__CLAXEDO_AGENT_APP_BENCHMARK__?.finishAction(value),
      token,
    )
    if (!trusted || trusted.state !== "exact") throw new Error("Claxedo web rejected the cold-ready trusted input probe")
    const endTimestamp = performance.now()
    const root = (await readProcessTable()).find((item) => item.pid === application.pid)
    if (!root) throw new Error(`Unable to resolve Claxedo web root process ${application.pid}`)
    const processRecord: OwnedProcess = {
      pid: application.pid,
      startTimeMs: root.startTimeMs,
      owner: "application",
      category: "claxedo-web-root",
    }
    const known = new Map<string, ProcessSnapshot>()
    const refreshKnown = async () => {
      const family = processFamily(await readProcessTable(), application.pid)
      for (const item of family) known.set(`${item.pid}:${item.startTimeMs}`, item)
      return family
    }
    await refreshKnown()
    const timer = setInterval(() => void refreshKnown().catch(() => undefined), 100)
    timer.unref()
    return {
      application,
      page: connectedPage,
      serverUrl: `http://127.0.0.1:${input.serverPort}`,
      process: processRecord,
      coldReady: {
        startTimestamp,
        endTimestamp,
        durationMs: endTimestamp - startTimestamp,
        resolutionMs: 1,
        trustedInputAccepted: true,
        reloadCount,
        crashCount,
        semantic: semanticReadiness.paintedMessage,
      },
      async inspect() {
        return {
          surface: await connectedPage.evaluate(() => ({
            visibilityState: document.visibilityState,
            focused: document.hasFocus(),
            hidden: document.hidden,
            viewport: { width: innerWidth, height: innerHeight },
          })),
          processes: await refreshKnown(),
        }
      },
      async shutdown() {
        clearInterval(timer)
        await refreshKnown().catch(() => [])
        application.kill("SIGTERM")
        await Promise.race([application.exited, Bun.sleep(5_000)])
        if (application.exitCode === null) application.kill("SIGKILL")
        await Promise.race([application.exited, Bun.sleep(2_000)])
        connectedPage.close()
        const table = await readProcessTable()
        const forced: OwnedProcess[] = []
        for (const item of known.values()) {
          if (!table.some((candidate) => sameProcessIdentity(candidate, item))) continue
          forced.push(owned(item, application.pid))
          try { process.kill(item.pid, "SIGKILL") } catch {}
        }
        await Bun.sleep(100)
        const final = await readProcessTable()
        const survivors = [...known.values()]
          .filter((item) => final.some((candidate) => sameProcessIdentity(candidate, item)))
          .map((item) => owned(item, application.pid))
        const survivorKeys = new Set(survivors.map((item) => `${item.pid}:${item.startTimeMs}`))
        const terminated = [...known.values()]
          .filter((item) => !survivorKeys.has(`${item.pid}:${item.startTimeMs}`))
          .map((item) => owned(item, application.pid))
        return { terminated, survivors, forced }
      },
    }
  } catch (error) {
    page?.close()
    const family = await readProcessTable()
      .then((table) => processFamily(table, application.pid))
      .catch(() => [] as ProcessSnapshot[])
    application.kill("SIGTERM")
    await Promise.race([application.exited, Bun.sleep(3_000)])
    if (application.exitCode === null) application.kill("SIGKILL")
    const table = await readProcessTable()
    for (const item of family) {
      if (!table.some((candidate) => sameProcessIdentity(candidate, item))) continue
      try { process.kill(item.pid, "SIGKILL") } catch {}
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Claxedo web root failed: ${detail}; rootOutput=${JSON.stringify(rootOutput.slice(-20))}`, { cause: error })
  }
}

function owned(item: ProcessSnapshot, rootPid: number): OwnedProcess {
  return {
    pid: item.pid,
    startTimeMs: item.startTimeMs,
    owner: "application",
    category: item.pid === rootPid ? "claxedo-web-root" : "claxedo-web-descendant",
  }
}

async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Failed to reserve Claxedo web CDP port")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function stablePaint(page: BenchmarkPage) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  output?: string[],
  handshake?: ReturnType<typeof createCommittedRendererHandshake>,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) {
      const tail = handshake?.end() ?? []
      if (output) appendOutput(output, tail)
      return
    }
    const text = decoder.decode(chunk.value, { stream: true })
    const lines = handshake?.push(text) ?? text.split("\n").filter(Boolean)
    if (output) appendOutput(output, lines)
  }
}

function appendOutput(output: string[], lines: string[]) {
  output.push(...lines)
  if (output.length > 100) output.splice(0, output.length - 100)
}

async function waitForCommittedRenderer(
  committed: Promise<void>,
  exited: Promise<number>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out waiting for Claxedo web committed renderer")), timeoutMs)
  })
  try {
    await Promise.race([
      committed,
      exited.then((code) => {
        throw new Error(`Claxedo web root exited before committing its renderer (${String(code)})`)
      }),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
