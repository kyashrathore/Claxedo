import { expect, test } from "bun:test"
import { fork, type ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

import { claxedoServerForkOptions } from "../src/main/server-child-process"

// Boot-level coverage for the desktop server composition. Unit tests run from
// packages that carry their own node_modules/opencode link, so they can never
// see the bundled server's module-resolution reality: the bundle externalizes
// `opencode/node-embed` and loads the engine from the explicit artifact path
// the desktop main hands over (CLAXEDO_CHILD_OPENCODE_EMBED_PATH). These tests
// exercise that path with the real bundle, the real artifact, and a hermetic
// data dir.

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const SERVER_BUNDLE = path.join(PACKAGE_DIR, "resources/claxedo-server/index.js")
const ENGINE_ARTIFACT = path.resolve(PACKAGE_DIR, "../opencode/dist/node/node.js")

const require = createRequire(import.meta.url)

test("embedded OpenCode engine artifact exists at the desktop-resolved path", () => {
  // The desktop main points CLAXEDO_CHILD_OPENCODE_EMBED_PATH at this exact
  // location in dev. If the artifact moves or the dist layout changes, the
  // embedded engine silently dies in the app — fail here instead. CI's unit
  // job runs without predev, so an entirely absent dist is a skip (same
  // convention as the boot test below); a PRESENT dist with the wrong layout
  // still fails.
  if (!fs.existsSync(path.resolve(PACKAGE_DIR, "../opencode/dist"))) {
    console.warn("[skip] opencode dist missing — run `bun run predev` first")
    return
  }
  expect(fs.existsSync(ENGINE_ARTIFACT)).toBe(true)
})

test("bundled claxedo-server boots the embedded engine and serves engine-backed routes", async () => {
  if (!fs.existsSync(SERVER_BUNDLE)) {
    console.warn("[skip] claxedo-server bundle missing — run `bun run predev` first")
    return
  }
  if (!fs.existsSync(ENGINE_ARTIFACT)) {
    console.warn("[skip] embedded engine artifact missing — run `bun run predev` first")
    return
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-boot-test-"))
  const port = await freePort()
  const launchId = "server-boot-test"
  const generation = "server-boot-generation"
  const child = fork(SERVER_BUNDLE, [], {
    ...claxedoServerForkOptions({
      ...Object.fromEntries(
        Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      // Hermetic HOME: no user config, credentials, or caches leak in.
      HOME: root,
      CLAXEDO_CHILD_PORT: String(port),
      CLAXEDO_DESKTOP_PARENT_PID: String(process.pid),
      // First launch hands the server a profile path that does not exist yet.
      CLAXEDO_DATA_DIR: path.join(root, "data"),
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: ENGINE_ARTIFACT,
      CLAXEDO_DIAGNOSTICS_LAUNCH_ID: launchId,
      CLAXEDO_DIAGNOSTICS_GENERATION: generation,
    }),
    execPath: require("electron"),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  let stderr = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const messages: unknown[] = []
  child.on("message", (message) => messages.push(message))

  try {
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child, () => stderr)
    expect(child.connected).toBe(true)

    // Mirror the app's open-workspace flow: registering the workspace first is
    // what makes engine-backed session routes answer for that directory.
    const directory = encodeURIComponent(PACKAGE_DIR)
    const project = await fetch(`${base}/project/current?directory=${directory}`)
    expect(project.status).toBe(200)

    // /session is engine-backed with no network dependency (pure DB read), so
    // it is the offline-safe discriminator: a dead embedded engine surfaces a
    // 500 here while claxedo-local routes keep answering 200.
    const sessions = await fetch(`${base}/session?directory=${directory}&roots=true`)
    expect(sessions.status).toBe(200)
    expect(await sessions.json()).toBeArray()

    expect((await fetch(`${base}/global/config`)).status).toBe(200)
    expect((await fetch(`${base}/provider?view=index`)).status).toBe(200)

    const createPty = await fetch(`${base}/api/wr/pty?directory=${directory}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "ipc-smoke", initialCommand: "printf ipc-smoke" }),
    })
    expect(createPty.status).toBe(200)
    const pty = await createPty.json() as { id: string }
    const registered = await waitForMessage(messages, (message) => {
      if (!message || typeof message !== "object" || !("type" in message)) return false
      return message.type === "owner-registered"
    }) as {
      binding: { pid: number; launchId: string; generation: string }
      descriptor: { ownerOperationId: string; ownerGeneration: string; pid?: number }
    }
    expect(registered.binding).toEqual({ pid: child.pid!, launchId, generation })

    child.send({
      type: "owner-operation-request",
      binding: registered.binding,
      requestId: "boot-test-stale-operation",
      ownerOperationId: registered.descriptor.ownerOperationId,
      ownerGeneration: "stale-generation",
      operation: "stop",
      identity: { pid: registered.descriptor.pid ?? child.pid!, creation: "not-needed-for-stale-generation" },
    })
    expect(await waitForMessage(messages, (message) => {
      if (!message || typeof message !== "object") return false
      return "type" in message && message.type === "owner-operation-result" &&
        "requestId" in message && message.requestId === "boot-test-stale-operation"
    })).toMatchObject({ result: "owner-unavailable" })

    expect((await fetch(`${base}/api/wr/pty/${encodeURIComponent(pty.id)}?directory=${directory}`, {
      method: "DELETE",
    })).status).toBe(200)
  } finally {
    child.kill()
    expect(await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true)
  }
}, 90_000)

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!port) throw new Error("could not allocate a free port")
  return port
}

async function waitForHealth(base: string, child: ChildProcess, stderr: () => string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`claxedo-server exited before becoming healthy:\n${stderr().slice(-2000)}`)
    }
    await Bun.sleep(250)
    const res = await fetch(`${base}/api/claxedo/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined)
    if (res?.ok) return
  }
  throw new Error("claxedo-server did not become healthy in time")
}

async function waitForMessage(messages: unknown[], match: (message: unknown) => boolean) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const message = messages.find(match)
    if (message) return message
    await Bun.sleep(25)
  }
  throw new Error("claxedo-server IPC message did not arrive in time")
}
