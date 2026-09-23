import { expect, test } from "bun:test"
import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

import { claxedoServerForkOptions } from "../src/main/server-child-process"
import { CLAXEDO_DAEMON_CAPABILITY_HEADER, createDaemonFetch } from "../src/main/daemon-request"
import { CLAXEDO_DAEMON_PROTOCOL } from "../src/main/server-daemon-discovery"
import { resolveDeferredServerEntry } from "./bundle-claxedo-server"
import { localServerBundleEntry, requireLocalServerBundle } from "./local-server"

// Boot-level coverage for the desktop server composition using the real bundle
// and a hermetic data directory.

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const SERVER_BUNDLE = localServerBundleEntry(PACKAGE_DIR)

const require = createRequire(import.meta.url)
const electronExecutable = () => process.env.CLAXEDO_TEST_ELECTRON_EXECUTABLE || require("electron")

test("a missing local-server bundle stops the boot, naming the artifact", async () => {
  // The error path the plan requires, exercised at the real boot boundary
  // rather than asserted about. CI's unit job has no bundle, so this is the
  // only server-boot coverage that always runs — and the case it covers is the
  // one that matters: nothing else may start in the bundle's place.
  const missing = path.join(PACKAGE_DIR, "resources/claxedo-server/does-not-exist.js")
  expect(fs.existsSync(missing)).toBe(false)

  const port = await freePort()
  const child = Bun.spawn({
    cmd: [electronExecutable(), missing],
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
      new RegExp(path.join("resources", "claxedo-server", "index.js").replace(/\\/g, "\\\\")),
    )
    expect(() => requireLocalServerBundle(empty)).toThrow(/prebuild/)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test("the deferred server chunk refuses an empty startup environment before opening a database", async () => {
  // The compile-cache build evaluates this chunk with the startup variables
  // absent and treats the refusal as proof that nothing ran. That proof is
  // only as good as the ORDER inside the chunk: a composition created before
  // `claxedoServerStartup` opens `claxedo.db` in whatever data directory the
  // developer's shell names and applies migrations to it during `predev`.
  if (!fs.existsSync(SERVER_BUNDLE)) {
    console.warn("[skip] claxedo-server bundle missing — run `bun run predev` first")
    return
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-refusal-test-"))
  const dataDir = path.join(root, "data")
  fs.mkdirSync(dataDir)
  const stub = path.join(root, "evaluate.mjs")
  fs.writeFileSync(
    stub,
    `import { pathToFileURL } from "node:url"
try {
  await import(pathToFileURL(process.argv[2]).href)
  console.log("EVALUATED")
} catch (error) {
  console.log("REFUSED " + (error instanceof Error ? error.message : String(error)))
}
process.exit(0)
`,
  )
  const env = Object.fromEntries(
    Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  for (const key of [
    "CLAXEDO_CHILD_PORT",
    "CLAXEDO_DAEMON_PROTOCOL",
    "CLAXEDO_DAEMON_TOKEN",
    "CLAXEDO_DAEMON_GENERATION",
    "CLAXEDO_DAEMON_DISCOVERY_PATH",
  ]) {
    delete env[key]
  }
  try {
    const child = Bun.spawn({
      cmd: [electronExecutable(), stub, resolveDeferredServerEntry(SERVER_BUNDLE)],
      env: { ...env, HOME: root, CLAXEDO_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stdout).toContain("REFUSED Claxedo server utility process is missing its startup configuration")
    expect(stderr).not.toContain("opening claxedo database")
    expect(fs.readdirSync(dataDir)).toEqual([])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("bundled claxedo-server boots and serves Claxedo-owned routes", async () => {
  if (!fs.existsSync(SERVER_BUNDLE)) {
    console.warn("[skip] claxedo-server bundle missing — run `bun run predev` first")
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
  const serverLog = fs.openSync(path.join(root, "server.log"), "a")
  const child = fork(SERVER_BUNDLE, [], {
    ...claxedoServerForkOptions({
      ...Object.fromEntries(
        Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      // Hermetic HOME: no user config, credentials, or caches leak in.
      HOME: root,
      CLAXEDO_CHILD_PORT: String(port),
      CLAXEDO_DAEMON_PROTOCOL: String(CLAXEDO_DAEMON_PROTOCOL),
      CLAXEDO_DAEMON_TOKEN: daemonToken,
      CLAXEDO_DAEMON_GENERATION: generation,
      CLAXEDO_DAEMON_DISCOVERY_PATH: daemonDiscoveryPath,
      // First launch hands the server a profile path that does not exist yet.
      CLAXEDO_DATA_DIR: path.join(root, "data"),
      CLAXEDO_DIAGNOSTICS_LAUNCH_ID: launchId,
      CLAXEDO_DIAGNOSTICS_GENERATION: generation,
    }, serverLog),
    execPath: electronExecutable(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  fs.closeSync(serverLog)
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  let stderr = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const messages: unknown[] = []
  child.on("message", (message) => messages.push(message))
  let socket: ReturnType<typeof openPtySocket> | undefined
  let failure: unknown

  try {
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child, () => stderr)
    expect(child.connected).toBe(true)
    expect(JSON.parse(fs.readFileSync(daemonDiscoveryPath, "utf8"))).toMatchObject({
      service: "claxedo-local-daemon",
      protocol: CLAXEDO_DAEMON_PROTOCOL,
      generation,
      token: daemonToken,
      pid: child.pid,
      port,
    })
    // Every privileged call below goes through the canonical presenter Electron
    // main uses, because the daemon admits its application and nothing else —
    // a boot smoke that reached these routes bare would be proving a boundary
    // the product does not have.
    const daemon = createDaemonFetch({ endpoint: () => ({ origin: base, capability: daemonToken }) })
    const daemonIdentity = await daemon("/api/claxedo/daemon", {
      headers: { authorization: `Bearer ${daemonToken}` },
    })
    expect(daemonIdentity.status).toBe(200)
    // Exact, not a subset: this route is the pre-signal read, and a field it
    // grows without a decision here is a field a launcher would act on. The
    // creation identity is what makes the read verifiable — a launcher that
    // retires this daemon compares it against the one it recorded.
    expect(await daemonIdentity.json()).toEqual({
      service: "claxedo-local-daemon",
      protocol: CLAXEDO_DAEMON_PROTOCOL,
      generation,
      pid: child.pid,
      identity: {
        pid: child.pid,
        processGroupId: expect.any(Number),
        parentPid: expect.any(Number),
        startedAtMs: expect.any(Number),
        startSecond: expect.any(String),
        bootTime: expect.any(String),
        source: expect.any(String),
      },
    })

    // The other half of the same claim, against the real bundled daemon: a page
    // a browser on this machine happens to be showing is on loopback too, and
    // reaches none of this. Health stays public so a supervisor can still tell
    // the port is live.
    const hostile = (path: string) =>
      fetch(`${base}${path}`, { headers: { origin: "http://localhost:4173" } })
    expect((await hostile("/project/current")).status).toBe(401)
    expect((await hostile("/api/claxedo/credentials")).status).toBe(401)
    expect((await hostile(`/api/claxedo/daemon`)).status).toBe(401)
    expect((await hostile("/api/claxedo/health")).status).toBe(200)

    // Mirror the app's open-workspace flow: register the workspace first. The
    // routes below resolve a workspace for the directory and never create one,
    // so an unregistered directory answers 404 rather than a project.
    const directory = encodeURIComponent(workspaceDirectory)
    const registeredWorkspace = await daemon(`/api/claxedo/workspace/resolve?directory=${directory}`, { method: "POST" })
    expect(registeredWorkspace.status).toBe(200)
    const project = await daemon(`/project/current?directory=${directory}`)
    expect(project.status).toBe(200)
    expect(await project.json()).toMatchObject({ worktree: fs.realpathSync(workspaceDirectory) })

    const sessions = await daemon(`/session?directory=${directory}&roots=true`)
    const sessionsBody = await sessions.text()
    if (sessions.status !== 200) {
      throw new Error(`Claxedo /session returned ${sessions.status}: ${sessionsBody}`)
    }
    expect(JSON.parse(sessionsBody)).toBeArray()

    const createPty = await daemon(`/api/wr/pty?directory=${directory}`, {
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
    expect((await daemon(`/api/wr/pty/${encodeURIComponent(pty.id)}?directory=${directory}`)).status).toBe(200)

    socket = openPtySocket(
      `ws://127.0.0.1:${port}/api/wr/pty/${encodeURIComponent(pty.id)}/connect?directory=${directory}`,
      daemonToken,
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

    const removePty = await daemon(`/api/wr/pty/${encodeURIComponent(pty.id)}?directory=${directory}`, {
      method: "DELETE",
    }).catch((error) => {
      throw new Error(`claxedo-server stopped answering after reconnect: ${String(error)}\n${stderr.slice(-4000)}`)
    })
    expect(removePty.status).toBe(200)
  } catch (error) {
    failure = error
    throw error
  } finally {
    // A socket the test left open on a live PTY would hold the server's
    // listener past SIGTERM, and a teardown assertion thrown from here would
    // replace the error that left it open.
    socket?.ws.close()
    child.kill()
    const exitedInTime = await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)])
    if (failure === undefined) expect(exitedInTime).toBe(true)
  }
}, 90_000)

test("a quiescent daemon exits after its bounded idle grace", async () => {
  if (!fs.existsSync(SERVER_BUNDLE)) {
    console.warn("[skip] server bundle missing — run `bun run predev` first")
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-idle-daemon-test-"))
  const port = await freePort()
  const discoveryPath = path.join(root, "data", "local-daemon.json")
  const serverLog = fs.openSync(path.join(root, "server.log"), "a")
  const child = fork(SERVER_BUNDLE, [], {
    ...claxedoServerForkOptions({
      ...Object.fromEntries(
        Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      HOME: root,
      CLAXEDO_CHILD_PORT: String(port),
      CLAXEDO_DAEMON_PROTOCOL: String(CLAXEDO_DAEMON_PROTOCOL),
      CLAXEDO_DAEMON_TOKEN: "idle-daemon-token",
      CLAXEDO_DAEMON_GENERATION: "idle-daemon-generation",
      CLAXEDO_DAEMON_DISCOVERY_PATH: discoveryPath,
      CLAXEDO_DAEMON_IDLE_GRACE_MS: "75",
      CLAXEDO_DAEMON_POLL_INTERVAL_MS: "5",
      CLAXEDO_DATA_DIR: path.join(root, "data"),
    }, serverLog),
    execPath: electronExecutable(),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  fs.closeSync(serverLog)
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
    expect(stderr).toMatch(new RegExp(`daemon stopping service=daemon kind=idle idleMs=\\d+ pid=${child.pid}`))
    expect(stderr).toContain(`daemon exit requested service=daemon trigger=lifecycle pid=${child.pid}`)
    expect(stderr).toContain(`daemon exited service=daemon code=0 pid=${child.pid}`)
  } catch (error) {
    throw new Error(`${String(error)}\n${stderr.slice(-4000)}`, { cause: error })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("a terminal whose daemon was killed is reported gone and restored from history by the replacement", async () => {
  if (!fs.existsSync(SERVER_BUNDLE)) {
    console.warn("[skip] server bundle missing — run `bun run predev` first")
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-pty-gone-test-"))
  const workspaceDirectory = path.join(root, "workspace")
  fs.mkdirSync(workspaceDirectory)
  execFileSync("git", ["init", workspaceDirectory], { stdio: "ignore" })
  const directory = encodeURIComponent(workspaceDirectory)
  const daemonToken = "pty-gone-daemon-token"
  let log = ""
  const started: ChildProcess[] = []
  const sockets: Array<ReturnType<typeof openPtySocket>> = []

  const startDaemon = async (generation: string) => {
    const port = await freePort()
    const serverLog = fs.openSync(path.join(root, "server.log"), "a")
    const child = fork(SERVER_BUNDLE, [], {
      ...claxedoServerForkOptions({
        ...Object.fromEntries(
          Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        HOME: root,
        CLAXEDO_CHILD_PORT: String(port),
        CLAXEDO_DAEMON_PROTOCOL: String(CLAXEDO_DAEMON_PROTOCOL),
        CLAXEDO_DAEMON_TOKEN: daemonToken,
        CLAXEDO_DAEMON_GENERATION: generation,
        CLAXEDO_DAEMON_DISCOVERY_PATH: path.join(root, "data", "local-daemon.json"),
        CLAXEDO_DATA_DIR: path.join(root, "data"),
      }, serverLog),
      execPath: electronExecutable(),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    fs.closeSync(serverLog)
    started.push(child)
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk) => { log += String(chunk) })
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child, () => log)
    const daemon = createDaemonFetch({ endpoint: () => ({ origin: base, capability: daemonToken }) })
    expect((await daemon(`/api/claxedo/workspace/resolve?directory=${directory}`, { method: "POST" })).status).toBe(200)
    const attach = (ptyId: string) => {
      const socket = openPtySocket(
        `ws://127.0.0.1:${port}/api/wr/pty/${encodeURIComponent(ptyId)}/connect?directory=${directory}`,
        daemonToken,
      )
      sockets.push(socket)
      return socket
    }
    const createPty = async (body: Record<string, unknown>) => {
      const res = await daemon(`/api/wr/pty?directory=${directory}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      return (await res.json() as { id: string }).id
    }
    return { child, daemon, attach, createPty }
  }

  try {
    const first = await startDaemon("pty-gone-first")
    const lostId = await first.createPty({ title: "lost", initialCommand: "printf 'written-before-the-daemon-died\\n'" })
    const before = first.attach(lostId)
    await before.opened
    await before.waitForText("written-before-the-daemon-died")
    before.ws.close()
    first.child.kill("SIGKILL")
    await new Promise((resolve) => first.child.once("exit", resolve))

    const second = await startDaemon("pty-gone-second")
    // The lookup the terminal asks before retrying: the PTY route's own
    // not-found code, carried through the local proxy unchanged.
    const lookup = await second.daemon(`/api/wr/pty/${encodeURIComponent(lostId)}?directory=${directory}`)
    expect(lookup.status).toBe(404)
    expect(await lookup.json()).toEqual({ error: { code: "pty_session_not_found", message: "Session not found" } })
    await expect(second.attach(lostId).opened).rejects.toThrow("PTY WebSocket failed to open")

    const restoredId = await second.createPty({ title: "lost", env: { previousPtyId: lostId } })
    expect(restoredId).not.toBe(lostId)
    const restored = second.attach(restoredId)
    await restored.opened
    expect(await restored.waitForText("Session contents restored")).toContain("written-before-the-daemon-died")
    restored.ws.close()

    second.child.kill("SIGTERM")
    await new Promise((resolve) => second.child.once("exit", resolve))

    expect(log).toContain(`pid=${first.child.pid}`)
    expect(log).not.toContain(`daemon exited service=daemon code=0 pid=${first.child.pid}`)
    expect(log).toContain(`terminal lookup: no such PTY in this process service=pty-route ptyId=${lostId}`)
    expect(log).toContain(`terminal attach refused service=embedded-workspace-runtime ptyId=${lostId}`)
    expect(log).toMatch(new RegExp(`creating session service=pty id=${restoredId} .*restoring=${lostId}`))
    expect(log).toMatch(new RegExp(`pty history restored service=pty id=${restoredId} previousPtyId=${lostId} restoredChars=[1-9]`))
    expect(log).toContain(`daemon exit requested service=daemon trigger=SIGTERM pid=${second.child.pid}`)
    expect(log).toContain(`daemon exited service=daemon code=0 pid=${second.child.pid}`)
  } catch (error) {
    throw new Error(`${String(error)}\n${log.slice(-6000)}`, { cause: error })
  } finally {
    for (const socket of sockets) socket.ws.close()
    for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

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

function openPtySocket(url: string, capability: string) {
  // The capability rides the HTTP upgrade, which is the only place a socket can
  // carry one — the same delivery Electron main performs for the renderer's
  // terminal. The DOM lib's constructor signature knows only the subprotocol
  // list, while the runtime's WebSocket takes undici's options bag.
  const WithHeaders = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket
  const ws = new WithHeaders(url, { headers: { [CLAXEDO_DAEMON_CAPABILITY_HEADER]: capability } })
  ws.binaryType = "arraybuffer"
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
    if (typeof event.data === "string") {
      text += event.data
      return
    }
    // A fresh attach opens with one control frame, 0x00 + JSON, whose
    // checkpoint carries the screen as it stood before this client connected;
    // output from before the attach is in there, not in a text replay.
    const bytes = new Uint8Array(event.data as ArrayBuffer)
    if (bytes[0] !== 0) return
    const control = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { checkpoint?: { screen?: string } }
    text += control.checkpoint?.screen ?? ""
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
