import { describe, expect, test } from "vitest"
import { createBoxSandboxDriver, type BoxFetch } from "./box"
import { createSandboxManager, type SandboxDriverEnsureInput } from ".."
import { createMemoryLeaseStore, sandboxLease } from "../stores/memory"

type Call = { path: string; method: string; body?: any }

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

/**
 * Simulates the Box REST API: box creation → ready state → command execution
 * (docker run / host / health probe / host url). Records every call so tests
 * can assert on the boot sequence.
 */
function fakeBox(options?: { states?: string[]; hostUrl?: string; failHealthOnce?: boolean; failCommandsEchoing?: boolean }) {
  const calls: Call[] = []
  const states = options?.states ?? ["ready"]
  let stateIdx = 0
  let healthChecks = 0
  const hostUrl = options?.hostUrl ?? "https://sub-2593.on.ascii.dev?_token=tok"

  const fetchImpl: BoxFetch = async (input, init) => {
    const path = input.replace("https://ascii.dev/api/box/v1", "")
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, method, body })

    const json = (obj: unknown) =>
      new Response(JSON.stringify({ ok: true, ...(obj as object) }), { status: 200 })

    if (path === "/boxes" && method === "POST") {
      return json({ type: "box.created", box: { id: "bx_abc123", state: "provisioning" } })
    }
    if (path === "/boxes/bx_abc123" && method === "GET") {
      const state = states[Math.min(stateIdx, states.length - 1)]
      stateIdx++
      return json({ box: { id: "bx_abc123", state } })
    }
    if (path === "/boxes/bx_abc123/files" && method === "PUT") {
      return json({ type: "file.written", path: body.path })
    }
    if (path === "/boxes/bx_abc123/commands" && method === "POST") {
      const command: string = body.command
      if (options?.failCommandsEchoing) {
        // Worst-case diagnostics: stderr mirrors the command that failed.
        return json({ stdout: "", stderr: command, exitCode: 1 })
      }
      if (command.includes("/global/health")) {
        healthChecks++
        const healthy = options?.failHealthOnce ? healthChecks > 1 : true
        return json({ stdout: healthy ? "200" : "000", stderr: "", exitCode: 0 })
      }
      if (command.startsWith("host url")) {
        return json({ stdout: `${hostUrl}\n`, stderr: "", exitCode: 0 })
      }
      return json({ stdout: "", stderr: "", exitCode: 0 })
    }
    if (path === "/boxes/bx_abc123/stop" && method === "POST") return json({ type: "box.archiving" })
    if (path === "/boxes/bx_abc123/resume" && method === "POST") return json({ type: "box.resumed" })
    if (path === "/boxes/bx_abc123" && method === "DELETE") return json({ type: "box.deleted" })
    return new Response(JSON.stringify({ ok: false, error: `unhandled ${method} ${path}` }), { status: 404 })
  }
  return { fetchImpl, calls, get healthChecks() { return healthChecks } }
}

describe("box sandbox driver", () => {
  test.each(["transport", "http", "exit"] as const)("registry password cleanup %s failure prevents publishing the runtime", async (failure) => {
    const box = fakeBox()
    const error = new Error("cleanup connection refused")
    const driver = createBoxSandboxDriver({
      apiKey: "k",
      healthIntervalMs: 0,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.command === "rm -f .claxedo-registry-password") {
          if (failure === "transport") throw error
          if (failure === "http") return Response.json({ error: "cleanup denied" }, { status: 403 })
          return Response.json({ ok: true, exitCode: 1, stderr: "cleanup denied" })
        }
        return box.fetchImpl(url, init)
      },
    })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow(/cleanup/)
    expect(box.calls.some((call) => call.body?.command?.startsWith("host "))).toBe(false)
  })

  test("persists a created box before readiness polling and resumes it after manager restart", async () => {
    let store = createMemoryLeaseStore()
    const box = fakeBox({ states: ["provisioning", "ready"] })
    let observedId: string | undefined
    let observedStatus: string | undefined
    const driver = createBoxSandboxDriver({ apiKey: "k", provisionTimeoutMs: 0, provisionIntervalMs: 0,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/boxes/bx_abc123") && (!init?.method || init.method === "GET")) {
          const lease = await store.get("ws1")
          observedId = lease?.sandboxId
          observedStatus = lease?.status
        }
        return box.fetchImpl(url, init)
      } })
    const options = { leaseStore: store, driver, onEgressUnenforced: () => {} }
    expect((await createSandboxManager(options).ensure("ws1", { homeRegion: "eu" })).status).toBe("provisioning")
    expect(observedId).toBe("bx_abc123")
    expect(observedStatus).toBe("acquiring")
    expect((await store.get("ws1"))?.url).toBeUndefined()
    store = createMemoryLeaseStore(await store.list())
    expect((await createSandboxManager({ ...options, leaseStore: store }).ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    expect(box.calls.filter((call) => call.path === "/boxes" && call.method === "POST")).toHaveLength(1)
    expect(box.calls.filter((call) => call.path.endsWith("/resume"))).toHaveLength(0)
  })

  test("a failed readiness read retains the Box identity beyond acquisition staleness", async () => {
    const store = createMemoryLeaseStore()
    const box = fakeBox()
    let fail = true
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: async (url, init) => {
      if (fail && url.endsWith("/boxes/bx_abc123")) {
        fail = false
        return Response.json({ error: "provider down" }, { status: 500 })
      }
      return box.fetchImpl(url, init)
    } })
    const manager = createSandboxManager({ leaseStore: store, driver, staleAfterMs: 0, retryDelayMs: () => 0, onEgressUnenforced: () => {} })
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("unavailable")
    expect((await store.get("ws1"))?.sandboxId).toBe("bx_abc123")
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    expect(box.calls.filter((call) => call.path === "/boxes" && call.method === "POST")).toHaveLength(1)
  })

  test("a rejected resource write prevents readiness polling", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl })
    await expect(driver.ensureHost(ensureInput({ onResource: async () => { throw new Error("epoch lost") } }))).rejects.toThrow("epoch lost")
    expect(box.calls).toHaveLength(1)
    expect(box.calls[0].path).toBe("/boxes")
  })

  test.each(["auth", "malformed", "boot", "missing"])("resume propagates %s failure without creating a replacement", async (failure) => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: async (url, init) => {
      if (failure === "auth" && url.endsWith("/resume")) return Response.json({ error: "denied" }, { status: 401 })
      if (failure === "missing" && url.endsWith("/resume")) return Response.json({ error: "gone" }, { status: 404 })
      if (failure === "malformed" && url.endsWith("/boxes/bx_abc123")) return Response.json({ ok: true })
      if (failure === "boot" && url.endsWith("/commands")) return Response.json({ exitCode: 1, stderr: "boot failed" })
      return box.fetchImpl(url, init)
    } })
    await expect(driver.resumeHost!({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: "bx_abc123", hostId: "box-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: ensureInput(),
    })).rejects.toThrow()
    expect(box.calls.filter((call) => call.path === "/boxes" && call.method === "POST")).toHaveLength(0)
  })

  test("exposes relay metadata and box identity", () => {
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: async () => new Response("{}") })
    expect(driver.id).toBe("box")
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
    })
  })

  test("boots a box: create → poll ready → docker run → host → health → url", async () => {
    const box = fakeBox({ states: ["provisioning", "ready"] })
    const driver = createBoxSandboxDriver({
      apiKey: "k",
      image: "ghcr.io/test/sandbox:1",
      fetchImpl: box.fetchImpl,
      provisionIntervalMs: 0,
      healthIntervalMs: 0,
    })

    const target = await driver.ensureHost(ensureInput())
    expect("provisioning" in target).toBe(false)
    if ("provisioning" in target) throw new Error("unexpected provisioning")

    expect(target.sandboxId).toBe("bx_abc123")
    expect(target.url).toBe("https://sub-2593.on.ascii.dev?_token=tok")
    expect(target.driver).toEqual({ id: "box", resourceId: "bx_abc123" })

    const commands = box.calls.filter((c) => c.path.endsWith("/commands")).map((c) => c.body.command as string)
    const dockerRun = commands.find((c) => c.includes("docker run"))
    expect(dockerRun).toContain("ghcr.io/test/sandbox:1")
    expect(dockerRun).toContain("-p 2593:2593")
    expect(dockerRun).toContain(".claxedo-runtime-env:/run/claxedo-runtime.env:ro")
    expect(dockerRun).not.toContain("--env ")
    const envWrite = box.calls.find((c) => c.path.endsWith("/files") && c.body?.path === ".claxedo-runtime-env")
    expect(envWrite?.body?.content).toContain("export WORKSPACE_RUNTIME_WORKSPACE_ID='ws1'")
    expect(commands.some((c) => c === "host 2593")).toBe(true)
    expect(commands.some((c) => c === "host url 2593")).toBe(true)
  })

  test("keeps env values and registry credentials out of command strings", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({
      apiKey: "k",
      fetchImpl: box.fetchImpl,
      healthIntervalMs: 0,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret", PEM: "-----BEGIN-----\nline2\n-----END-----" }),
    })

    const target = await driver.ensureHost(ensureInput({ env: { CALLER_SECRET: "synthetic-caller-secret" } }))
    if ("provisioning" in target) throw new Error("unexpected provisioning")

    const commands = box.calls.filter((c) => c.path.endsWith("/commands")).map((c) => c.body.command as string)
    for (const command of commands) {
      expect(command).not.toContain("synthetic-runtime-secret")
      expect(command).not.toContain("synthetic-caller-secret")
      expect(command).not.toContain("synthetic-registry-pw")
      expect(command).not.toContain("-----BEGIN-----")
    }

    // The sanctioned channels carry the values: env through a private file the
    // container sources, the registry password through a file consumed by
    // `docker login --password-stdin` and then removed.
    const writes = box.calls.filter((c) => c.path.endsWith("/files") && c.method === "PUT")
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

  test("a failed run cannot echo secrets back through diagnostics", async () => {
    const box = fakeBox({ failCommandsEchoing: true })
    const driver = createBoxSandboxDriver({
      apiKey: "k",
      fetchImpl: box.fetchImpl,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret" }),
    })

    const failure = await driver.ensureHost(ensureInput()).then(
      () => { throw new Error("expected ensure to fail") },
      (err: unknown) => err as Error,
    )
    expect(failure.message).toContain("docker run")
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as AggregateError).errors[1].message).toContain("registry password cleanup")
    expect(failure.message).not.toContain("synthetic-runtime-secret")
    expect(failure.message).not.toContain("synthetic-registry-pw")
  })

  test("retries the health probe until the runtime answers 200", async () => {
    const box = fakeBox({ failHealthOnce: true })
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl, healthIntervalMs: 0 })
    const target = await driver.ensureHost(ensureInput())
    if ("provisioning" in target) throw new Error("unexpected provisioning")
    expect(box.healthChecks).toBeGreaterThanOrEqual(2)
  })

  test("passes ttlSeconds:null by default so the manager owns the lifecycle", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl, healthIntervalMs: 0 })
    await driver.ensureHost(ensureInput())
    const create = box.calls.find((c) => c.path === "/boxes" && c.method === "POST")
    expect(create?.body).toEqual({ ttlSeconds: null })
  })

  test("option-like image identifiers are rejected before the box docker run", async () => {
    for (const bad of ["--privileged", "-v/host:/host", "img:test --network=host"]) {
      const box = fakeBox()
      const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl, healthIntervalMs: 0 })
      await expect(
        driver.ensureHost(ensureInput({ bootSource: { kind: "image", image: bad } })),
      ).rejects.toThrow(/image reference/)
      // The guard fires while building the run script — no command ever reaches the box.
      expect(box.calls.some((c) => c.path.endsWith("/commands"))).toBe(false)
    }
    // Same guard on the configured/env image path.
    const box = fakeBox()
    const badOptions = createBoxSandboxDriver({ apiKey: "k", image: "--network=host", fetchImpl: box.fetchImpl })
    await expect(badOptions.ensureHost(ensureInput())).rejects.toThrow(/image reference/)
    expect(box.calls.some((c) => c.path.endsWith("/commands"))).toBe(false)
  })

  test("rejects restricted network policy", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl })
    await expect(
      driver.ensureHost(ensureInput({ net: { mode: "restricted", hosts: ["example.com"] } })),
    ).rejects.toThrow(/network policy/)
  })

  test("stop archives and destroy deletes the box", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl })
    const target = {
      workspaceId: "ws1",
      sandboxId: "bx_abc123",
      url: "https://x",
      hostId: "box-ws1",
    }
    await driver.stop?.(target)
    await driver.destroy?.(target)
    expect(box.calls.some((c) => c.path === "/boxes/bx_abc123/stop" && c.method === "POST")).toBe(true)
    expect(box.calls.some((c) => c.path === "/boxes/bx_abc123" && c.method === "DELETE")).toBe(true)
  })

  test("resume brings the same box back and re-establishes the runtime", async () => {
    const box = fakeBox()
    const driver = createBoxSandboxDriver({ apiKey: "k", fetchImpl: box.fetchImpl, healthIntervalMs: 0 })
    const target = await driver.resumeHost?.({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: "bx_abc123", hostId: "box-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: ensureInput(),
    })
    if (!target || "provisioning" in target) throw new Error("unexpected provisioning")
    expect(target.sandboxId).toBe("bx_abc123")
    expect(box.calls.some((c) => c.path === "/boxes/bx_abc123/resume" && c.method === "POST")).toBe(true)
  })
})
