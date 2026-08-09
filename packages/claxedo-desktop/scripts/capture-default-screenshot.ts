#!/usr/bin/env bun

import { $ } from "bun"
import { createRequire } from "node:module"
import path from "node:path"

type JsonObject = Record<string, unknown>

type DevtoolsTarget = {
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

type ScreenshotResult = {
  data?: string
}

type Readiness = {
  ready?: boolean
  fatal?: unknown
  href?: string
  text?: string
  hasSplash?: boolean
  html?: string
}

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const RESULT_DIR = path.join(PACKAGE_DIR, "test-results/desktop-parity")
const screenshotPath = path.resolve(Bun.env.CLAXEDO_DESKTOP_SCREENSHOT_PATH ?? path.join(RESULT_DIR, "default-main-window.png"))
const userDataDir = path.join(RESULT_DIR, "user-data")
const cdpPort = Number(Bun.env.CLAXEDO_DESKTOP_CDP_PORT ?? "9333")
const electronPath = String(createRequire(import.meta.url)("electron"))
const mainPath = path.join(PACKAGE_DIR, "out/main/index.js")
const skipBuild = Bun.argv.includes("--skip-build") || Bun.env.CLAXEDO_DESKTOP_SCREENSHOT_SKIP_BUILD === "1"

await $`mkdir -p ${path.dirname(screenshotPath)} ${userDataDir}`

if (!skipBuild) {
  await $`bun run build:inner`.cwd(PACKAGE_DIR)
}

if (!(await Bun.file(mainPath).exists())) {
  throw new Error(`desktop main bundle is missing at ${mainPath}; run bun run build:inner first`)
}

const app = Bun.spawn([electronPath, `--remote-debugging-port=${String(cdpPort)}`, mainPath], {
  cwd: PACKAGE_DIR,
  env: {
    ...Bun.env,
    CLAXEDO_DESKTOP_USER_DATA_DIR: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  },
  stderr: "pipe",
  stdout: "pipe",
})
const stdout = new Response(app.stdout).text()
const stderr = new Response(app.stderr).text()

let appExited = false
let exitCode: number | null = null
const exited = app.exited.then((code) => {
  appExited = true
  exitCode = code
  return code
})

let failure: unknown

try {
  const target = await waitForTarget()
  const client = await connectCdp(target)

  await client.send("Page.enable")
  await client.send("Runtime.enable")
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const readiness = await waitForReady(client)
  if (readiness.fatal) {
    throw new Error(`desktop renderer reported fatal error: ${JSON.stringify(readiness.fatal)}`)
  }
  await client.send("Page.bringToFront")
  await delay(1_000)

  const screenshot = asObject<ScreenshotResult>(await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  }))
  if (!screenshot.data) throw new Error("Page.captureScreenshot returned no image data")

  await Bun.write(screenshotPath, Buffer.from(screenshot.data, "base64"))
  console.log(`desktop screenshot saved: ${screenshotPath}`)
  console.log(`renderer: ${readiness.href ?? target.url}`)
  if (readiness.text) console.log(`text: ${readiness.text.slice(0, 160).replace(/\s+/g, " ")}`)

  client.close()
} catch (error) {
  failure = error
  throw error
} finally {
  app.kill()
  await Promise.race([exited, delay(2_000)])
  if (!appExited) app.kill(9)
  if (failure) {
    const [out, err] = await Promise.all([stdout, stderr])
    if (out.trim()) console.error(`\nElectron stdout:\n${out.trim()}`)
    if (err.trim()) console.error(`\nElectron stderr:\n${err.trim()}`)
  }
}

async function waitForTarget() {
  for (let i = 0; i < 120; i++) {
    if (appExited) throw new Error(`Electron exited before exposing DevTools; exit code ${String(exitCode)}`)
    const targets = await fetchTargets().catch(() => [])
    const target = targets.find((item) =>
      item.type === "page" &&
      item.webSocketDebuggerUrl &&
      item.url.includes("index.local.html"),
    )
    if (target?.webSocketDebuggerUrl) return target
    await delay(250)
  }
  throw new Error(`Timed out waiting for Electron DevTools target on port ${String(cdpPort)}`)
}

async function fetchTargets() {
  const response = await fetch(`http://127.0.0.1:${String(cdpPort)}/json/list`)
  if (!response.ok) throw new Error(`DevTools target list failed with ${String(response.status)}`)
  const json = (await response.json()) as unknown
  return Array.isArray(json) ? json.filter(isTarget) : []
}

async function connectCdp(target: DevtoolsTarget) {
  if (!target.webSocketDebuggerUrl) throw new Error("DevTools target is missing webSocketDebuggerUrl")
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>()
  let id = 0

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("DevTools websocket failed to open")), { once: true })
  })

  socket.addEventListener("message", (event) => {
    const payload = parseJsonObject(String(event.data))
    const responseId = typeof payload.id === "number" ? payload.id : null
    if (responseId === null) return
    const waiter = pending.get(responseId)
    if (!waiter) return
    pending.delete(responseId)
    if (payload.error) {
      waiter.reject(new Error(JSON.stringify(payload.error)))
      return
    }
    waiter.resolve(payload.result)
  })

  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("DevTools websocket closed"))
    }
    pending.clear()
  })

  return {
    close: () => socket.close(),
    send(method: string, params?: JsonObject) {
      const nextId = ++id
      socket.send(JSON.stringify({ id: nextId, method, params: params ?? {} }))
      return new Promise<unknown>((resolve, reject) => {
        pending.set(nextId, { resolve, reject })
        setTimeout(() => {
          if (!pending.has(nextId)) return
          pending.delete(nextId)
          reject(new Error(`DevTools command timed out: ${method}`))
        }, 30_000)
      })
    },
  }
}

async function waitForReady(client: Awaited<ReturnType<typeof connectCdp>>) {
  for (let i = 0; i < 160; i++) {
    const readiness = await evaluateReadiness(client)
    if (readiness.fatal || readiness.ready) return readiness
    await delay(250)
  }
  const readiness = await evaluateReadiness(client)
  throw new Error(`Timed out waiting for desktop shell render: ${JSON.stringify(readiness)}`)
}

async function evaluateReadiness(client: Awaited<ReturnType<typeof connectCdp>>) {
  const result = asObject(await client.send("Runtime.evaluate", {
    expression: `(() => {
      const fatal = window.__OPENCODE__ && window.__OPENCODE__.lastError
      const root = document.getElementById("root")
      const text = document.body ? document.body.innerText.trim() : ""
      const html = document.body ? document.body.innerHTML.slice(0, 400) : ""
      const hasSplash = Boolean(root && root.querySelector(".animate-pulse"))
      const hasContent = Boolean(root && root.children.length > 0)
      return {
        ready: hasContent && !hasSplash && document.readyState === "complete" && text.length > 0,
        fatal,
        href: window.location.href,
        text,
        hasSplash,
        html,
      }
    })()`,
    returnByValue: true,
  }))
  return asObject<Readiness>(asObject(asObject(result).result).value)
}

function isTarget(input: unknown): input is DevtoolsTarget {
  if (!input || typeof input !== "object") return false
  const item = input as JsonObject
  return typeof item.type === "string" && typeof item.url === "string"
}

function parseJsonObject(input: string) {
  const parsed = JSON.parse(input) as unknown
  return asObject(parsed)
}

function asObject<T extends JsonObject = JsonObject>(input: unknown) {
  if (!input || typeof input !== "object") return {} as T
  return input as T
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
