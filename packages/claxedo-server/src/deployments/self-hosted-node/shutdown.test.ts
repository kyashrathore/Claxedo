import { afterEach, expect, test } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { once } from "node:events"
import { tmpdir } from "node:os"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dirname, "../../..")
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function freePort() {
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const address = probe.address()
  probe.close()
  if (!address || typeof address === "string") throw new Error("no port allocated")
  return address.port
}

async function waitForHealth(origin: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode} before it was healthy:\n${output()}`)
    const healthy = await fetch(`${origin}/api/claxedo/health`).then((response) => response.ok, () => false)
    if (healthy) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`server never became healthy:\n${output()}`)
}

test("SIGTERM ends open SSE and WebSocket event streams and the process exits", async () => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  // `startOwnedControlPlaneStack` writes agent hooks into HOME.
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), "claxedo-server-shutdown-"))
  cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

  const child = spawn(process.execPath, [
    "--conditions=development",
    "--import", "../workspace-runtime/src/text-imports.mjs",
    "--import", "tsx",
    "src/deployments/self-hosted-node/index.ts",
  ], {
    cwd: packageRoot,
    env: { ...process.env, HOME: home, CLAXEDO_SERVER_PORT: String(port), POSTHOG_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  const exited = once(child, "exit")

  await waitForHealth(origin, child, () => output)

  const sse = await fetch(`${origin}/api/cp/events`)
  expect(sse.status).toBe(200)
  expect(sse.headers.get("content-type")).toContain("text/event-stream")
  const sseBody = sse.body!.getReader()
  cleanups.push(() => { void sseBody.cancel().catch(() => {}) })

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/cp/events`)
  cleanups.push(() => socket.close())
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error(`event WebSocket failed to open:\n${output}`)), { once: true })
  })
  const socketClosed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))

  const signalledAt = Date.now()
  child.kill("SIGTERM")
  const outcome = await Promise.race([
    exited.then(([code, signal]) => ({ code, signal })),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 8_000)),
  ])

  expect(outcome, `server still running 8s after SIGTERM:\n${output}`).toEqual({ code: 0, signal: null })
  console.log(`[shutdown.test] exited ${Date.now() - signalledAt}ms after SIGTERM`)
  await socketClosed
  const drained = async (): Promise<void> => {
    const next = await sseBody.read()
    if (!next.done) return drained()
  }
  await expect(drained()).rejects.toThrow()
}, 90_000)
