import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { HostStateStore } from "@claxedo/host-connector/host-state"
import { sealingPublicKeyJwk } from "@claxedo/host-connector/machine-seal"
import { createHostRuntimeListener, type HostRuntimeListener } from "@claxedo/host-serving/runtime"
import { setHostServing, stopHostServing, hostServingState } from "@claxedo/host-serving/serving"
import { connect, type ConnectDeps } from "../commands/connect"
import { processAlive, statusLines } from "../commands/status"
import { desktopDaemonDiscoveryFiles, desktopDaemonState } from "./desktop-daemon"
import { createFakeConnectControlPlane, decodeFakeTunnelToken, type FakeControlPlane } from "./fake-control-plane.test-support"
import { defaultHostDeps } from "./host"
import { createFakeSystemdUserManager, provision, type FakeServiceManager } from "./machine-simulator.test-support"
import { connectPaths, connectStateStore } from "./paths"
import { relayStub, until, type RelayStub } from "./relay-stub.test-support"
import { SYSTEMD_UNIT } from "./service"

/**
 * The EC2 proof, on a machine this process owns: cloud-init writes the
 * invitation and runs `claxedo connect --token-file --root --install-service`
 * as a user with lingering on; a systemd user manager reads the unit the CLI
 * wrote and runs the real `connect` command as a child process; the owner
 * assigns; the box reboots; the owner revokes. The control plane is the
 * strict fake served over HTTP, the relay a stub that admits host tunnels.
 * Time is compressed through the seams the code already has — the child's
 * beat interval and the manager's restart and stop timers — never by
 * sleeping.
 */

/** The child's beat interval; every bound below is a count of beats, and the ms are reported. */
const BEAT_MS = 200
const INSTALLED_AT = 1_700_000_000_000
const CHILD_ENTRY = path.join(import.meta.dir, "machine-simulator-child.test-support.ts")

/**
 * The strict fake behind a real socket: the child process speaks HTTP to it
 * as it would to the control plane. Node's server, not `Bun.serve`: the host
 * runtime listener's `@hono/node-server` replaces the global `Response` with
 * its own class once a listener exists, and `Bun.serve` refuses that class.
 */
async function serveFakeControlPlane(relayUrl: string) {
  let cp: FakeControlPlane | undefined
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()
    const answer = await cp!.fetch(new URL(request.url ?? "/", `http://${request.headers.host}`), {
      method: request.method ?? "GET",
      headers: Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : []))),
      ...(body ? { body } : {}),
    })
    response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()))
    response.end(await answer.text())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fake control plane did not bind a port")
  cp = createFakeConnectControlPlane({ url: `http://127.0.0.1:${address.port}`, relayUrl })
  return {
    cp,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function timing(label: string, values: Record<string, number | string | undefined>) {
  console.log(`[machine-lifecycle timing] ${label}: ${JSON.stringify(values)}`)
}

type Machine = {
  home: string
  claxedoHome: string
  root: string
  tokenFile: string
  unitFile: string
  cp: FakeControlPlane
  relay: RelayStub
  manager: FakeServiceManager
  deps: ConnectDeps
  /** What the installing `connect` printed. */
  lines: string[]
  /** Every wait the manager asked its timer for, in ms; the timer itself fires at once. */
  timerWaitsMs: number[]
  state: () => Promise<Awaited<ReturnType<ConnectDeps["store"]["load"]>>>
  status: () => Promise<string>
  close: () => Promise<void>
}

async function machine(input: { linger: boolean }): Promise<Machine> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-ec2-")))
  const relay = relayStub()
  const served = await serveFakeControlPlane(relay.url)
  // Off the default `$HOME/.claxedo`, so the child finds the state only through the unit's `Environment=`.
  const claxedoHome = path.join(home, "var", "lib", "claxedo")
  const timerWaitsMs: number[] = []
  const manager = createFakeSystemdUserManager({
    home,
    username: "ec2-user",
    linger: input.linger,
    runtimeDir: "/run/user/1000",
    cwd: home,
    environment: { HOME: home, PATH: process.env.PATH ?? "", XDG_RUNTIME_DIR: "/run/user/1000", CLAXEDO_SIM_BEAT_MS: String(BEAT_MS) },
    setTimeout: (fn, ms) => {
      timerWaitsMs.push(ms)
      const handle = setTimeout(fn, 0)
      return { cancel: () => clearTimeout(handle) }
    },
  })
  const lines: string[] = []
  const store = connectStateStore(claxedoHome)
  const deps: ConnectDeps = {
    host: { ...defaultHostDeps(), log: (line) => lines.push(line), sleep: async () => undefined },
    service: () => manager.serviceDeps({ command: [process.execPath, CHILD_ENTRY], claxedoHome, now: () => INSTALLED_AT }),
    store,
    paths: connectPaths(claxedoHome),
    controlPlaneUrl: served.cp.url,
    displayName: "ip-10-0-0-12",
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    desktopDaemon: () => desktopDaemonState({ files: desktopDaemonDiscoveryFiles({}, home) }),
  }
  return {
    home,
    claxedoHome,
    root: path.join(home, "srv"),
    tokenFile: path.join(home, "run", "claxedo", "invite"),
    unitFile: path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT),
    cp: served.cp,
    relay,
    manager,
    deps,
    lines,
    timerWaitsMs,
    state: () => store.load(),
    status: async () =>
      (
        await statusLines({
          load: () => store.load(),
          stateFile: connectPaths(claxedoHome).stateFile,
          resolvePath: (target) => fs.realpath(target),
          pidAlive: processAlive,
          now: () => Date.now(),
          log: () => undefined,
        })
      ).join("\n"),
    close: async () => {
      await manager.dispose()
      await relay.stop()
      await served.stop()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

const enrollmentIdOf = (m: Machine) => [...m.cp.enrollments.keys()][0]

/** The invitation minted on the owner's laptop, then the box's user-data: token file, repo, `claxedo connect … --install-service`. */
async function cloudInit(m: Machine) {
  const invitation = await m.cp.createInvitation({ displayName: "ec2-host", scope: { allowed_roots: [m.root], visibility: "owner" } })
  return await provision({
    tokenFile: m.tokenFile,
    token: invitation.token,
    repos: [path.join(m.root, "api")],
    runcmd: [() => connect(["--token-file", m.tokenFile, "--root", m.root, "--name", "ec2-host", "--install-service"], m.deps)],
  })
}

async function beating(m: Machine, since: number) {
  await until(async () => {
    const run = (await m.state())?.run
    return run !== undefined && run.pid === m.manager.service().pid && (run.last_beat_ok_at ?? 0) >= since
  }, "the unit's process to record a beat")
}

/** Readiness at the control plane, the tunnel at the relay, and the host's own served row, for one workspace. */
async function servedEverywhere(m: Machine, workspaceId: string, generation: number) {
  await until(() => m.cp.routable(enrollmentIdOf(m)).includes(workspaceId), `readiness for ${workspaceId}`)
  await until(() => m.relay.open().some((socket) => socket.workspaceIds.includes(workspaceId)), `a tunnel for ${workspaceId}`)
  const socket = m.relay.open().find((socket) => socket.workspaceIds.includes(workspaceId))!
  expect(decodeFakeTunnelToken(socket.token)).toEqual({ workspace_ids: [workspaceId], enrollment_id: enrollmentIdOf(m), generation })
  await until(async () => (await m.state())?.run?.served?.some((row) => row.workspace_id === workspaceId && row.connected) === true, "the served row to show the tunnel")
  return socket
}

describe("claxedo connect on a simulated machine", () => {
  let m: Machine
  afterEach(async () => {
    await m?.close()
  })

  test("cloud-init installs the unit; the manager runs it; an assignment is served; a reboot resumes unattended; a revoke ends it with 78 and no restart", async () => {
    m = await machine({ linger: true })
    const provisioned = await cloudInit(m)
    expect(provisioned.tokenFileMode).toBe(0o600)
    expect(provisioned.exitCodes).toEqual([0])
    expect(m.manager.calls).toEqual([
      "loginctl show-user ec2-user --property=Linger --value",
      "systemctl --user is-system-running",
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
    ])
    expect(m.lines.some((line) => line.startsWith("Enrolled as "))).toBe(true)
    expect(m.lines.some((line) => line.startsWith(`Installed and started ${SYSTEMD_UNIT}`))).toBe(true)

    // What the box holds after user-data: the enrollment and the service, no invitation, no account credential.
    expect(await fs.readFile(m.tokenFile, "utf8").catch(() => "gone")).toBe("gone")
    expect(await fs.stat(path.join(m.claxedoHome, "credentials.json")).catch(() => "absent")).toBe("absent")
    const installed = await m.state()
    expect(installed?.enrollment?.enrollment_id).toBe(enrollmentIdOf(m))
    expect(installed?.bootstrap).toBeUndefined()
    expect(installed?.service).toEqual({ kind: "systemd-user", unit: m.unitFile, installed_at: INSTALLED_AT })
    const unit = await fs.readFile(m.unitFile, "utf8")
    expect(unit).toContain(`ExecStart="${process.execPath}" "${CHILD_ENTRY}" "connect" "--foreground"`)
    expect(unit).toContain(`Environment=CLAXEDO_HOME="${m.claxedoHome}"`)

    const first = m.manager.service()
    expect(first).toMatchObject({ enabled: true, running: true, state: "active/running", restarts: 0 })
    expect(first.pid).toBe(m.manager.child()!.pid)
    await beating(m, INSTALLED_AT)
    expect(m.cp.log.map((entry) => entry.path).slice(0, 3)).toEqual([
      "/api/claxedo/host/enrollments/redeem",
      "/api/claxedo/host/enrollments/acquire",
      "/api/claxedo/host/enrollments/heartbeat",
    ])
    expect((await m.state())?.run).toMatchObject({ pid: first.pid, generation: 1, served: [] })
    let status = await m.status()
    expect(status).toContain(`enrollment   ${enrollmentIdOf(m)} (via invitation, owner Alice)`)
    expect(status).toContain("status       online")
    expect(status).toContain(`service      systemd-user ${m.unitFile}`)
    expect(status).toContain("Served folders: none")

    const api = path.join(m.root, "api")
    const beatsBefore = m.cp.beats().length
    const assignedAt = Date.now()
    m.cp.assign({ hostId: installed!.host_id, workspaceId: "ws_api", remoteDirectory: api, displayName: "api" })
    const socket = await servedEverywhere(m, "ws_api", 1)
    const servedAt = Date.now()
    const ackBeat = m.cp.beats().findIndex((beat) => JSON.stringify(beat.body.acks).includes("ws_api"))
    const beatsUsed = ackBeat - beatsBefore + 1
    timing("assign → readiness + tunnel", { elapsedMs: servedAt - assignedAt, beatsUsed, beatMs: BEAT_MS })
    expect(beatsUsed, "one beat to learn the assignment, the requested one to ack it").toBeLessThanOrEqual(2)
    expect(m.manager.journal()).toContain(`workspace ws_api: serving ${api} (revision 1)`)
    status = await m.status()
    expect(status).toContain("ws_api  revision 1  connected")

    const requestsBeforeReboot = m.cp.log.length
    const { bootedAt } = await m.manager.reboot()
    await until(() => socket.closed, "the dead process's tunnel to close at the relay")
    const rebooted = m.manager.service()
    expect(rebooted).toMatchObject({ running: true, state: "active/running", restarts: 0 })
    expect(rebooted.pid).not.toBe(first.pid)
    const resumed = await servedEverywhere(m, "ws_api", 2)
    const resumedAt = Date.now()
    expect(resumed).not.toBe(socket)
    timing("boot → readiness + tunnel, unattended", { elapsedMs: resumedAt - bootedAt, beatMs: BEAT_MS })
    const afterReboot = m.cp.log.slice(requestsBeforeReboot).map((entry) => entry.path)
    expect(afterReboot[0]).toBe("/api/claxedo/host/enrollments/acquire")
    expect(afterReboot.filter((entry) => !entry.endsWith("/heartbeat"))).toEqual(["/api/claxedo/host/enrollments/acquire"])
    const resumedState = await m.state()
    expect(resumedState?.enrollment?.enrollment_id).toBe(enrollmentIdOf(m))
    expect(resumedState?.run).toMatchObject({ pid: rebooted.pid, generation: 2 })
    expect(resumedState?.service).toEqual(installed?.service)
    expect(m.manager.journal()).toContain(`serving as ${enrollmentIdOf(m)} (generation 2)`)
    expect(m.manager.journal()).not.toContain("Enrolled as")
    expect(m.manager.journal()).not.toContain("Resumed as")
    expect(await m.status()).toContain("ws_api  revision 1  connected")

    const callsBeforeRevoke = m.manager.calls.length
    const revokedAt = Date.now()
    m.cp.revoke(enrollmentIdOf(m))
    await until(() => !m.manager.service().running, "the unit's process to exit")
    const exitedAt = Date.now()
    const ended = m.manager.service()
    expect(ended).toMatchObject({ running: false, state: "failed/failed", restarts: 0, lastExit: { code: 78, signal: null } })
    expect(ended.raw).toContain("ActiveState=failed\n")
    expect(ended.raw).toContain("NRestarts=0\n")
    expect(ended.raw).toContain("ExecMainStatus=78\n")
    expect(ended.raw).toContain("Result=exit-code\n")
    expect(m.timerWaitsMs, "no restart was scheduled").toEqual([])
    expect(m.manager.restartWaitsMs).toEqual([])
    expect(m.manager.calls.length).toBe(callsBeforeRevoke)
    timing("revoke → exit 78", { elapsedMs: exitedAt - revokedAt, beatMs: BEAT_MS })
    expect(m.manager.journal()).toContain("the control plane no longer accepts this machine (enrollment_revoked)")
    expect(m.relay.open()).toEqual([])
    const revokedState = await m.state()
    expect(revokedState?.run).toBeUndefined()
    expect(revokedState?.service).toEqual(installed?.service)
    status = await m.status()
    expect(status).toContain("status       offline")
    expect(status).toContain("Served folders: none")
    expect(m.cp.log.slice(-1)[0]?.path, "nothing acquired after the decision").toBe("/api/claxedo/host/enrollments/heartbeat")
  }, 30_000)

  test("a process the kernel kills is restarted by the manager after the unit's RestartSec, acquiring the next generation and serving again", async () => {
    m = await machine({ linger: true })
    expect((await cloudInit(m)).exitCodes).toEqual([0])
    await beating(m, INSTALLED_AT)
    const hostId = (await m.state())!.host_id
    m.cp.assign({ hostId, workspaceId: "ws_api", remoteDirectory: path.join(m.root, "api") })
    const socket = await servedEverywhere(m, "ws_api", 1)
    const killed = m.manager.child()!
    const killedAt = Date.now()
    killed.kill("SIGKILL")
    await until(() => m.manager.service().restarts === 1 && m.manager.service().running, "the manager to restart the unit")
    expect(m.manager.restartWaitsMs, "RestartSec=5 from the unit, in ms").toEqual([5_000])
    expect(m.manager.child()!.pid).not.toBe(killed.pid)
    await until(() => socket.closed, "the killed process's tunnel to close")
    await servedEverywhere(m, "ws_api", 2)
    timing("SIGKILL → restarted + served", { elapsedMs: Date.now() - killedAt, beatMs: BEAT_MS })
    const restarted = m.manager.service()
    expect(restarted).toMatchObject({ state: "active/running", restarts: 1 })
    expect(restarted.raw).toContain("NRestarts=1\n")
    expect((await m.state())?.run).toMatchObject({ pid: restarted.pid, generation: 2 })
  }, 30_000)

  test("without lingering the unit is written and recorded but nothing starts, exit 78; --uninstall-service removes it", async () => {
    m = await machine({ linger: false })
    const provisioned = await cloudInit(m)
    expect(provisioned.exitCodes).toEqual([78])
    expect(m.manager.calls).toEqual(["loginctl show-user ec2-user --property=Linger --value"])
    expect(await fs.readFile(m.unitFile, "utf8")).toContain("RestartPreventExitStatus=78")
    const state = await m.state()
    expect(state?.enrollment?.enrollment_id).toBe(enrollmentIdOf(m))
    expect(state?.service).toEqual({ kind: "systemd-user", unit: m.unitFile, installed_at: INSTALLED_AT })
    expect(m.manager.service()).toMatchObject({ loaded: false, enabled: false, running: false })
    expect(m.manager.child()).toBeUndefined()
    expect(m.cp.beats()).toEqual([])
    expect(m.lines.some((line) => line.startsWith(`Wrote ${SYSTEMD_UNIT}`) && line.includes("did not start it"))).toBe(true)
    expect(m.lines).toContain("  sudo loginctl enable-linger ec2-user")
    expect(await m.status()).toContain("status       offline")

    expect(await connect(["--uninstall-service"], m.deps)).toBe(0)
    expect(await fs.readFile(m.unitFile, "utf8").catch(() => "gone")).toBe("gone")
    expect((await m.state())?.service).toBeUndefined()
  }, 30_000)
})

/**
 * The same host loop in this process, where the state store's writes are a
 * seam: the proof that a revision is acked only once it is on disk needs a
 * write that fails, and a child process has no way to be told to fail one.
 * Beats are driven by hand through the interval seam, one at a time.
 */
async function inProcessHost() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-inproc-")))
  const root = path.join(home, "srv")
  await fs.mkdir(path.join(root, "api"), { recursive: true })
  const relay = relayStub()
  const cp = createFakeConnectControlPlane({ relayUrl: relay.url })
  const lines: string[] = []
  const store = connectStateStore(home)
  const faults = {
    /** The next save carrying this `provider_config.revision` fails once, as a full disk would. */
    failSaveOfRevision: undefined as number | undefined,
  }
  const saves: Array<{ sealingKey: boolean; beatsBefore: number }> = []
  const failingStore: HostStateStore = {
    ...store,
    save: async (state) => {
      saves.push({ sealingKey: state.sealing_private_key_jwk !== undefined, beatsBefore: cp.beats().length })
      if (faults.failSaveOfRevision !== undefined && state.provider_config?.revision === faults.failSaveOfRevision) {
        faults.failSaveOfRevision = undefined
        throw new Error("ENOSPC: no space left on device")
      }
      await store.save(state)
    },
  }
  let tick: (() => void) | undefined
  let stop: ((signal: string) => void) | undefined
  let listener: HostRuntimeListener | undefined
  // Strictly increasing, so the run record each beat writes afterwards is
  // distinguishable from the previous beat's even inside one millisecond.
  let clock = 0
  const deps: ConnectDeps = {
    host: {
      ...defaultHostDeps(),
      fetch: cp.fetch,
      now: () => {
        clock = Math.max(clock + 1, Date.now())
        return clock
      },
      createListener: async () => {
        listener = await createHostRuntimeListener({ hostname: "127.0.0.1", port: 0, drainTimeoutMs: 500 })
        return listener
      },
      openCodeRuntime: () => undefined,
      setServing: setHostServing,
      servingState: hostServingState,
      stopServing: stopHostServing,
      setInterval: (fn) => {
        tick = fn
        return { cancel: () => undefined }
      },
      onStopSignal: (fn) => {
        stop = fn
        return () => undefined
      },
      sleep: async () => undefined,
      log: (line) => lines.push(line),
    },
    service: () => {
      throw new Error("no service manager in this harness")
    },
    store: failingStore,
    paths: connectPaths(home),
    controlPlaneUrl: cp.url,
    displayName: "build-box",
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    desktopDaemon: async () => ({ state: "absent" }) as const,
  }
  let running: Promise<number> | undefined
  const stateText = () => fs.readFile(connectPaths(home).stateFile, "utf8")
  const lastBeatAt = async () => (await store.load())?.run?.last_beat_ok_at ?? 0
  /** Resolves once the host has reconciled the ack and written the run record that follows it. */
  const beatReconciled = async (since: number, what: string) => {
    const exited = running!.then((code) => {
      throw new Error(`connect exited ${code} while waiting for ${what}; it said: ${lines.join(" | ")}`)
    })
    await Promise.race([until(async () => (await lastBeatAt()) > since, what), exited])
  }
  return {
    cp,
    lines,
    saves,
    faults,
    root,
    listener: () => listener!,
    state: () => store.load(),
    stateText,
    enrollmentId: () => [...cp.enrollments.keys()][0],
    /** Enroll and run; resolves once the first beat has been sent. */
    start: async () => {
      const since = await lastBeatAt()
      let argv = ["--foreground"]
      if (!(await store.load())?.enrollment) {
        const invitation = await cp.createInvitation({ displayName: "build-box", scope: { allowed_roots: [root], visibility: "owner" } })
        const tokenFile = path.join(home, "invite.txt")
        await fs.writeFile(tokenFile, invitation.token)
        argv = ["--token-file", tokenFile, "--root", root]
      }
      running = connect(argv, deps)
      await beatReconciled(since, "the first beat")
    },
    /** One beat, reconciled; returns what the request declared. */
    beat: async () => {
      const since = await lastBeatAt()
      tick?.()
      await beatReconciled(since, "a beat")
      return cp.beats().at(-1)!.body
    },
    stop: async () => {
      stop?.("SIGTERM")
      const code = await running
      running = undefined
      return code
    },
    close: async () => {
      if (running) stop?.("SIGTERM")
      await running
      await relay.stop()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

const SECRET = "sk-owner-secret-0123456789abcdef"
const providerConfig = (placeholder: string) =>
  JSON.stringify({ version: 1, providers: { "claude-sdk": { baseUrl: "https://broker.example/b/1", placeholder, authMode: "bearer" } } })

describe("provider configuration on a running claxedo connect host", () => {
  let h: Awaited<ReturnType<typeof inProcessHost>>
  const previousDataDir = process.env.CLAXEDO_DATA_DIR
  afterEach(async () => {
    await h?.close()
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("the sealing key is on disk before the first beat declares it; a push is stored sealed, acked only once stored, applied to the live runtime, and withdrawn by a null revision", async () => {
    h = await inProcessHost()
    process.env.CLAXEDO_DATA_DIR = path.join(h.root, "..", "data")
    await h.start()
    const id = h.enrollmentId()

    const enrolled = await h.state()
    expect(enrolled?.sealing_private_key_jwk?.d).toBeDefined()
    expect(h.cp.sealingPublicKey(id)).toBe(JSON.stringify(sealingPublicKeyJwk(enrolled!.sealing_private_key_jwk!)))
    expect(h.saves.find((save) => save.sealingKey)?.beatsBefore).toBe(0)
    expect(h.cp.beats()[0]?.body.providerConfigRevision, "nothing stored, nothing declared").toBeUndefined()

    // A served folder, so a live runtime exists to re-apply to.
    h.cp.assign({ hostId: enrolled!.host_id, workspaceId: "ws_api", remoteDirectory: path.join(h.root, "api") })
    await h.beat()
    await until(() => h.listener().owners().some((owner) => owner.workspaceId === "ws_api"), "the runtime for ws_api")
    const served = await h.state()
    const runtime = await h.listener().ensure({
      workspaceId: "ws_api",
      directory: path.join(h.root, "api"),
      hostId: served!.host_id,
      relay: { jwksUrl: served!.relay!.jwksUrl },
      sessionAuthorityUrl: served!.authority!.sessionAuthorityUrl,
      storeRoot: path.join(served!.storage_root, "ws_api"),
    })
    expect(runtime.host.detail().configApply).toMatchObject({ state: "applied", revision: 1 })

    const first = await h.cp.pushProviderConfig(id, providerConfig(SECRET))
    await h.beat()
    await until(async () => (await h.state())?.provider_config?.revision === first, "revision 1 on disk")
    const text = await h.stateText()
    expect(text).toContain('"sealed": "mseal1.')
    expect(text).not.toContain(SECRET)
    expect(h.lines).toContain("provider configuration revision 1: claude-sdk")
    expect(h.lines.join("\n")).not.toContain(SECRET)
    await until(() => runtime.host.detail().configApply.revision === 2, "the live runtime to re-apply")
    expect(runtime.host.detail().configApply.state).toBe("applied")

    expect((await h.beat()).providerConfigRevision).toBe(first)
    expect(h.cp.providerConfigAckedRevision(id)).toBe(first)

    const second = await h.cp.pushProviderConfig(id, providerConfig(`${SECRET}-rotated`))
    h.faults.failSaveOfRevision = second
    await h.beat()
    expect(h.faults.failSaveOfRevision, "the failing write was the provider-config one").toBeUndefined()
    expect((await h.beat()).providerConfigRevision, "the beat after the failed write still declares the old revision").toBe(first)
    expect(h.cp.providerConfigAckedRevision(id)).toBe(first)
    expect(h.lines.some((line) => line.startsWith("provider-config failed: ") && line.includes("ENOSPC"))).toBe(true)
    expect(h.lines.filter((line) => line === "provider configuration revision 2: claude-sdk")).toHaveLength(1)
    expect((await h.beat()).providerConfigRevision, "re-delivered, stored, then declared").toBe(second)
    expect(h.cp.providerConfigAckedRevision(id)).toBe(second)
    expect(await h.stateText()).not.toContain(SECRET)
    await until(() => runtime.host.detail().configApply.revision === 3, "the rotated placeholder to reach the runtime")

    const third = await h.cp.pushProviderConfig(id, null)
    await h.beat()
    await until(async () => (await h.state())?.provider_config?.revision === third, "the withdrawal on disk")
    expect((await h.state())?.provider_config).toEqual({ revision: third, sealed: null })
    expect(h.lines).toContain(`provider configuration revision ${third}: withdrawn; harnesses run on this machine's own logins`)
    expect((await h.beat()).providerConfigRevision).toBe(third)
    expect(h.cp.providerConfigAckedRevision(id)).toBe(third)
    await until(() => runtime.host.detail().configApply.revision === 4, "the withdrawal to reach the runtime")

    expect(await h.stop()).toBe(0)
  }, 30_000)

  test("a restart declares the stored revision under the same sealing key, and applies what the owner pushed while it was down", async () => {
    h = await inProcessHost()
    process.env.CLAXEDO_DATA_DIR = path.join(h.root, "..", "data")
    await h.start()
    const id = h.enrollmentId()
    const key = h.cp.sealingPublicKey(id)
    const first = await h.cp.pushProviderConfig(id, providerConfig(SECRET))
    await h.beat()
    await until(async () => (await h.state())?.provider_config?.revision === first, "revision 1 on disk")
    await h.beat()
    expect(h.cp.providerConfigAckedRevision(id)).toBe(first)
    expect(await h.stop()).toBe(0)

    const second = await h.cp.pushProviderConfig(id, providerConfig(`${SECRET}-while-down`))
    h.lines.length = 0
    await h.start()

    expect(h.cp.beats().at(-1)?.body.providerConfigRevision, "the boot beat declares what is on disk").toBe(first)
    expect(h.cp.sealingPublicKey(id), "the key is not re-minted").toBe(key)
    expect(h.lines).toContain("provider configuration revision 1: claude-sdk")
    await until(async () => (await h.state())?.provider_config?.revision === second, "the missed revision on disk")
    expect(h.lines).toContain("provider configuration revision 2: claude-sdk")
    expect((await h.beat()).providerConfigRevision).toBe(second)
    expect(await h.stateText()).not.toContain(SECRET)
    expect(await h.stop()).toBe(0)
  }, 30_000)
})
