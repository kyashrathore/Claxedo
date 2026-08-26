import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { chromium } from "playwright-core"
import { committedRendererEvent } from "./agent-claxedo-web-handshake"
import { waitForClaxedoServerReady } from "./agent-claxedo-web-server-ready"

const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Claxedo web benchmark root requires ${name}`)
  return value
}

const number = (name: string) => {
  const value = Number(required(name))
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Claxedo web benchmark root received invalid ${name}`)
  return value
}

const appRoot = required("CLAXEDO_WEB_APP_ROOT")
const browserExecutable = required("CLAXEDO_WEB_BROWSER_EXECUTABLE")
const serverEntry = required("CLAXEDO_WEB_SERVER_ENTRY")
const engineEntry = required("CLAXEDO_WEB_ENGINE_ENTRY")
const profile = required("CLAXEDO_WEB_PROFILE")
const serverPort = number("CLAXEDO_WEB_SERVER_PORT")
const previewPort = number("CLAXEDO_WEB_PREVIEW_PORT")
const debugPort = number("CLAXEDO_WEB_DEBUG_PORT")
const serverUrl = `http://127.0.0.1:${serverPort}`
const previewUrl = `http://127.0.0.1:${previewPort}`
const previewDocumentUrl = `${previewUrl}/index.local.html`

const server = spawn(
  process.env.CLAXEDO_WEB_NODE ?? "node",
  [serverEntry],
  {
    cwd: path.dirname(serverEntry),
    env: {
      ...process.env,
      CLAXEDO_CHILD_PORT: String(serverPort),
      CLAXEDO_DESKTOP_PARENT_PID: String(process.pid),
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: engineEntry,
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  },
)
await waitForClaxedoServerReady(server, serverPort, 30_000)

const preview = spawn(
  process.env.CLAXEDO_WEB_NODE ?? "node",
  [
    path.join(appRoot, "node_modules/vite/bin/vite.js"),
    "preview",
    "--config",
    "vite.local.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(previewPort),
    "--strictPort",
  ],
  {
    cwd: appRoot,
    env: {
      ...process.env,
      VITE_CLAXEDO_SERVER_URL: serverUrl,
      VITE_OPENCODE_BACKEND_URL: serverUrl,
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
)
await waitForHttp(previewDocumentUrl, preview)

const browser = await chromium.launchPersistentContext(profile, {
  executablePath: browserExecutable,
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [
    `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*",
    "--no-proxy-server",
    "--allow-insecure-localhost",
    "--disable-features=HttpsFirstBalancedModeAutoEnable,HttpsUpgrades,HttpsFirstModeV2ForEngagedSites",
  ],
})
const browserPage = browser.pages()[0] ?? await browser.newPage()
await browserPage.goto(previewDocumentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
process.stdout.write(`${committedRendererEvent(browserPage.url())}\n`)

let stopping = false
const stop = async (code: number) => {
  if (stopping) return
  stopping = true
  await browser.close().catch(() => undefined)
  preview.kill("SIGTERM")
  server.kill("SIGTERM")
  await Promise.allSettled([
    waitForExit(preview, 3_000),
    waitForExit(server, 3_000),
  ])
  if (preview.exitCode === null) preview.kill("SIGKILL")
  if (server.exitCode === null) server.kill("SIGKILL")
  process.exit(code)
}

process.once("SIGINT", () => void stop(130))
process.once("SIGTERM", () => void stop(143))
browser.once("close", () => void stop(1))
await new Promise<never>(() => {})

async function waitForHttp(url: string, child: ChildProcess) {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Claxedo web preview exited before readiness (${child.exitCode})`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Claxedo web preview did not become ready")
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}
