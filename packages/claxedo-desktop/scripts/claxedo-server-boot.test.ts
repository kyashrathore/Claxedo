import { expect, test } from "bun:test"
import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

import { claxedoServerForkOptions } from "../src/main/server-child-process"
import { localServerBundleEntry, requireLocalServerBundle } from "./local-server"

// Boot-level coverage for the desktop server composition. Unit tests run from
// packages that carry their own node_modules/opencode link, so they can never
// see the bundled server's module-resolution reality: the bundle externalizes
// `opencode/node-embed` and loads the engine from the explicit artifact path
// the desktop main hands over (CLAXEDO_CHILD_OPENCODE_EMBED_PATH). These tests
// exercise that path with the real bundle, the real artifact, and a hermetic
// data dir.

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
// The same resolver `prebuild`, `predev`, and `build` use, so the smoke test
// cannot pass against a different artifact than the one that ships.
const SERVER_BUNDLE = localServerBundleEntry(PACKAGE_DIR)
const ENGINE_ARTIFACT = path.resolve(PACKAGE_DIR, "../opencode/dist/node/node.js")

const require = createRequire(import.meta.url)

test("a missing local-server bundle stops the boot, naming the artifact", async () => {
  // The error path the plan requires, exercised at the real boot boundary
  // rather than asserted about. CI's unit job has no bundle, so this is the
  // only server-boot coverage that always runs — and the case it covers is the
  // one that matters: nothing else may start in the bundle's place.
  const missing = path.join(PACKAGE_DIR, "resources/claxedo-server/does-not-exist.js")
  expect(fs.existsSync(missing)).toBe(false)

  const port = await freePort()
  const child = Bun.spawn({
    cmd: [process.execPath, require.resolve("electron/cli.js"), missing],
    env: {
      ...Bun.env,
      ELECTRON_RUN_AS_NODE: "1",
      CLAXEDO_CHILD_PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const code = await child.exited
  expect(code).not.toBe(0)
  expect(await new Response(child.stderr).text()).toContain(missing)

  // And no server took its place on the port it would have claimed.
  const answered = await fetch(`http://127.0.0.1:${port}/api/claxedo/health`, {
    signal: AbortSignal.timeout(1_000),
  })
    .then(() => true)
    .catch(() => false)
  expect(answered).toBe(false)
}, 30_000)

test("requireLocalServerBundle names the artifact and the command that builds it", () => {
  // The preparation-time half of the same rule: `build.ts` calls this before
  // electron-vite, because the vite plugin that copies the bundle into
  // out/main/ skips silently when it is absent.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-no-bundle-"))
  try {
    expect(() => requireLocalServerBundle(empty)).toThrow(
      new RegExp(`${path.join("resources", "claxedo-server", "index.js").replace(/\\/g, "\\\\")}`),
    )
    expect(() => requireLocalServerBundle(empty)).toThrow(/prebuild/)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

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
  const workspaceDirectory = path.join(root, "workspace")
  fs.mkdirSync(workspaceDirectory)
  // Workspace registration intentionally accepts only real Git workspaces.
  // Build agents copy source without checkout metadata, so depending on this
  // package's parent `.git` made the real runtime assertion platform-specific:
  // `/project/current` returned its display fallback, then `/session` correctly
  // fell through because no workspace had been registered. Own the fixture and
  // exercise the same authoritative registration path on every machine.
  execFileSync("git", ["init", workspaceDirectory], { stdio: "ignore" })
  const port = await freePort()
  const launchId = "server-boot-test"
  const generation = "server-boot-generation"
  const daemonToken = "server-boot-daemon-token"
  const daemonDiscoveryPath = path.join(root, "data", "local-daemon.json")
  const child = fork(SERVER_BUNDLE, [], {
    ...claxedoServerForkOptions({
      ...Object.fromEntries(
        Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      // Hermetic HOME: no user config, credentials, or caches leak in.
      HOME: root,
      CLAXEDO_CHILD_PORT: String(port),
      CLAXEDO_DAEMON_PROTOCOL: "1",
      CLAXEDO_DAEMON_TOKEN: daemonToken,
      CLAXEDO_DAEMON_GENERATION: generation,
      CLAXEDO_DAEMON_DISCOVERY_PATH: daemonDiscoveryPath,
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
    expect(JSON.parse(fs.readFileSync(daemonDiscoveryPath, "utf8"))).toMatchObject({
      service: "claxedo-local-daemon",
      protocol: 1,
      generation,
      token: daemonToken,
      pid: child.pid,
      port,
    })
    const daemonIdentity = await fetch(`${base}/api/claxedo/daemon`, {
      headers: { authorization: `Bearer ${daemonToken}` },
    })
    expect(daemonIdentity.status).toBe(200)
    expect(await daemonIdentity.json()).toEqual({
      service: "claxedo-local-daemon",
      protocol: 1,
      generation,
      pid: child.pid,
    })

    // Mirror the app's open-workspace flow: registering the workspace first is
    // what makes engine-backed session routes answer for that directory.
    const directory = encodeURIComponent(workspaceDirectory)
    const project = await fetch(`${base}/project/current?directory=${directory}`)
    expect(project.status).toBe(200)
    expect(await project.json()).toMatchObject({ worktree: fs.realpathSync(workspaceDirectory) })

    // /session is engine-backed with no network dependency (pure DB read), so
    // it is the offline-safe discriminator: a dead embedded engine surfaces a
    // 500 here while claxedo-local routes keep answering 200.
    const sessions = await fetch(`${base}/session?directory=${directory}&roots=true`)
    const sessionsBody = await sessions.text()
    if (sessions.status !== 200) {
      throw new Error(`engine-backed /session returned ${sessions.status}: ${sessionsBody}`)
    }
    expect(JSON.parse(sessionsBody)).toBeArray()

    expect((await fetch(`${base}/global/config`)).status).toBe(200)
    expect((await fetch(`${base}/provider?view=index`)).status).toBe(200)

    const createPty = await fetch(`${base}/api/wr/pty?directory=${directory}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "daemon-survival", initialCommand: "printf 'daemon-before-restart\\n'" }),
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

    // Electron releases its IPC ownership immediately after startup and may
    // then exit for an app restart or update. The daemon must retain the exact
    // PTY and accept a fresh transport connection from the replacement app.
    child.disconnect()
    child.unref()
    expect(child.connected).toBe(false)
    await Bun.sleep(250)
    expect((await fetch(`${base}/api/claxedo/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/wr/pty/${encodeURIComponent(pty.id)}?directory=${directory}`)).status).toBe(200)

    const socket = openPtySocket(
      `ws://127.0.0.1:${port}/api/wr/pty/${encodeURIComponent(pty.id)}/connect?directory=${directory}`,
    )
    await socket.opened
    expect(await socket.waitForText("daemon-before-restart")).toContain("daemon-before-restart")
    socket.ws.send("printf 'daemon-after-restart\\n'\r")
    expect(await socket.waitForText("daemon-after-restart")).toContain("daemon-after-restart")
    socket.ws.close()
    await Bun.sleep(100)
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`claxedo-server exited after replacement client disconnected:\n${stderr.slice(-4000)}`)
    }

    const removePty = await fetch(`${base}/api/wr/pty/${encodeURIComponent(pty.id)}?directory=${directory}`, {
      method: "DELETE",
    }).catch((error) => {
      throw new Error(`claxedo-server stopped answering after reconnect: ${String(error)}\n${stderr.slice(-4000)}`)
    })
    expect(removePty.status).toBe(200)
  } finally {
    child.kill()
    expect(await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true)
  }
}, 90_000)

test("a quiescent daemon exits after its bounded idle grace", async () => {
  if (!fs.existsSync(SERVER_BUNDLE) || !fs.existsSync(ENGINE_ARTIFACT)) {
    console.warn("[skip] server artifacts missing — run `bun run predev` first")
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-idle-daemon-test-"))
  const port = await freePort()
  const discoveryPath = path.join(root, "data", "local-daemon.json")
  const child = fork(SERVER_BUNDLE, [], {
    ...claxedoServerForkOptions({
      ...Object.fromEntries(
        Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      HOME: root,
      CLAXEDO_CHILD_PORT: String(port),
      CLAXEDO_DAEMON_PROTOCOL: "1",
      CLAXEDO_DAEMON_TOKEN: "idle-daemon-token",
      CLAXEDO_DAEMON_GENERATION: "idle-daemon-generation",
      CLAXEDO_DAEMON_DISCOVERY_PATH: discoveryPath,
      CLAXEDO_DAEMON_IDLE_GRACE_MS: "75",
      CLAXEDO_DAEMON_POLL_INTERVAL_MS: "5",
      CLAXEDO_DATA_DIR: path.join(root, "data"),
      CLAXEDO_CHILD_OPENCODE_EMBED_PATH: ENGINE_ARTIFACT,
    }),
    execPath: require("electron"),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  const messages: unknown[] = []
  child.on("message", (message) => messages.push(message))
  let stderr = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  try {
    await waitForMessage(messages, (message) =>
      !!message && typeof message === "object" && "type" in message && message.type === "claxedo-server-ready")
    expect(fs.existsSync(discoveryPath)).toBe(true)
    expect(await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true)
    expect(child.exitCode).toBe(0)
    expect(fs.existsSync(discoveryPath)).toBe(false)
  } catch (error) {
    throw new Error(`${String(error)}\n${stderr.slice(-4000)}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

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

function openPtySocket(url: string) {
  const ws = new WebSocket(url)
  let text = ""
  const opened = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PTY WebSocket did not open in time")), 5_000)
    ws.addEventListener("open", () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("PTY WebSocket failed to open"))
    }, { once: true })
  })
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") text += event.data
  })
  return {
    ws,
    opened,
    async waitForText(expected: string) {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (text.includes(expected)) return text
        await Bun.sleep(25)
      }
      throw new Error(`PTY WebSocket did not receive ${expected}; output=${JSON.stringify(text)}`)
    },
  }
}
