import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHostRuntimeListener, type HostRuntimeListener } from "@claxedo/host-serving/runtime"
import { setUserHostedServing, stopUserHostedServing, userHostedServingState } from "@claxedo/host-serving/serving"
import { parseConnectArgs } from "../connect/args"
import { createFakeConnectControlPlane, decodeFakeTunnelToken, type FakeControlPlane } from "../connect/fake-control-plane.test-support"
import { BEAT_INTERVAL_MS, servingCredential, transientBootstrapFailure, withBootstrapRetry, type HostDeps } from "../connect/host"
import {
  desktopDaemonDiscoveryFiles,
  liveDesktopDaemon,
  parseDesktopDaemonDiscovery,
  verifyDesktopDaemon,
  type DesktopDaemonDiscovery,
} from "../connect/desktop-daemon"
import { connectPaths, connectStateStore } from "../connect/paths"
import { relayStub, until } from "../connect/relay-stub.test-support"
import type { ServiceDeps } from "../connect/service"
import { HostedHttpError, HostedRequestTimeoutError } from "@claxedo/host-connector/machine-transport"
import { HostConnectDecisionError } from "@claxedo/host-connector/bootstrap"
import { connect, type ConnectDeps } from "./connect"
import { hostOnline, statusLines } from "./status"

/**
 * The real `connect` command function against the strict fake control plane,
 * the real host runtime listener, the real serving loop and a relay stub that
 * accepts host tunnels and records the credential each one presents. Beats
 * and the stop signal are driven by hand.
 */

/** The desktop daemon's identity route, as `claxedo-local-server` serves it: bearer-checked, answering who it is. */
function fakeDesktopDaemon(identity: { pid: number; generation: string; token: string }) {
  const requests: Array<{ path: string; authorization: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, authorization: request.headers.get("authorization") })
      if (url.pathname !== "/api/claxedo/daemon") return new Response("not found", { status: 404 })
      if (request.headers.get("authorization") !== `Bearer ${identity.token}`) {
        return Response.json({ error: { code: "daemon_identity_unauthorized" } }, { status: 401 })
      }
      return Response.json({ service: "claxedo-local-daemon", protocol: 1, generation: identity.generation, pid: identity.pid })
    },
  })
  const port = server.port!
  return {
    port,
    requests,
    record: (overrides: Partial<{ pid: number; port: number; token: string; generation: string }> = {}) =>
      JSON.stringify({
        service: "claxedo-local-daemon",
        protocol: 1,
        generation: identity.generation,
        token: identity.token,
        pid: identity.pid,
        port,
        startedAt: "now",
        ...overrides,
      }),
    stop: () => server.stop(true),
  }
}

type Harness = {
  home: string
  root: string
  cp: FakeControlPlane
  relay: ReturnType<typeof relayStub>
  lines: string[]
  tick: () => void
  stop: () => void
  listener: () => HostRuntimeListener | undefined
  deps: ConnectDeps
  serviceCalls: string[]
}

/** A Linux box whose user manager is up: lingering on, a runtime dir, `systemctl --user` answering. */
function serviceDeps(home: string, calls: string[]): ServiceDeps {
  return {
    platform: "linux",
    homedir: home,
    username: "svc",
    command: ["/usr/bin/node", "/opt/claxedo/index.mjs"],
    claxedoHome: home,
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    run: async (file, args) => {
      calls.push([file, ...args].join(" "))
      if (file === "loginctl") return { code: 0, stdout: "yes\n" }
      if (args.includes("is-system-running")) return { code: 0, stdout: "running\n" }
      return { code: 0, stdout: "" }
    },
    writeFile: async (file, text) => {
      calls.push(`write ${file}`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
    },
    unlink: async (file) => {
      calls.push(`unlink ${file}`)
      await fs.rm(file, { force: true })
    },
    now: () => 1_700_000_000_000,
  }
}

async function harness(input: { home?: string; cp?: FakeControlPlane; relay?: ReturnType<typeof relayStub> } = {}): Promise<Harness> {
  const home = input.home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-connect-")))
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-srv-")))
  const relay = input.relay ?? relayStub()
  const cp = input.cp ?? createFakeConnectControlPlane({ relayUrl: relay.url })
  const lines: string[] = []
  let tick: (() => void) | undefined
  let stop: ((signal: string) => void) | undefined
  let listener: HostRuntimeListener | undefined
  const serviceCalls: string[] = []
  const host: HostDeps = {
    fetch: cp.fetch,
    createListener: async () => {
      listener = await createHostRuntimeListener({ hostname: "127.0.0.1", port: 0, drainTimeoutMs: 500 })
      return listener
    },
    openCodeRuntime: () => undefined,
    setServing: setUserHostedServing,
    servingState: userHostedServingState,
    stopServing: stopUserHostedServing,
    resolvePath: (target) => fs.realpath(target),
    setInterval: (fn) => {
      tick = fn
      return { cancel: () => undefined }
    },
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(handle) }
    },
    onStopSignal: (fn) => {
      stop = fn
      return () => undefined
    },
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    sleep: async () => undefined,
    log: (line) => lines.push(line),
    pid: process.pid,
  }
  const deps: ConnectDeps = {
    host,
    service: () => serviceDeps(home, serviceCalls),
    store: connectStateStore(home),
    paths: connectPaths(home),
    controlPlaneUrl: cp.url,
    displayName: "build-box",
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    desktopDaemon: () => liveDesktopDaemon({ files: desktopDaemonDiscoveryFiles({}, home) }),
  }
  return {
    home,
    root,
    cp,
    relay,
    lines,
    tick: () => tick?.(),
    stop: () => stop?.("SIGTERM"),
    listener: () => listener,
    deps,
    serviceCalls,
  }
}

async function invitationFile(h: Harness, roots: string[]) {
  const invitation = await h.cp.createInvitation({ displayName: "build-box", scope: { allowed_roots: roots, visibility: "owner" } })
  const file = path.join(h.home, "invite.txt")
  await fs.writeFile(file, `${invitation.token}\n`)
  return { file, invitation }
}

const enrollmentIdOf = (h: Harness) => [...h.cp.enrollments.keys()][0]

describe("claxedo connect", () => {
  let h: Harness
  beforeEach(async () => {
    h = await harness()
  })
  afterEach(async () => {
    stopUserHostedServing()
    await h.relay.stop()
    await fs.rm(h.home, { recursive: true, force: true })
    await fs.rm(h.root, { recursive: true, force: true })
  })

  test("token-file boot enrolls, acquires, beats, then serves an assignment and the credential covers it", async () => {
    const { file } = await invitationFile(h, [h.root])
    const running = connect(["--token-file", file, "--root", h.root], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")

    expect(h.cp.log.map((entry) => entry.path)).toEqual([
      "/api/claxedo/host/enrollments/redeem",
      "/api/claxedo/host/enrollments/acquire",
      "/api/claxedo/host/enrollments/heartbeat",
    ])
    expect(await fs.readFile(file, "utf8").catch(() => "gone")).toBe("gone")
    await until(async () => (await h.deps.store.load())?.run?.last_beat_ok_at !== undefined, "run record")
    const enrolled = await h.deps.store.load()
    expect(enrolled?.enrollment?.enrollment_id).toBe(enrollmentIdOf(h))
    expect(enrolled?.bootstrap).toBeUndefined()
    expect(enrolled?.cli_roots).toEqual([h.root])
    expect(enrolled?.relay?.url).toBe(h.relay.url)
    expect(enrolled?.run).toMatchObject({ pid: process.pid, generation: 1, served: [] })
    expect(h.lines.some((line) => line.startsWith("Enrolled as "))).toBe(true)

    const directory = path.join(h.root, "api")
    await fs.mkdir(directory)
    const workspaceId = "ws_api"
    h.cp.assign({ hostId: enrolled!.host_id, workspaceId, remoteDirectory: directory, displayName: "api" })
    h.tick()
    await until(() => h.cp.routable(enrollmentIdOf(h)).includes(workspaceId), "the ack to become readiness")
    expect(h.listener()?.workspaceIds()).toEqual([workspaceId])
    await until(() => h.relay.sockets.some((socket) => !socket.closed), "the host tunnel to dial the relay")
    const socket = h.relay.sockets.find((entry) => !entry.closed)!
    expect(socket.workspaceIds).toEqual([workspaceId])
    expect(decodeFakeTunnelToken(socket.token)).toEqual({ workspace_ids: [workspaceId], enrollment_id: enrollmentIdOf(h), generation: 1 })
    h.tick()
    await until(async () => (await h.deps.store.load())?.run?.served?.[0]?.connected === true, "served record to show the open tunnel")
    const serving = await h.deps.store.load()
    expect(serving?.run?.served).toEqual([{ workspace_id: workspaceId, revision: 1, connected: true }])
    expect(hostOnline(serving!, { pidAlive: () => true, now: () => Date.now() })).toBe(true)
    const status = await statusLines({
      load: () => h.deps.store.load(),
      stateFile: h.deps.paths.stateFile,
      resolvePath: (target) => fs.realpath(target),
      pidAlive: () => true,
      now: () => Date.now(),
      log: () => undefined,
    })
    expect(status.join("\n")).toContain(`enrollment   ${enrollmentIdOf(h)} (via invitation, owner Alice)`)
    expect(status.join("\n")).toContain("status       online")
    expect(status.join("\n")).toContain(`${workspaceId}  revision 1  connected`)

    h.stop()
    expect(await running).toBe(0)
    expect((await h.deps.store.load())?.run).toBeUndefined()
    await until(() => socket.closed, "the tunnel to close on drain")
    expect(userHostedServingState({ sessionAuthority: () => "managed-private" }).serving).toBe(false)
    // The drain's last request withdrew readiness, so the control plane
    // stopped routing this machine before the process was gone.
    expect(h.cp.log.at(-1)).toMatchObject({ path: "/api/claxedo/host/enrollments/heartbeat", body: { acks: [] } })
    expect(h.cp.routable(enrollmentIdOf(h))).toEqual([])
  })

  test("a restart resumes with acquire, never redeeming again", async () => {
    const { file } = await invitationFile(h, [h.root])
    const first = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    h.stop()
    expect(await first).toBe(0)
    h.cp.log.length = 0

    const second = connect([], h.deps)
    await until(() => h.cp.beats().length >= 1, "resumed beat")
    expect(h.cp.log.map((entry) => entry.path)).toEqual([
      "/api/claxedo/host/enrollments/acquire",
      "/api/claxedo/host/enrollments/heartbeat",
    ])
    expect(h.cp.beats()[0]?.body).toMatchObject({ generation: 2, acks: [], sessionAuthority: "managed-private" })
    h.stop()
    expect(await second).toBe(0)
  })

  test("a boot after SIGKILL records its own start, not the dead instance's", async () => {
    const { file } = await invitationFile(h, [h.root])
    let clock = 1_700_000_000_000
    h.deps.host.now = () => clock
    const first = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    await until(async () => (await h.deps.store.load())?.run?.started_at === clock, "the first run record")
    // SIGKILL: the process is gone and its `run` record stays on disk.
    h.stop()
    expect(await first).toBe(0)
    const killed = await h.deps.store.load()
    await h.deps.store.save({ ...killed!, run: { pid: 4242, started_at: clock, generation: 1, last_beat_ok_at: clock, lease_expires_at: clock + 60_000, served: [] } })

    clock += 90_000
    const second = connect([], h.deps)
    await until(() => h.cp.beats().length >= 2, "resumed beat")
    await until(async () => (await h.deps.store.load())?.run?.pid === process.pid, "the second run record")
    expect((await h.deps.store.load())?.run).toMatchObject({ pid: process.pid, started_at: clock, generation: 2 })
    h.stop()
    expect(await second).toBe(0)
  })

  test("a redeem whose response was lost is recovered on the next boot as resumed", async () => {
    const { file } = await invitationFile(h, [h.root])
    h.cp.faults.dropRedeemResponse = true
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    expect(h.cp.log.filter((entry) => entry.path.endsWith("/redeem"))).toHaveLength(2)
    expect(h.cp.enrollments.size).toBe(1)
    expect(h.lines.some((line) => line.startsWith("redeem failed (fetch failed); retrying"))).toBe(true)
    expect(h.lines.some((line) => line.startsWith("Resumed as "))).toBe(true)
    h.stop()
    expect(await running).toBe(0)
  })

  test("a redeemed invitation presented by a fresh key exits 78 and keeps the token file", async () => {
    const { file, invitation } = await invitationFile(h, [h.root])
    const first = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    h.stop()
    await first

    const other = await harness({ cp: h.cp, relay: h.relay })
    const copy = path.join(other.home, "invite.txt")
    await fs.writeFile(copy, invitation.token)
    expect(await connect(["--token-file", copy], other.deps)).toBe(78)
    expect(other.lines.at(-1)).toBe("control plane refused: invitation_redeemed")
    expect(await fs.readFile(copy, "utf8")).toBe(invitation.token)
    expect(h.cp.enrollments.size).toBe(1)
    await fs.rm(other.home, { recursive: true, force: true })
    await fs.rm(other.root, { recursive: true, force: true })
  })

  test("without state or a token file it explains how to mint an invitation and exits 78", async () => {
    expect(await connect([], h.deps)).toBe(78)
    expect(h.lines.join("\n")).toContain("claxedo host invite --name <machine> --root <dir>")
    expect(await h.deps.store.load()).toBeUndefined()
  })

  test("a revocation mid-run ends the process with 78 and clears the run record", async () => {
    const { file } = await invitationFile(h, [h.root])
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    h.cp.revoke(enrollmentIdOf(h))
    h.tick()
    expect(await running).toBe(78)
    expect(h.lines.at(-1)).toContain("enrollment_revoked")
    expect((await h.deps.store.load())?.run).toBeUndefined()
  })

  test("a re-pointed assignment withdraws the old tunnel and acks the new revision; outside-root folders are never acked", async () => {
    const { file } = await invitationFile(h, [h.root])
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    const hostId = (await h.deps.store.load())!.host_id
    const api = path.join(h.root, "api")
    const web = path.join(h.root, "web")
    await fs.mkdir(api)
    await fs.mkdir(web)
    h.cp.assign({ hostId, workspaceId: "ws_1", remoteDirectory: api })
    h.tick()
    await until(() => h.cp.routable(enrollmentIdOf(h)).includes("ws_1"), "first ack")
    await until(() => h.relay.sockets.filter((socket) => !socket.closed).length === 1, "one tunnel")

    h.cp.assign({ hostId, workspaceId: "ws_1", remoteDirectory: web })
    h.tick()
    await until(() => h.cp.beats().some((beat) => JSON.stringify(beat.body.acks) === JSON.stringify([{ workspaceId: "ws_1", revision: 2 }])), "revision 2 ack")
    await until(() => h.cp.routable(enrollmentIdOf(h)).includes("ws_1"), "revision 2 readiness")
    await until(() => h.relay.sockets.filter((socket) => !socket.closed).length === 1 && h.relay.sockets.length === 2, "the old tunnel closed and a new one dialled")
    expect(h.lines).toContain(`workspace ws_1: serving ${web} (revision 2)`)

    // The control plane's lexical check is faked permissively here so the
    // host's own resolved-path check is what refuses this one.
    h.cp.enrollments.get(enrollmentIdOf(h))!.scope.allowed_roots.push("/")
    h.cp.assign({ hostId, workspaceId: "ws_out", remoteDirectory: os.tmpdir() })
    h.tick()
    await until(() => h.lines.some((line) => line.startsWith("workspace ws_out: refused: ")), "the outside-root refusal")
    expect(h.cp.beats().every((beat) => !JSON.stringify(beat.body.acks).includes("ws_out"))).toBe(true)
    expect(h.listener()?.workspaceIds()).toEqual(["ws_1"])

    h.cp.unassign("ws_1")
    h.tick()
    await until(() => h.listener()?.workspaceIds().length === 0, "retirement to dispose the runtime")
    h.stop()
    expect(await running).toBe(0)
  })

  test("SIGTERM during a preparation: the workspace is refused, never acked, and the final beat withdraws everything", async () => {
    const { file } = await invitationFile(h, [h.root])
    const slow = path.join(h.root, "slow")
    const fast = path.join(h.root, "fast")
    await fs.mkdir(slow)
    await fs.mkdir(fast)
    let releaseSlow: (() => void) | undefined
    const realpath = h.deps.host.resolvePath
    h.deps.host.resolvePath = async (target) => {
      if (target === slow) {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve
        })
      }
      return realpath(target)
    }
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    const hostId = (await h.deps.store.load())!.host_id
    h.cp.assign({ hostId, workspaceId: "ws_fast", remoteDirectory: fast })
    h.tick()
    await until(() => h.cp.routable(enrollmentIdOf(h)).includes("ws_fast"), "the fast folder to be served")
    h.cp.assign({ hostId, workspaceId: "ws_slow", remoteDirectory: slow })
    h.tick()
    await until(() => releaseSlow !== undefined, "the slow folder's preparation to be in flight")

    h.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.cp.log.at(-1)?.body, "the final beat waits for the preparation").not.toEqual(expect.objectContaining({ acks: [] }))
    releaseSlow?.()

    expect(await running).toBe(0)
    expect(h.lines.some((line) => line.startsWith("workspace ws_slow: refused: ") && line.includes("draining"))).toBe(true)
    expect(h.lines).not.toContain(`workspace ws_slow: serving ${slow} (revision 1)`)
    expect(h.cp.beats().every((beat) => !JSON.stringify(beat.body.acks).includes("ws_slow"))).toBe(true)
    expect(h.cp.log.at(-1)).toMatchObject({ path: "/api/claxedo/host/enrollments/heartbeat", body: { acks: [] } })
    expect(h.cp.routable(enrollmentIdOf(h))).toEqual([])
    expect(h.listener()?.workspaceIds()).toEqual([])
    expect((await h.deps.store.load())?.run).toBeUndefined()
  })

  test("a preparation that never finishes cannot hold the exit past the drain bound", async () => {
    const { file } = await invitationFile(h, [h.root])
    const stuck = path.join(h.root, "stuck")
    await fs.mkdir(stuck)
    const realpath = h.deps.host.resolvePath
    let stuckAttempted = false
    h.deps.host.resolvePath = (target) => {
      if (target !== stuck) return realpath(target)
      stuckAttempted = true
      return new Promise<string>(() => undefined)
    }
    const timeouts: number[] = []
    h.deps.host.setTimeout = (fn, ms) => {
      timeouts.push(ms)
      fn()
      return { cancel: () => undefined }
    }
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    h.cp.assign({ hostId: (await h.deps.store.load())!.host_id, workspaceId: "ws_stuck", remoteDirectory: stuck })
    h.tick()
    await until(() => stuckAttempted, "the preparation to hang")

    h.stop()

    expect(await running).toBe(0)
    expect(timeouts).toEqual([10_000])
    expect(h.lines).toContain("drain did not finish within 10s; closing anyway")
    expect(h.cp.routable(enrollmentIdOf(h))).toEqual([])
    expect((await h.deps.store.load())?.run).toBeUndefined()
  })

  test("a folder assigned before it exists is served once it appears, without a restart", async () => {
    const { file } = await invitationFile(h, [h.root])
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    const hostId = (await h.deps.store.load())!.host_id
    const later = path.join(h.root, "later")
    h.cp.assign({ hostId, workspaceId: "ws_later", remoteDirectory: later })
    h.tick()
    await until(() => h.lines.some((line) => line.startsWith("workspace ws_later: refused: ")), "the first attempt to fail")
    expect(h.lines.at(-1)).toContain("cannot be resolved")
    expect(h.listener()?.workspaceIds()).toEqual([])

    await fs.mkdir(later)
    h.tick()
    await until(() => h.cp.routable(enrollmentIdOf(h)).includes("ws_later"), "the ack after the folder appeared")
    expect(h.listener()?.workspaceIds()).toEqual(["ws_later"])
    expect(h.lines).toContain(`workspace ws_later: serving ${later} (revision 1)`)
    expect(h.cp.log.filter((entry) => entry.path.endsWith("/acquire"))).toHaveLength(1)
    h.stop()
    expect(await running).toBe(0)
  })

  test("--install-service enrolls, writes the unit and records it; --uninstall-service removes it", async () => {
    const { file } = await invitationFile(h, [h.root])
    expect(await connect(["--token-file", file, "--install-service"], h.deps)).toBe(0)
    const unit = path.join(h.home, ".config", "systemd", "user", "claxedo-connect.service")
    const text = await fs.readFile(unit, "utf8")
    expect(text).toContain(`ExecStart="/usr/bin/node" "/opt/claxedo/index.mjs" "connect" "--foreground"`)
    expect(text).toContain("RestartPreventExitStatus=78")
    expect(text).toContain(`Environment=CLAXEDO_HOME="${h.home}"`)
    expect(h.serviceCalls).toEqual([
      `write ${unit}`,
      "loginctl show-user svc --property=Linger --value",
      "systemctl --user is-system-running",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now claxedo-connect.service",
    ])
    expect((await h.deps.store.load())?.service).toEqual({ kind: "systemd-user", unit, installed_at: 1_700_000_000_000 })
    expect(h.lines.some((line) => line.startsWith("Installed and started claxedo-connect.service"))).toBe(true)
    expect(h.cp.beats()).toHaveLength(0)

    expect(await connect(["--uninstall-service"], h.deps)).toBe(0)
    expect(await fs.readFile(unit, "utf8").catch(() => "gone")).toBe("gone")
    expect((await h.deps.store.load())?.service).toBeUndefined()
  })

  test("--install-service on a box without a user manager writes and records the unit, prints the linger command and exits 78", async () => {
    const { file } = await invitationFile(h, [h.root])
    const service = serviceDeps(h.home, h.serviceCalls)
    h.deps.service = () => ({
      ...service,
      env: {},
      run: async (bin, args) => {
        h.serviceCalls.push([bin, ...args].join(" "))
        // cloud-init: no login session, so loginctl knows no such user yet.
        return { code: 1, stdout: "" }
      },
    })

    expect(await connect(["--token-file", file, "--install-service"], h.deps)).toBe(78)
    const unit = path.join(h.home, ".config", "systemd", "user", "claxedo-connect.service")
    expect(await fs.readFile(unit, "utf8")).toContain("RestartPreventExitStatus=78")
    expect(h.serviceCalls).toEqual([`write ${unit}`, "loginctl show-user svc --property=Linger --value"])
    expect((await h.deps.store.load())?.service).toEqual({ kind: "systemd-user", unit, installed_at: 1_700_000_000_000 })
    expect((await h.deps.store.load())?.enrollment).toBeDefined()
    expect(h.lines.some((line) => line.startsWith("Wrote claxedo-connect.service") && line.includes("did not start it"))).toBe(true)
    expect(h.lines).toContain("  sudo loginctl enable-linger svc")
    expect(h.lines.some((line) => line.includes("Installed and started"))).toBe(false)
    expect(h.cp.beats()).toHaveLength(0)
  })

  test("--install-service records the service before the unit starts, so the child's own saves keep it", async () => {
    const { file } = await invitationFile(h, [h.root])
    let child: Promise<number> | undefined
    const service = serviceDeps(h.home, h.serviceCalls)
    h.deps.service = () => ({
      ...service,
      run: async (bin, args) => {
        const result = await service.run(bin, args)
        if (!args.includes("--now")) return result
        // The unit's process: it loads the state file on its own and rewrites it on every beat.
        child = connect([], h.deps)
        await until(() => h.cp.beats().length >= 1, "the service's first beat")
        return result
      },
    })

    expect(await connect(["--token-file", file, "--install-service"], h.deps)).toBe(0)
    h.tick()
    await until(() => h.cp.beats().length >= 2, "the service's second beat")
    await until(async () => (await h.deps.store.load())?.run?.last_beat_ok_at !== undefined, "the child's run record")

    expect((await h.deps.store.load())?.service).toMatchObject({ kind: "systemd-user", installed_at: 1_700_000_000_000 })
    h.stop()
    expect(await child!).toBe(0)
    expect((await h.deps.store.load())?.service).toMatchObject({ kind: "systemd-user" })
  })

  test("status reads online from the lease the control plane issued, not from a client-side TTL", async () => {
    const enrolled = (await (async () => {
      const { file } = await invitationFile(h, [h.root])
      const running = connect(["--token-file", file], h.deps)
      await until(() => h.cp.beats().length >= 1, "first beat")
      h.stop()
      await running
      return (await h.deps.store.load())!
    })())
    const run = { pid: process.pid, started_at: 1_000, generation: 1, last_beat_ok_at: 10_000, lease_expires_at: 18_000 }
    const alive = { pidAlive: () => true }

    expect(hostOnline({ ...enrolled, run }, { ...alive, now: () => 18_000 })).toBe(true)
    // 8 s after the last good beat — inside any client-side guess at the TTL — the issued lease is over.
    expect(hostOnline({ ...enrolled, run }, { ...alive, now: () => 18_001 })).toBe(false)
    expect(hostOnline({ ...enrolled, run: { ...run, lease_expires_at: undefined } }, { ...alive, now: () => 10_001 })).toBe(false)
    expect(hostOnline({ ...enrolled, run }, { pidAlive: () => false, now: () => 10_001 })).toBe(false)
  })

  test("a live desktop daemon on any channel's data dir refuses connect with 78 unless --alongside-desktop is passed; a recycled pid is no daemon", async () => {
    const { file } = await invitationFile(h, [h.root])
    const daemon = fakeDesktopDaemon({ pid: 4242, generation: "gen-1", token: "secret" })
    try {
      // The desktop's beta channel keeps its data under ~/.claxedo-beta; the
      // default channel's dir has no file at all.
      const discovery = path.join(h.home, ".claxedo-beta", "local-daemon.json")
      await fs.mkdir(path.dirname(discovery), { recursive: true })
      await fs.writeFile(discovery, daemon.record())

      expect(await connect(["--token-file", file], h.deps)).toBe(78)
      expect(h.lines.at(-1)).toBe(
        `the Claxedo desktop app's daemon is running on this machine (pid 4242, port ${daemon.port}, ${discovery}); the desktop serves this machine under its own enrollment when its remote access is on, so pass --alongside-desktop to run \`claxedo connect\` as a second machine beside it`,
      )
      expect(h.cp.log, "refused before any request").toHaveLength(0)
      expect(daemon.requests.at(-1)).toEqual({ path: "/api/claxedo/daemon", authorization: "Bearer secret" })
      expect(await fs.readFile(file, "utf8")).toContain("chx_inv_1.")
      expect(await connect(["--token-file", file, "--install-service"], h.deps)).toBe(78)
      expect(h.serviceCalls).toEqual([])

      // The desktop crashed and this test's own process now holds its pid: a
      // `kill(pid, 0)` guard would refuse for as long as the pid is taken, and
      // with restarts prevented on 78 that is for ever. The daemon on the
      // port answers as itself, not as the file's pid, so the file is stale.
      await fs.writeFile(discovery, daemon.record({ pid: process.pid }))
      const recycled = connect(["--token-file", file], h.deps)
      await until(() => h.cp.beats().length >= 1, "first beat")
      h.stop()
      expect(await recycled).toBe(0)

      // A daemon whose port nothing answers on is stale too.
      await fs.writeFile(discovery, daemon.record({ port: daemon.port + 1 }))
      const beatsBefore = h.cp.beats().length
      const gone = connect([], h.deps)
      await until(() => h.cp.beats().length > beatsBefore, "resumed beat")
      h.stop()
      expect(await gone).toBe(0)

      // Beside a live daemon, only when told to; the unit carries the choice.
      await fs.writeFile(discovery, daemon.record())
      expect(await connect(["--install-service", "--alongside-desktop"], h.deps)).toBe(0)
      const unit = path.join(h.home, ".config", "systemd", "user", "claxedo-connect.service")
      expect(await fs.readFile(unit, "utf8")).toContain(`"connect" "--foreground" "--alongside-desktop"`)
      expect(await connect(["--uninstall-service"], h.deps)).toBe(0)
      expect(await connect(["--reset"], h.deps), "reset is not serving").toBe(0)
    } finally {
      await daemon.stop()
    }
  })

  test("a root created as a symlink after it was first resolved serves nothing until --reset-roots or a new scope re-records it", async () => {
    // The owner scopes a folder that does not exist yet; the host pins it
    // where it resolves lexically. Someone on the box then creates it as a
    // symlink into a directory the owner never scoped.
    const projects = path.join(h.root, "projects")
    const victim = path.join(h.root, "victim")
    await fs.mkdir(path.join(victim, "app"), { recursive: true })
    const { file } = await invitationFile(h, [projects])
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    const hostId = (await h.deps.store.load())!.host_id
    h.cp.assign({ hostId, workspaceId: "ws_app", remoteDirectory: path.join(projects, "app") })
    h.tick()
    await until(() => h.lines.some((line) => line.startsWith("workspace ws_app: refused: ") && line.includes("cannot be resolved")), "the first refusal")
    await until(async () => (await h.deps.store.load())?.roots_canonical !== undefined, "the pin to be recorded")
    expect((await h.deps.store.load())?.roots_canonical).toEqual({ [projects]: projects })

    await fs.symlink(victim, projects)
    h.tick()
    await until(() => h.lines.some((line) => line.startsWith(`root ${projects} now resolves to ${victim}, not ${projects}`)), "the drift to be reported")
    await until(() => h.lines.filter((line) => line.startsWith("workspace ws_app: refused: ")).length >= 2, "the second refusal")
    expect(h.lines.filter((line) => line.startsWith("workspace ws_app: refused: ")).at(-1)).toContain("outside this host's roots (none)")
    expect(h.cp.routable(enrollmentIdOf(h))).toEqual([])
    expect(h.listener()?.workspaceIds()).toEqual([])
    expect((await h.deps.store.load())?.roots_canonical, "the pin stays as first recorded").toEqual({ [projects]: projects })
    const status = await statusLines({
      load: () => h.deps.store.load(),
      stateFile: h.deps.paths.stateFile,
      resolvePath: (target) => fs.realpath(target),
      pidAlive: () => true,
      now: () => Date.now(),
      log: () => undefined,
    })
    expect(status).toContain("  roots        none (nothing is servable)")
    expect(status.some((line) => line.startsWith(`  refused      ${projects} now resolves to ${victim}`))).toBe(true)

    // The same scope revision on every boot's first beat keeps the pin.
    h.stop()
    expect(await running).toBe(0)
    const rebooted = connect([], h.deps)
    let beats = h.cp.beats().length
    await until(() => h.cp.beats().length > beats, "the resumed beat")
    h.tick()
    await until(() => h.lines.filter((line) => line.startsWith("workspace ws_app: refused: ")).length >= 3, "the refusal after the restart")
    expect((await h.deps.store.load())?.roots_canonical).toEqual({ [projects]: projects })
    h.stop()
    expect(await rebooted).toBe(0)

    // The operator resets: the next resolution records the root where it resolves now.
    expect(await connect(["--reset-roots"], h.deps)).toBe(0)
    expect(h.lines.slice(-3)).toEqual([
      "Forgot where these roots first resolved:",
      `  ${projects}`,
      "Each is re-recorded as it resolves now, the next time an assignment under it is prepared.",
    ])
    expect((await h.deps.store.load())?.roots_canonical).toBeUndefined()
    const reset = connect([], h.deps)
    beats = h.cp.beats().length
    await until(() => h.cp.beats().length > beats, "the beat after the reset")
    h.tick()
    await until(() => h.cp.routable(enrollmentIdOf(h)).includes("ws_app"), "the folder to be served at the link's target")
    expect((await h.deps.store.load())?.roots_canonical).toEqual({ [projects]: victim })
    h.stop()
    expect(await reset).toBe(0)

    // A new scope revision from the owner re-records as well: the symlink is
    // removed and the folder recreated in place, and the owner re-scopes.
    await fs.unlink(projects)
    await fs.mkdir(path.join(projects, "app"), { recursive: true })
    const rescoped = connect([], h.deps)
    beats = h.cp.beats().length
    await until(() => h.cp.beats().length > beats, "the beat before the re-scope")
    h.tick()
    await until(() => h.lines.some((line) => line.startsWith(`root ${projects} now resolves to ${projects}, not ${victim}`)), "the drift back")
    h.cp.setScope(enrollmentIdOf(h), { allowed_roots: [projects], visibility: "owner" })
    h.cp.assign({ hostId, workspaceId: "ws_app", remoteDirectory: path.join(projects, "app") })
    h.tick()
    await until(() => h.cp.routable(enrollmentIdOf(h)).includes("ws_app"), "the folder to be served after the re-scope")
    expect((await h.deps.store.load())?.roots_canonical).toEqual({ [projects]: projects })
    expect((await h.deps.store.load())?.scope?.revision).toBe(2)
    h.stop()
    expect(await rescoped).toBe(0)
  })

  test("--reset-roots with nothing recorded says so", async () => {
    expect(await connect(["--reset-roots"], h.deps)).toBe(0)
    expect(h.lines.at(-1)).toContain("nothing to reset")
  })

  test("--reset prints what goes and removes the state directory", async () => {
    const { file } = await invitationFile(h, [h.root])
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    h.stop()
    await running
    const state = (await h.deps.store.load())!
    expect(await connect(["--reset"], h.deps)).toBe(0)
    expect(h.lines.join("\n")).toContain(`host id ${state.host_id} and its private key`)
    expect(h.lines.join("\n")).toContain(`enrollment ${state.enrollment?.enrollment_id} (invitation)`)
    expect(await fs.stat(h.deps.paths.dir).catch(() => "gone")).toBe("gone")
    expect(await connect([], h.deps)).toBe(78)
  })

  test("a second token file on an enrolled machine is refused with 78", async () => {
    const { file } = await invitationFile(h, [h.root])
    const running = connect(["--token-file", file], h.deps)
    await until(() => h.cp.beats().length >= 1, "first beat")
    h.stop()
    await running
    const again = await invitationFile(h, [h.root])
    expect(await connect(["--token-file", again.file], h.deps)).toBe(78)
    expect(h.lines.at(-1)).toContain("already enrolled")
  })
})

describe("desktop daemon discovery", () => {
  const record: DesktopDaemonDiscovery = { pid: 7, port: 8, token: "t", generation: "g", protocol: 1 }
  const text = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ service: "claxedo-local-daemon", protocol: 1, generation: "g", token: "t", pid: 7, port: 8, startedAt: "now", ...overrides })

  test("every channel's data dir is probed, CLAXEDO_DATA_DIR first", () => {
    expect(desktopDaemonDiscoveryFiles({ CLAXEDO_DATA_DIR: "/data" }, "/home/u")).toEqual([
      "/data/local-daemon.json",
      "/home/u/.claxedo/local-daemon.json",
      "/home/u/.claxedo-dev/local-daemon.json",
      "/home/u/.claxedo-beta/local-daemon.json",
    ])
    expect(desktopDaemonDiscoveryFiles({ CLAXEDO_DATA_DIR: "  " }, "/home/u")).toEqual([
      "/home/u/.claxedo/local-daemon.json",
      "/home/u/.claxedo-dev/local-daemon.json",
      "/home/u/.claxedo-beta/local-daemon.json",
    ])
    expect(desktopDaemonDiscoveryFiles({ CLAXEDO_DATA_DIR: "/home/u/.claxedo-dev" }, "/home/u")).toHaveLength(3)
  })

  test("only the daemon's own record, with a positive-integer pid and port and its token, parses", () => {
    expect(parseDesktopDaemonDiscovery(text())).toEqual(record)
    expect(parseDesktopDaemonDiscovery(text({ service: "other" }))).toBeUndefined()
    expect(parseDesktopDaemonDiscovery(text({ pid: "7" }))).toBeUndefined()
    expect(parseDesktopDaemonDiscovery(text({ pid: 0 }))).toBeUndefined()
    expect(parseDesktopDaemonDiscovery(text({ pid: 7.5 }))).toBeUndefined()
    expect(parseDesktopDaemonDiscovery(text({ port: 70_000 }))).toBeUndefined()
    expect(parseDesktopDaemonDiscovery(text({ port: -1 }))).toBeUndefined()
    expect(parseDesktopDaemonDiscovery(text({ token: "" }))).toBeUndefined()
    expect(parseDesktopDaemonDiscovery(text({ generation: undefined }))).toBeUndefined()
    expect(parseDesktopDaemonDiscovery("{not json")).toBeUndefined()
  })

  test("a missing file, an unparseable record, or a daemon that does not answer as itself is no daemon", async () => {
    const yes = async () => true
    const no = async () => false
    expect(await liveDesktopDaemon({ files: ["/f"], readFile: async () => undefined, verify: yes })).toBeUndefined()
    expect(await liveDesktopDaemon({ files: ["/f"], readFile: async () => text(), verify: no })).toBeUndefined()
    expect(await liveDesktopDaemon({ files: ["/f"], readFile: async () => text({ token: "" }), verify: yes })).toBeUndefined()
    expect(await liveDesktopDaemon({ files: ["/a", "/b"], readFile: async (file) => (file === "/b" ? text() : undefined), verify: yes })).toEqual({
      pid: 7,
      port: 8,
      file: "/b",
    })
    expect(await liveDesktopDaemon({ files: [path.join(os.tmpdir(), "claxedo-no-such-file", "local-daemon.json")] })).toBeUndefined()
  })

  test("verification is the daemon identity route answering with the file's identity for the file's token", async () => {
    const daemon = fakeDesktopDaemon({ pid: 4242, generation: "gen-1", token: "secret" })
    try {
      const live = { pid: 4242, port: daemon.port, token: "secret", generation: "gen-1", protocol: 1 }
      expect(await verifyDesktopDaemon(live)).toBe(true)
      expect(await verifyDesktopDaemon({ ...live, token: "wrong" }), "401").toBe(false)
      expect(await verifyDesktopDaemon({ ...live, pid: process.pid }), "another process holds the pid").toBe(false)
      expect(await verifyDesktopDaemon({ ...live, generation: "gen-0" }), "an older daemon's file").toBe(false)
      expect(await verifyDesktopDaemon({ ...live, protocol: 2 })).toBe(false)
      await daemon.stop()
      expect(await verifyDesktopDaemon(live), "nothing on the port").toBe(false)
    } finally {
      await daemon.stop()
    }
  })
})

describe("connect argument parsing", () => {
  test("reads every flag in both spellings and resolves paths", () => {
    expect(parseConnectArgs(["--token-file=/etc/x", "--root", "/srv", "--root=/opt", "--name", "box", "--foreground", "--alongside-desktop"])).toEqual({
      tokenFile: "/etc/x",
      roots: ["/srv", "/opt"],
      name: "box",
      installService: false,
      uninstallService: false,
      foreground: true,
      alongsideDesktop: true,
      reset: false,
      resetRoots: false,
    })
    expect(parseConnectArgs(["--reset-roots"]).resetRoots).toBe(true)
  })

  test("refuses unknown options, missing values, relative roots and contradictory flags", () => {
    expect(() => parseConnectArgs(["--detach"])).toThrow("Unknown connect option: --detach")
    expect(() => parseConnectArgs(["--token-file"])).toThrow("--token-file needs a value")
    expect(() => parseConnectArgs(["--root", "srv"])).toThrow("absolute")
    expect(() => parseConnectArgs(["--install-service", "--uninstall-service"])).toThrow("cannot be combined")
    expect(() => parseConnectArgs(["--reset", "--foreground"])).toThrow("--reset takes no other options")
    expect(() => parseConnectArgs(["--reset", "--alongside-desktop"])).toThrow("--reset takes no other options")
    expect(() => parseConnectArgs(["--reset", "--reset-roots"])).toThrow("--reset takes no other options")
    expect(() => parseConnectArgs(["--reset-roots", "--root", "/srv"])).toThrow("--reset-roots takes no other options")
  })
})

describe("exit-code mapping and bootstrap retry", () => {
  test("decisions are final; 5xx, rate limits and socket errors are transient", () => {
    expect(transientBootstrapFailure(new HostConnectDecisionError("no", {}))).toBe(false)
    expect(transientBootstrapFailure(new HostedHttpError(409, {}))).toBe(false)
    expect(transientBootstrapFailure(new HostedHttpError(503, {}))).toBe(true)
    expect(transientBootstrapFailure(new HostedHttpError(429, {}))).toBe(true)
    expect(transientBootstrapFailure(new TypeError("fetch failed"))).toBe(true)
    expect(transientBootstrapFailure(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(true)
    expect(transientBootstrapFailure(new Error("invitation token is not of the form"))).toBe(false)
  })

  test("retries with doubling delays, each attempt given the remaining budget as its deadline, until less than a second is left", async () => {
    let clock = 0
    const delays: number[] = []
    const attempts: Array<{ at: number; timeoutMs: number }> = []
    await expect(
      withBootstrapRetry(
        { monotonicNow: () => clock, sleep: async (ms) => { delays.push(ms); clock += ms }, log: () => undefined },
        "redeem",
        async ({ timeoutMs }) => {
          attempts.push({ at: clock, timeoutMs })
          throw new HostedHttpError(503, { error: { code: "deploying" } })
        },
      ),
    ).rejects.toThrow(/^redeem failed for 299s: HOSTED_HTTP 503/)
    expect(delays.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    expect(attempts.map((attempt) => attempt.timeoutMs)).toEqual(attempts.map((attempt) => 5 * 60_000 - attempt.at))
    expect(attempts.at(-1)!.at, "the last sleep was cut to leave exactly the minimum, and that attempt ran").toBe(5 * 60_000 - 1_000)
    expect(attempts.at(-1)!.timeoutMs).toBe(1_000)
    expect(delays.at(-1)).toBeLessThan(30_000)
    expect(clock, "nothing ran past the budget").toBeLessThanOrEqual(5 * 60_000)
  })

  test("the budget is wall-clock across attempts; a request that runs to its deadline never overruns the budget", async () => {
    let clock = 0
    const attempts: Array<{ at: number; timeoutMs: number }> = []
    const error = await withBootstrapRetry(
      { monotonicNow: () => clock, sleep: async (ms) => { clock += ms }, log: () => undefined },
      "acquire",
      async ({ timeoutMs }) => {
        attempts.push({ at: clock, timeoutMs })
        // The request honours the deadline it was given, capped at the transport's own 15 s.
        const ran = Math.min(15_000, timeoutMs)
        clock += ran
        throw new HostedRequestTimeoutError("/api/claxedo/host/enrollments/acquire", ran)
      },
    ).catch((e: unknown) => e)

    expect(String(error)).toMatch(/^Error: acquire failed for 300s: control plane did not answer POST/)
    expect(transientBootstrapFailure(new HostedRequestTimeoutError("/p", 1))).toBe(true)
    for (const attempt of attempts) {
      expect(attempt.timeoutMs, "the deadline handed to the request is what is left of the budget").toBe(5 * 60_000 - attempt.at)
      expect(attempt.at + Math.min(15_000, attempt.timeoutMs)).toBeLessThanOrEqual(5 * 60_000)
    }
    expect(attempts.at(-1)!.timeoutMs).toBeGreaterThanOrEqual(1_000)
    expect(clock).toBe(5 * 60_000)
  })

  test("an attempt that would start with less than a second of budget is not started", async () => {
    let clock = 0
    const attempts: number[] = []
    const error = await withBootstrapRetry(
      { monotonicNow: () => clock, sleep: async (ms) => { clock += ms }, log: () => undefined },
      "acquire",
      async () => {
        attempts.push(clock)
        // A slow first request that comes back with 900 ms of budget left.
        clock = 5 * 60_000 - 900
        throw new HostedHttpError(503, {})
      },
    ).catch((e: unknown) => e)

    expect(attempts).toEqual([0])
    expect(String(error)).toMatch(/^Error: acquire failed for 299s: HOSTED_HTTP 503/)
  })

  test("the beat interval is a third of the lease, capped at 20 s", () => {
    expect(BEAT_INTERVAL_MS).toBe(20_000)
  })

  test("the serving credential is the ack's hostTunnel verbatim, with the persisted relay as fallback", () => {
    const tunnel = { hostId: "host_1", hostTunnelToken: "t", tokenExpiresAt: 5, jti: "j", workspaceIds: ["ws"] }
    expect(servingCredential(tunnel, "https://relay")).toEqual({ hostId: "host_1", relayUrl: "https://relay", token: "t", workspaceIds: ["ws"], expiresAt: 5 })
    expect(servingCredential({ ...tunnel, relayUrl: "https://other" }, "https://relay")?.relayUrl).toBe("https://other")
    expect(servingCredential({ ...tunnel, workspaceIds: [] }, "https://relay")).toBeNull()
    expect(servingCredential(undefined, "https://relay")).toBeNull()
    expect(servingCredential(tunnel, undefined)).toBeNull()
  })
})
