import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { createBoatSandboxDriver, type BoatFetch } from "./boat"
import { createSandboxManager, isSandboxRuntimeBootFailure, type SandboxDriverEnsureInput } from ".."
import { createMemoryLeaseStore, sandboxLease } from "../stores/memory"

type Call = { path: string; method: string; headers: Record<string, string>; body?: any }

const ID = "bx_23456789"
const API = "https://boat.dev/api/v1"
const IMAGE = "ghcr.io/test/sandbox:1"

function ensureInput(overrides?: Partial<SandboxDriverEnsureInput>): SandboxDriverEnsureInput {
  return {
    workspaceId: "ws1",
    homeRegion: "eu",
    epoch: 1,
    labels: { app: "claxedo", workspaceId: "ws1", epoch: "1" },
    bootSource: { kind: "default" },
    workspaceRoot: "/workspace",
    workspaceRuntimePort: 2593,
    env: {},
    ...overrides,
  }
}

function sandboxRecord(state: string) {
  return {
    id: ID, name: "Sandbox 2026-10-03 12:00", state, url: "https://machine.on.boat.dev", ip: "203.0.113.10",
    createdAt: "2026-10-03T12:00:00Z", updatedAt: "2026-10-03T12:05:00Z", archiveAfter: null,
    desktopAvailable: true, snapshotAvailable: false, snapshotCompletedAt: null,
  }
}

function commandFinished(input: { stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean }) {
  const exitCode = input.exitCode === undefined ? 0 : input.exitCode
  return {
    type: "command.finished", success: exitCode === 0 && !input.timedOut, exitCode, stdout: input.stdout ?? "", stderr: input.stderr ?? "",
    timedOut: input.timedOut ?? false, signal: null, oomKilled: false, stdoutTruncated: false, stderrTruncated: false,
    cwd: "/home/user", startedAt: "2026-10-03T12:06:00Z", finishedAt: "2026-10-03T12:06:01Z",
  }
}

/**
 * The current Boat v1 API as documented at docs.boat.dev/api/v1: sandbox
 * creation → readiness polling → command execution (docker run / host /
 * health probe / host url). Records every call so tests can assert on it.
 */
function fakeBoat(options?: { states?: string[]; hostUrl?: string; failHealthOnce?: boolean; failingStderr?: string; containerState?: string }) {
  const calls: Call[] = []
  const states = options?.states ?? ["ready"]
  let stateIdx = 0
  let healthChecks = 0
  const hostUrl = options?.hostUrl ?? "https://machine-2593.on.boat.dev"

  const fetchImpl: BoatFetch = async (input, init) => {
    const path = input.replace(API, "")
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, method, headers: { ...init?.headers as Record<string, string> }, body })
    const json = (obj: object, status = 200) => Response.json({ ok: true, ...obj }, { status })

    if (path === "/sandboxes" && method === "POST") {
      return json({ type: "sandbox.created", status: "provisioning", ttlSeconds: body.ttlSeconds, sandbox: sandboxRecord("provisioning") }, 202)
    }
    if (path === `/sandboxes/${ID}` && method === "GET") {
      const state = states[Math.min(stateIdx, states.length - 1)]
      stateIdx++
      return json({ type: "sandbox.info", sandbox: sandboxRecord(state) })
    }
    if (path === `/sandboxes/${ID}/files` && method === "PUT") {
      return json({ type: "file.written", success: true, path: `/home/user/${body.path}`, encoding: "utf8", size: body.content.length })
    }
    if (path === `/sandboxes/${ID}/commands` && method === "POST") {
      const command: string = body.command
      if (options?.failingStderr) return json(commandFinished({ stderr: options.failingStderr, exitCode: 125 }))
      if (command.includes("/global/health")) {
        healthChecks++
        const healthy = options?.failHealthOnce ? healthChecks > 1 : true
        return json(commandFinished({ stdout: `${healthy ? "200" : "000"}\n${options?.containerState ?? "running"}` }))
      }
      if (command.startsWith("host url")) return json(commandFinished({ stdout: `${hostUrl}\n` }))
      return json(commandFinished({}))
    }
    if (path === `/sandboxes/${ID}/stop` && method === "POST") {
      return json({ type: "sandbox.stopping", id: ID, status: "archiving", sandbox: sandboxRecord("archiving") }, 202)
    }
    if (path === `/sandboxes/${ID}/resume` && method === "POST") {
      return json({ type: "sandbox.resuming", id: ID, status: "provisioning", sandbox: sandboxRecord("provisioning") }, 202)
    }
    if (path === `/sandboxes/${ID}` && method === "DELETE") {
      return json({ type: "sandbox.deleting", operation: { id: "op_1", kind: "sandbox", targetId: ID, status: "queued" } }, 202)
    }
    return Response.json({ ok: false, code: "not_found", message: `unhandled ${method} ${path}` }, { status: 404 })
  }
  return { fetchImpl, calls, get healthChecks() { return healthChecks } }
}

/**
 * Runs the driver's container start command under a real `sh`, with `docker`
 * and `timeout` replaced by a recorder over one container slot: `docker info`
 * fails until the daemon has been asked `daemonUpAfter` times, `inspect`
 * answers the slot's image, and `run` fills the slot unless Boat's own
 * recreation (`recreatedDuringRun`) fills it first and the create conflicts.
 */
function runStartCommand(command: string, vm: { existingImage?: string; daemonUpAfter?: number; recreatedDuringRun?: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "boat-start-"))
  const bin = path.join(dir, "bin")
  mkdirSync(bin)
  const log = path.join(dir, "docker.log")
  const slot = path.join(dir, "container")
  writeFileSync(log, "")
  writeFileSync(path.join(dir, ".claxedo-runtime-env"), "")
  if (vm.existingImage) writeFileSync(slot, vm.existingImage)
  const tool = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(path.join(bin, name), 0o755)
  }
  tool("timeout", 'shift\nexec "$@"')
  tool("docker", [
    `echo "$*" >> ${log}`,
    `case "$1" in`,
    `  info) n=$(($(cat ${dir}/info 2>/dev/null || echo 0) + 1)); echo $n > ${dir}/info; [ $n -gt ${vm.daemonUpAfter ?? 0} ] ;;`,
    `  inspect) cat ${slot} 2>/dev/null ;;`,
    `  rm) rm -f ${slot} ;;`,
    `  run) if [ -n "${vm.recreatedDuringRun ?? ""}" ]; then echo "${vm.recreatedDuringRun ?? ""}" > ${slot}; echo Conflict >&2; exit 125; fi; echo ${IMAGE} > ${slot} ;;`,
    `  start) [ -f ${slot} ] ;;`,
    `esac`,
  ].join("\n"))
  tool("sleep", "exit 0")
  const result = spawnSync("sh", ["-c", command], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" })
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").slice(0, 2).join(" "))
  return { status: result.status, calls, dir }
}

async function startCommand() {
  const boat = fakeBoat()
  const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
  await driver.ensureHost(ensureInput())
  const command = commandsOf(boat.calls).find((c) => c.includes("docker info"))
  if (!command) throw new Error("no container start command")
  return command
}

const commandsOf = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/commands")).map((c) => c.body.command as string)

describe("boat sandbox driver", () => {
  test.each(["transport", "http", "exit"] as const)("registry password cleanup %s failure prevents publishing the runtime", async (failure) => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({
      apiKey: "k",
      image: IMAGE,
      healthIntervalMs: 0,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.command === "rm -f .claxedo-registry-password") {
          if (failure === "transport") throw new Error("cleanup connection refused")
          if (failure === "http") return Response.json({ ok: false, code: "forbidden", message: "cleanup denied" }, { status: 403 })
          return Response.json({ ok: true, ...commandFinished({ exitCode: 1, stderr: "cleanup denied" }) })
        }
        return boat.fetchImpl(url, init)
      },
    })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow()
    expect(commandsOf(boat.calls).some((command) => command.startsWith("host "))).toBe(false)
  })

  test("persists a created sandbox before readiness polling and resumes it after manager restart", async () => {
    let store = createMemoryLeaseStore()
    const boat = fakeBoat({ states: ["provisioning", "ready"] })
    let observedId: string | undefined
    let observedStatus: string | undefined
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, provisionTimeoutMs: 0, provisionIntervalMs: 0,
      fetchImpl: async (url, init) => {
        if (url.endsWith(`/sandboxes/${ID}`) && (!init?.method || init.method === "GET")) {
          const lease = await store.get("ws1")
          observedId = lease?.sandboxId
          observedStatus = lease?.status
        }
        return boat.fetchImpl(url, init)
      } })
    const options = { leaseStore: store, driver, onEgressUnenforced: () => {} }
    expect((await createSandboxManager(options).ensure("ws1", { homeRegion: "eu" })).status).toBe("provisioning")
    expect(observedId).toBe(ID)
    expect(observedStatus).toBe("acquiring")
    expect((await store.get("ws1"))?.url).toBeUndefined()
    store = createMemoryLeaseStore(await store.list())
    expect((await createSandboxManager({ ...options, leaseStore: store }).ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(1)
    expect(boat.calls.filter((call) => call.path.endsWith("/resume"))).toHaveLength(0)
  })

  test("a failed readiness read retains the sandbox identity beyond acquisition staleness", async () => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat()
    let fail = true
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (url, init) => {
      if (fail && url.endsWith(`/sandboxes/${ID}`)) {
        fail = false
        return Response.json({ ok: false, code: "internal_error", message: "provider down" }, { status: 500 })
      }
      return boat.fetchImpl(url, init)
    } })
    const manager = createSandboxManager({ leaseStore: store, driver, staleAfterMs: 0, retryDelayMs: () => 0, onEgressUnenforced: () => {} })
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("unavailable")
    expect((await store.get("ws1"))?.sandboxId).toBe(ID)
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(1)
  })

  test("a lost create acknowledgement is retried under the same idempotency key", async () => {
    const boat = fakeBoat()
    let lost = true
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: async (url, init) => {
      if (lost && url.endsWith("/sandboxes")) {
        lost = false
        throw new Error("socket hang up")
      }
      return boat.fetchImpl(url, init)
    } })
    expect(await driver.ensureHost(ensureInput())).toMatchObject({ provisioning: true })
    expect(await driver.ensureHost(ensureInput())).toMatchObject({ sandboxId: ID })
    expect(boat.calls.filter((call) => call.path === "/sandboxes").map((call) => call.headers["Idempotency-Key"])).toEqual(["claxedo:ws1:1"])
  })

  test("a rejected resource write deletes the created sandbox, confirming its id, before propagating the handoff error", async () => {
    const boat = fakeBoat()
    const handoffError = new Error("epoch lost")
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    await expect(driver.ensureHost(ensureInput({ machineClass: "large", onResource: async () => { throw handoffError } }))).rejects.toBe(handoffError)
    expect(boat.calls.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
      { path: "/sandboxes", method: "POST", body: { noEnv: true, ttlSeconds: null, type: "large" } },
      { path: `/sandboxes/${ID}`, method: "DELETE", body: undefined },
    ])
    expect(boat.calls[1].headers).toMatchObject({ "X-Ascii-Confirm-Delete": ID, Authorization: "Bearer k" })
  })

  test.each(["transport", "http"])("a rejected resource write surfaces both handoff and deletion %s errors", async (failure) => {
    const boat = fakeBoat()
    const handoffError = new Error("epoch lost")
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (url, init) => {
      const response = await boat.fetchImpl(url, init)
      if (init?.method !== "DELETE") return response
      if (failure === "transport") throw new Error("delete connection refused")
      return Response.json({ ok: false, code: "forbidden", message: "delete denied for secret-path" }, { status: 403 })
    } })
    const error = await driver.ensureHost(ensureInput({ onResource: async () => { throw handoffError } })).then(
      () => { throw new Error("expected handoff to fail") },
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(AggregateError)
    const aggregate = error as AggregateError
    expect(aggregate.message).toMatch(new RegExp(`${ID}.*handoff.*delet`))
    expect(aggregate.errors).toHaveLength(2)
    expect(aggregate.errors[0]).toBe(handoffError)
    expect(aggregate.errors[1]).toMatchObject({ code: failure === "transport" ? "transport_failed" : "forbidden" })
    expect(aggregate.errors[1].message).not.toContain("secret-path")
  })

  test.each(["persistence failure", "lost epoch"])("manager resource handoff cleans up the sandbox after %s", async (failure) => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    const manager = createSandboxManager({
      driver,
      onEgressUnenforced: () => {},
      leaseStore: {
        ...store,
        async recordTarget(workspaceId, epoch, target) {
          if (failure === "persistence failure") throw new Error("storage unavailable")
          await store.acquire(workspaceId, { homeRegion: "eu", driver: "boat", staleAfterMs: 0 })
          return store.recordTarget(workspaceId, epoch, target)
        },
      },
    })
    expect(await manager.ensure("ws1", { homeRegion: "eu" })).toMatchObject({
      status: "unavailable",
      error: failure === "persistence failure" ? "storage unavailable" : "runtime_lease_changed",
    })
    expect((await store.get("ws1"))?.sandboxId).toBeUndefined()
    expect(boat.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/sandboxes" },
      { method: "DELETE", path: `/sandboxes/${ID}` },
    ])
  })

  test.each(["auth", "malformed", "wrong type", "boot", "missing"])("resume propagates %s failure without creating a replacement", async (failure) => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (url, init) => {
      if (failure === "auth" && url.endsWith("/resume")) return Response.json({ ok: false, code: "unauthorized", message: "Unauthorized" }, { status: 401 })
      if (failure === "missing" && url.endsWith("/resume")) return Response.json({ ok: false, code: "not_found", message: "gone" }, { status: 404 })
      if (failure === "malformed" && url.endsWith(`/sandboxes/${ID}`)) return Response.json({ ok: true, type: "sandbox.info" })
      if (failure === "wrong type" && url.endsWith(`/sandboxes/${ID}`)) return Response.json({ ok: true, type: "box.info", sandbox: sandboxRecord("ready") })
      if (failure === "boot" && url.endsWith("/commands")) return Response.json({ ok: true, ...commandFinished({ exitCode: 1, stderr: "boot failed" }) })
      return boat.fetchImpl(url, init)
    } })
    await expect(driver.resumeHost!({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: ensureInput(),
    })).rejects.toThrow()
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(0)
  })

  test("exposes relay metadata and boat identity", () => {
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async () => new Response("{}") })
    expect(driver.id).toBe("boat")
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
    })
  })

  test("boots a sandbox: create → poll ready → docker run → public host → health → url", async () => {
    const boat = fakeBoat({ states: ["provisioning", "ready"] })
    const driver = createBoatSandboxDriver({
      apiKey: "k",
      image: IMAGE,
      fetchImpl: boat.fetchImpl,
      provisionIntervalMs: 0,
      healthIntervalMs: 0,
      controlEnv: { managementJwksUrl: "https://api.example.test/.well-known/jwks.json" },
    })

    const target = await driver.ensureHost(ensureInput())
    if ("provisioning" in target) throw new Error("unexpected provisioning")
    expect(target.sandboxId).toBe(ID)
    expect(target.url).toBe("https://machine-2593.on.boat.dev")
    expect(target.driver).toEqual({ id: "boat", resourceId: ID })

    const create = boat.calls.find((c) => c.path === "/sandboxes" && c.method === "POST")
    expect(create?.body).toEqual({ noEnv: true, ttlSeconds: null })
    expect(create?.headers).toMatchObject({ "Idempotency-Key": "claxedo:ws1:1", Authorization: "Bearer k" })
    const run = boat.calls.find((c) => c.path.endsWith("/commands") && c.body.command.includes("docker run"))
    expect(run?.body.timeoutSeconds).toBe(600)
    expect(run?.body.command).toContain("ghcr.io/test/sandbox:1")
    expect(run?.body.command).toContain("docker run -d --init ")
    expect(run?.body.command).toContain("-p 2593:2593")
    expect(run?.body.command).toContain(".claxedo-runtime-env:/run/claxedo-runtime.env:ro")
    expect(run?.body.command).toContain(`-v "$(pwd)/claxedo-persistent/workspace":'/workspace'`)
    expect(run?.body.command).toContain(`-v "$(pwd)/claxedo-persistent/claxedo":'/root/.claxedo'`)
    expect(run?.body.command).toContain(`-v "$(pwd)/claxedo-persistent/workspace-runtime":'/root/.workspace-runtime'`)
    expect(run?.body.command).not.toContain("--env ")
    const envWrite = boat.calls.find((c) => c.path.endsWith("/files") && c.body?.path === ".claxedo-runtime-env")
    expect(envWrite?.body).toMatchObject({ encoding: "utf8" })
    expect(envWrite?.body?.content).toContain("export WORKSPACE_RUNTIME_WORKSPACE_ID='ws1'")
    expect(envWrite?.body?.content).toContain("export WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL='https://api.example.test/.well-known/jwks.json'")
    expect(commandsOf(boat.calls)).toContain("host 2593 --public")
    expect(commandsOf(boat.calls)).toContain("host url 2593 --public")
  })

  test("reports its image ready once the runtime container has started, before the runtime is published", async () => {
    const boat = fakeBoat({ states: ["ready"] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, provisionIntervalMs: 0, healthIntervalMs: 0 })
    let seen: string[] = []

    await driver.ensureHost({ ...ensureInput(), onImageReady: async () => { seen = commandsOf(boat.calls) } })

    expect(seen.some((command) => command.includes("docker run"))).toBe(true)
    expect(seen).not.toContain("host 2593 --public")
  })

  test("refuses a published URL that still carries Boat's access token", async () => {
    const boat = fakeBoat({ hostUrl: "https://machine-2593.on.boat.dev?_token=synthetic-host-token" })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
    const failure = await driver.ensureHost(ensureInput()).then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toMatch(/ungated HTTPS URL/)
    expect(failure?.message).not.toContain("synthetic-host-token")
  })

  test("a fresh VM waits for the Docker daemon, then creates the runtime container, leaving its bind sources for Docker to create", async () => {
    const run = runStartCommand(await startCommand(), { daemonUpAfter: 2 })
    expect(run.status).toBe(0)
    expect(run.calls).toEqual(["info", "info", "info", "inspect --format", "rm -f", "run -d"])
    expect(existsSync(path.join(run.dir, "claxedo-persistent"))).toBe(false)
  })

  test("a sandbox booted from an older image reads as outdated until its next start boots the deployment's image", async () => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat()
    const manager = (image: string) => createSandboxManager({
      leaseStore: store,
      driver: createBoatSandboxDriver({ apiKey: "k", image, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 }),
      onEgressUnenforced: () => {},
    })
    expect(await manager("ghcr.io/test/sandbox:0").ensure("ws1", { homeRegion: "eu" })).toMatchObject({ status: "ready", labels: { image: "ghcr.io/test/sandbox:0" } })

    const updated = manager(IMAGE)
    expect(await updated.target("ws1")).toMatchObject({ status: "ready", imageOutdated: true })
    expect(await updated.ensure("ws1", { homeRegion: "eu" })).toMatchObject({ status: "ready", labels: { image: IMAGE } })
    expect(await updated.target("ws1")).not.toHaveProperty("imageOutdated")
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(1)
  })

  test("a repeated start finds the container the first one created and only starts it", async () => {
    const run = runStartCommand(await startCommand(), { existingImage: IMAGE, daemonUpAfter: 1 })
    expect(run.status).toBe(0)
    expect(run.calls).toEqual(["info", "info", "inspect --format", "start claxedo-runtime"])
  })

  test("a container of another image is replaced by one of the image this boot names", async () => {
    const run = runStartCommand(await startCommand(), { existingImage: "ghcr.io/test/sandbox:0" })
    expect(run.status).toBe(0)
    expect(run.calls).toEqual(["info", "inspect --format", "rm -f", "run -d"])
  })

  test("a create that loses the race to Boat's recreation starts the container Boat recreated", async () => {
    const run = runStartCommand(await startCommand(), { recreatedDuringRun: IMAGE })
    expect(run.status).toBe(0)
    expect(run.calls).toEqual(["info", "inspect --format", "rm -f", "run -d", "inspect --format", "start claxedo-runtime"])
  })

  test("a create that fails for any other reason fails the start", async () => {
    const run = runStartCommand(await startCommand(), { recreatedDuringRun: "ghcr.io/test/sandbox:0" })
    expect(run.status).not.toBe(0)
    expect(run.calls).toEqual(["info", "inspect --format", "rm -f", "run -d", "inspect --format"])
  })

  test("keeps env values and registry credentials out of command strings", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({
      apiKey: "k",
      image: IMAGE,
      fetchImpl: boat.fetchImpl,
      healthIntervalMs: 0,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret", PEM: "-----BEGIN-----\nline2\n-----END-----" }),
    })

    const target = await driver.ensureHost(ensureInput({ env: { CALLER_SECRET: "synthetic-caller-secret" } }))
    if ("provisioning" in target) throw new Error("unexpected provisioning")

    const commands = commandsOf(boat.calls)
    for (const command of commands) {
      expect(command).not.toContain("synthetic-runtime-secret")
      expect(command).not.toContain("synthetic-caller-secret")
      expect(command).not.toContain("synthetic-registry-pw")
      expect(command).not.toContain("-----BEGIN-----")
    }

    const writes = boat.calls.filter((c) => c.path.endsWith("/files") && c.method === "PUT")
    const envWrite = writes.find((c) => c.body.path === ".claxedo-runtime-env")
    expect(envWrite?.body.content).toContain("export RUNTIME_SECRET='synthetic-runtime-secret'")
    expect(envWrite?.body.content).toContain("export CALLER_SECRET='synthetic-caller-secret'")
    expect(envWrite?.body.content).toContain("export PEM='-----BEGIN-----\nline2\n-----END-----'")
    const passwordWrite = writes.find((c) => c.body.path === ".claxedo-registry-password")
    expect(passwordWrite?.body.content).toBe("synthetic-registry-pw")

    const run = commands.find((c) => c.includes("docker run"))
    expect(run).toContain("--password-stdin < .claxedo-registry-password")
    expect(run).toContain("rm -f .claxedo-registry-password")
    expect(run).toContain("$(pwd)/.claxedo-runtime-env:/run/claxedo-runtime.env:ro")
  })

  test("a failed run reports docker's stderr with every staged secret redacted", async () => {
    const boat = fakeBoat({
      failingStderr: "docker: Error response from daemon: Conflict. env synthetic-runtime-secret login synthetic-registry-pw",
    })
    const driver = createBoatSandboxDriver({
      apiKey: "k",
      image: IMAGE,
      fetchImpl: boat.fetchImpl,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret" }),
    })

    const failure = await driver.ensureHost(ensureInput()).then(
      () => { throw new Error("expected ensure to fail") },
      (err: unknown) => err as AggregateError,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toHaveLength(2)
    expect(failure.errors[0].message).toContain("container start failed (exit 125): docker: Error response from daemon: Conflict.")
    expect(failure.errors[1].message).toContain("registry password cleanup")
    for (const error of failure.errors) {
      expect(error.message).toContain("[redacted]")
      expect(error.message).not.toContain("synthetic-runtime-secret")
      expect(error.message).not.toContain("synthetic-registry-pw")
    }
  })

  test("a command request outlasts its command, while other calls keep the client timeout", async () => {
    const boat = fakeBoat()
    const delayed = (match: (url: string, body: any) => boolean): BoatFetch => async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (match(url, body)) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 80)
          init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason) })
        })
      }
      return boat.fetchImpl(url, init)
    }
    const slowRun = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, operationTimeoutMs: 20,
      fetchImpl: delayed((_url, body) => body?.command?.includes("docker run")) })
    expect(await slowRun.ensureHost(ensureInput())).toMatchObject({ sandboxId: ID })
    const slowRead = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, operationTimeoutMs: 20,
      fetchImpl: delayed((url) => url.endsWith(`/sandboxes/${ID}`)) })
    await expect(slowRead.ensureHost(ensureInput())).rejects.toMatchObject({ code: "transport_failed" })
  })

  test("a sandbox deleted after a failed hand-off is never re-created under its idempotency key", async () => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat()
    let fail = true
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: boat.fetchImpl })
    const manager = createSandboxManager({ driver, onEgressUnenforced: () => {}, retryDelayMs: () => 0, leaseStore: { ...store,
      async recordTarget(workspaceId, epoch, target) {
        if (fail) {
          fail = false
          throw new Error("storage unavailable")
        }
        return store.recordTarget(workspaceId, epoch, target)
      } } })
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("unavailable")
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    expect(boat.calls.filter((call) => call.path === "/sandboxes").map((call) => call.headers["Idempotency-Key"])).toEqual(["claxedo:ws1:1", "claxedo:ws1:2"])
    expect(boat.calls.filter((call) => call.method === "DELETE")).toHaveLength(1)
  })

  test("a timed-out container start fails the boot", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (body?.command?.includes("docker run")) return Response.json({ ok: true, ...commandFinished({ exitCode: null, timedOut: true }) })
      return boat.fetchImpl(url, init)
    } })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow(/container start timed out/)
    expect(commandsOf(boat.calls).some((command) => command.startsWith("host "))).toBe(false)
  })

  test("retries the health probe until the runtime answers 200", async () => {
    const boat = fakeBoat({ failHealthOnce: true })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
    const target = await driver.ensureHost(ensureInput())
    if ("provisioning" in target) throw new Error("unexpected provisioning")
    expect(boat.healthChecks).toBeGreaterThanOrEqual(2)
  })

  test("a runtime container that exited fails the boot at the next probe, with its reason, instead of waiting out the health window", async () => {
    const boat = fakeBoat({ failHealthOnce: true, containerState: "exited" })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, healthTimeoutMs: 60_000, fetchImpl: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (body?.command?.includes("docker logs")) {
        return Response.json({ ok: true, ...commandFinished({ stdout: "status=exited exit=1 oom=false\n.claxedo/start.sh exited 1: bun install failed" }) })
      }
      return boat.fetchImpl(url, init)
    } })
    const failure = await driver.ensureHost(ensureInput()).catch((error: unknown) => error as Error)
    expect(isSandboxRuntimeBootFailure(failure)).toBe(true)
    expect((failure as Error).message).toContain("the runtime container is exited; status=exited exit=1 oom=false\n.claxedo/start.sh exited 1: bun install failed")
    expect(boat.healthChecks).toBe(1)
  })

  test("an unhealthy runtime reports bounded container diagnostics with staged secrets redacted", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthTimeoutMs: 0,
      env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret" }),
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.command?.includes("docker logs")) {
          expect(body.timeoutSeconds).toBe(10)
          expect(body.command).not.toContain("synthetic-runtime-secret")
          expect(body.command).not.toContain(".Config.Env")
          return Response.json({ ok: true, ...commandFinished({
            stdout: `status=exited exit=1 oom=false\n${"x".repeat(800)}\nStartup failed: synthetic-runtime-secret`,
          }) })
        }
        return boat.fetchImpl(url, init)
      },
    })
    const failure = await driver.ensureHost(ensureInput()).catch((error: unknown) => error as Error)
    expect(isSandboxRuntimeBootFailure(failure)).toBe(true)
    expect((failure as Error).message).toContain("Startup failed: [redacted]")
    expect((failure as Error).message).not.toContain("synthetic-runtime-secret")
    expect((failure as Error).message.length).toBeLessThan(750)
  })

  test("a failed diagnostic request preserves the health failure", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthTimeoutMs: 0,
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.command?.includes("docker logs")) throw new Error("transport leaked-secret")
        return boat.fetchImpl(url, init)
      },
    })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow("runtime did not become healthy: workspace runtime not ready; container diagnostics unavailable")
  })

  test("refuses an oversized acknowledgement, a redirect-capable or non-HTTPS endpoint, and never copies provider text", async () => {
    const huge = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async () => new Response("x".repeat(5 * 1024 * 1024)) })
    await expect(huge.ensureHost(ensureInput())).rejects.toMatchObject({ code: "invalid_response" })
    let redirect: RequestRedirect | undefined
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (_url, init) => {
      redirect = init?.redirect
      return Response.json({ ok: false, code: "unauthorized", message: "Unauthorized key boat_secret" }, { status: 401 })
    } })
    const error = await driver.ensureHost(ensureInput()).then(
      () => { throw new Error("expected ensure to fail") },
      (cause: unknown) => cause as Error,
    )
    expect(redirect).toBe("manual")
    expect(error).toMatchObject({ code: "unauthorized", status: 401 })
    expect(error.message).not.toContain("boat_secret")
    for (const baseUrl of ["http://boat.dev/api/v1", "https://user:secret@boat.dev/api/v1", "https://boat.dev/api/v1?secret=x"]) {
      expect(() => createBoatSandboxDriver({ apiKey: "k", image: IMAGE, baseUrl })).toThrow(/HTTPS/)
    }
  })

  test.each([301, 302, 303, 307, 308])("a %s redirect is a refusal, never followed with the key", async (status) => {
    const calls: string[] = []
    const driver = createBoatSandboxDriver({ apiKey: "boat_secret", image: IMAGE, fetchImpl: async (url, init) => {
      calls.push(url)
      expect(init?.redirect).toBe("manual")
      return new Response(null, { status, headers: { Location: "https://other.example/collect" } })
    } })
    await expect(driver.ensureHost(ensureInput())).rejects.toMatchObject({ code: `http_${status}`, status })
    expect(calls).toEqual([`${API}/sandboxes`])
  })

  test("option-like image identifiers are rejected before the docker run", async () => {
    for (const bad of ["--privileged", "-v/host:/host", "img:test --network=host"]) {
      const boat = fakeBoat()
      const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
      await expect(
        driver.ensureHost(ensureInput({ bootSource: { kind: "image", image: bad } })),
      ).rejects.toThrow(/image reference/)
      expect(boat.calls.some((c) => c.path.endsWith("/commands"))).toBe(false)
    }
    const boat = fakeBoat()
    const badOptions = createBoatSandboxDriver({ apiKey: "k", image: "--network=host", fetchImpl: boat.fetchImpl })
    await expect(badOptions.ensureHost(ensureInput())).rejects.toThrow(/image reference/)
    expect(boat.calls.some((c) => c.path.endsWith("/commands"))).toBe(false)
  })

  test("rejects restricted network policy", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    await expect(
      driver.ensureHost(ensureInput({ net: { mode: "restricted", hosts: ["example.com"] } })),
    ).rejects.toThrow(/network policy/)
  })

  test("stop archives and destroy deletes the sandbox", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    const target = { workspaceId: "ws1", sandboxId: ID, url: "https://x", hostId: "boat-ws1" }
    await driver.stop?.(target)
    await driver.destroy?.(target)
    expect(boat.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: `/sandboxes/${ID}/stop` },
      { method: "DELETE", path: `/sandboxes/${ID}` },
    ])
  })

  test("resume brings the same sandbox back and re-establishes the runtime", async () => {
    const boat = fakeBoat({ states: ["provisioning", "ready"] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0, provisionIntervalMs: 0 })
    const target = await driver.resumeHost?.({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: ensureInput(),
    })
    if (!target || "provisioning" in target) throw new Error("unexpected provisioning")
    expect(target.sandboxId).toBe(ID)
    expect(boat.calls.find((c) => c.path === `/sandboxes/${ID}/resume`)?.body).toEqual({ noEnv: true, ttlSeconds: null })
  })
})
