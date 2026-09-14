import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHostRuntimeListener, type HostRuntimeListener } from "@claxedo/host-serving/runtime"
import { setUserHostedServing, stopUserHostedServing, userHostedServingState } from "@claxedo/host-serving/serving"
import { parseConnectArgs } from "../connect/args"
import { createFakeConnectControlPlane, decodeFakeTunnelToken, type FakeControlPlane } from "../connect/fake-control-plane.test-support"
import { BEAT_INTERVAL_MS, servingCredential, transientBootstrapFailure, withBootstrapRetry, type HostDeps } from "../connect/host"
import { connectPaths, connectStateStore } from "../connect/paths"
import type { ServiceDeps } from "../connect/service"
import { HostedHttpError } from "@claxedo/host-connector/machine-transport"
import { HostConnectDecisionError } from "@claxedo/host-connector/bootstrap"
import { connect, type ConnectDeps } from "./connect"
import { hostOnline, statusLines } from "./status"

/**
 * The real `connect` command function against the strict fake control plane,
 * the real host runtime listener, the real serving loop and a relay stub that
 * accepts host tunnels and records the credential each one presents. Beats
 * and the stop signal are driven by hand.
 */

type RelaySocket = { token: string; workspaceIds: string[]; closed: boolean }

function relayStub() {
  const sockets: RelaySocket[] = []
  const server = Bun.serve<RelaySocket>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith("/host-tunnels/")) return new Response("not a tunnel", { status: 404 })
      const data: RelaySocket = {
        token: (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
        workspaceIds: url.searchParams.getAll("workspaceId"),
        closed: false,
      }
      return bun.upgrade(request, { data }) ? undefined : new Response("upgrade failed", { status: 400 })
    },
    websocket: {
      open(ws) {
        sockets.push(ws.data)
      },
      message() {},
      close(ws) {
        ws.data.closed = true
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    sockets,
    stop: () => server.stop(true),
  }
}

async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000) {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
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

function serviceDeps(home: string, calls: string[]): ServiceDeps {
  return {
    platform: "linux",
    homedir: home,
    command: ["/usr/bin/node", "/opt/claxedo/index.mjs"],
    claxedoHome: home,
    run: async (file, args) => {
      calls.push([file, ...args].join(" "))
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
    onStopSignal: (fn) => {
      stop = fn
      return () => undefined
    },
    now: () => Date.now(),
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
    h.cp.revoke((await h.deps.store.load())!.host_id)
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
      "systemctl --user daemon-reload",
      "systemctl --user enable --now claxedo-connect.service",
    ])
    expect((await h.deps.store.load())?.service).toEqual({ kind: "systemd-user", unit, installed_at: 1_700_000_000_000 })
    expect(h.lines.some((line) => line.includes("loginctl enable-linger"))).toBe(true)
    expect(h.cp.beats()).toHaveLength(0)

    expect(await connect(["--uninstall-service"], h.deps)).toBe(0)
    expect(await fs.readFile(unit, "utf8").catch(() => "gone")).toBe("gone")
    expect((await h.deps.store.load())?.service).toBeUndefined()
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

describe("connect argument parsing", () => {
  test("reads every flag in both spellings and resolves paths", () => {
    expect(parseConnectArgs(["--token-file=/etc/x", "--root", "/srv", "--root=/opt", "--name", "box", "--foreground"])).toEqual({
      tokenFile: "/etc/x",
      roots: ["/srv", "/opt"],
      name: "box",
      installService: false,
      uninstallService: false,
      foreground: true,
      reset: false,
    })
  })

  test("refuses unknown options, missing values, relative roots and contradictory flags", () => {
    expect(() => parseConnectArgs(["--detach"])).toThrow("Unknown connect option: --detach")
    expect(() => parseConnectArgs(["--token-file"])).toThrow("--token-file needs a value")
    expect(() => parseConnectArgs(["--root", "srv"])).toThrow("absolute")
    expect(() => parseConnectArgs(["--install-service", "--uninstall-service"])).toThrow("cannot be combined")
    expect(() => parseConnectArgs(["--reset", "--foreground"])).toThrow("--reset takes no other options")
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

  test("retries with doubling delays until the five-minute budget, then fails with the last error", async () => {
    let clock = 0
    const delays: number[] = []
    const attempts: number[] = []
    await expect(
      withBootstrapRetry(
        { now: () => clock, sleep: async (ms) => { delays.push(ms); clock += ms }, log: () => undefined },
        "redeem",
        async () => {
          attempts.push(clock)
          throw new HostedHttpError(503, { error: { code: "deploying" } })
        },
      ),
    ).rejects.toThrow(/^redeem failed for \d+s: HOSTED_HTTP 503/)
    expect(delays.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(5 * 60_000)
    expect(delays.reduce((sum, ms) => sum + ms, 0) + 30_000).toBeGreaterThan(5 * 60_000)
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
