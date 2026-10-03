import { beforeEach, describe, expect, test, vi } from "vitest"

// The real SDK pulls in `cloudflare:workers`, which does not exist outside
// workerd — so the container/DO layer is stubbed and this suite covers the
// Worker's OWN registry logic: what it records on ensure, what it drops on
// destroy, and what `GET /sandboxes` reports. That registry is the only way a
// Cloudflare sandbox can be enumerated (DO namespaces are not listable), so it
// is what the control plane's GC sweep depends on.
const backupIdFor = (dir: string) => dir === "/workspace" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002"
const sandboxStub = {
  setCredentialHosts: vi.fn(async (_sandboxId: string, _hosts: readonly string[]) => {}),
  ensureWorkspaceRuntime: vi.fn(async (
    _command: string,
    _env: Record<string, string>,
    _port: number,
    _options: { reuseRunning: boolean },
  ): Promise<{ state: "ready" } | { state: "preparing" } | { state: "exited"; reason: string }> => ({ state: "ready" })),
  workspaceRuntimeReady: vi.fn(async () => true),
  configureWorkspaceIdle: vi.fn(async (_idle: { workspaceId: string; epoch: number; port: number; idleMs: number }) => "health-token"),
  watchWorkspaceIdle: vi.fn(async () => {}),
  stopWorkspace: vi.fn(async (epoch: number, _committed?: string) => epoch === 1),
  captureBackups: vi.fn(async (_directories: readonly string[], _committed?: string) => `${backupIdFor("/workspace")},${backupIdFor("/home")}`),
  deleteCheckpointBackups: vi.fn(async (_ids: readonly string[]) => {}),
  destroy: vi.fn(async () => {}),
  restoreBackup: vi.fn(async () => {}),
  containerFetch: vi.fn(async () => new Response("ok")),
  wsConnect: vi.fn(async (_request: Request, _port: number) => new Response("ok")),
}
const getSandboxMock = vi.fn(() => sandboxStub)
const lifecycle: string[] = []

// `@cloudflare/containers` cannot be imported outside workerd (its module scope
// pulls `cloudflare:workers`), so the base class keeps only what the subclass
// extends: the object state it was built with and the two start paths.
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: getSandboxMock,
  Sandbox: class Sandbox {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
    async start() { lifecycle.push("start") }
    async startAndWaitForPorts() { lifecycle.push("startAndWaitForPorts") }
  },
}))
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}))

const { default: worker, CredentialEgress, Sandbox, ensureRuntimeProcess } = await import("./index")

type Metadata = Record<string, string>

// Fake R2 with real cursor pagination, so the listing loop's termination is
// exercised rather than assumed.
function fakeR2(seed: Array<[string, Metadata]> = []) {
  const store = new Map<string, Metadata>(seed)
  return {
    store,
    async put(key: string, _value: unknown, options?: { customMetadata?: Metadata }) {
      store.set(key, options?.customMetadata ?? {})
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list({ prefix = "", cursor, limit = 1_000 }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const page = keys.slice(start, start + limit)
      const end = start + page.length
      const truncated = end < keys.length
      return {
        objects: page.map((key) => ({ key, customMetadata: store.get(key) })),
        truncated,
        ...(truncated ? { cursor: String(end) } : {}),
      }
    },
  }
}

function env(overrides: Record<string, unknown> = {}) {
  return { Sandbox: {}, API_TOKEN: "tok", CONTROL_PLANE_URL: "https://control.test", IDLE_STOP_TOKEN: "idle-token", BACKUP_BUCKET: fakeR2(), ...overrides } as never
}

function call(path: string, workerEnv: never, init: RequestInit = {}) {
  if (path.endsWith("/ensure-runtime") && typeof init.body === "string") {
    const body = JSON.parse(init.body) as { labels?: Record<string, string> }
    init = { ...init, body: JSON.stringify({ ...body, labels: { workspaceId: "ws_test", epoch: "1", ...body.labels } }) }
  }
  return worker.fetch(
    new Request(`https://sbx.test${path}`, {
      ...init,
      headers: {
        authorization: "Bearer tok",
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(init.headers)),
      },
    }),
    workerEnv,
  )
}

function ensureBody(labels: Record<string, string>) {
  return JSON.stringify({ command: "/usr/local/bin/workspace-runtime", env: {}, labels })
}

describe("cloudflare sandbox Worker registry (W1.2)", () => {
  beforeEach(() => {
    getSandboxMock.mockClear()
    sandboxStub.ensureWorkspaceRuntime.mockClear()
    sandboxStub.destroy.mockClear()
  })

  test("configures a cold-start budget that the Worker's own bounds do not preempt", async () => {
    await call("/sandbox/claxedo-cold-start/ensure-runtime", env(), {
      method: "POST",
      body: ensureBody({ app: "claxedo", workspaceId: "cold-start", epoch: "1" }),
    })

    expect(getSandboxMock).toHaveBeenCalledWith(expect.anything(), "claxedo-cold-start", {
      containerTimeouts: {
        instanceGetTimeoutMS: 60_000,
        portReadyTimeoutMS: 180_000,
      },
    })
  })

  test("ensure-runtime hands the sandbox exactly the hosts its registrations name, before the runtime starts", async () => {
    sandboxStub.setCredentialHosts.mockClear()
    await call("/sandbox/handler-name/ensure-runtime", env({
      EGRESS_SECRETS: { get: async () => null, put: async () => {}, delete: async () => {} },
    }), {
      method: "POST",
      body: JSON.stringify({
        command: "runtime",
        env: {},
        egress: [{ name: "KEY", hosts: ["api.vendor.test"], header: "Authorization", value: "Bearer v", methods: ["POST"], pathPrefixes: ["/v1"] }],
      }),
    })
    expect(sandboxStub.setCredentialHosts).toHaveBeenLastCalledWith("handler-name", ["api.vendor.test"])
    expect(sandboxStub.setCredentialHosts.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sandboxStub.ensureWorkspaceRuntime.mock.invocationCallOrder.at(-1)!,
    )
  })

  test("ensure-runtime records the sandbox, and GET /sandboxes enumerates it", async () => {
    const workerEnv = env()

    const ensure = await call("/sandbox/claxedo-ws_1/ensure-runtime", workerEnv, {
      method: "POST",
      body: ensureBody({ app: "claxedo", workspaceId: "ws_1", epoch: "7" }),
    })
    expect(ensure.status).toBe(200)

    const listed = await call("/sandboxes", workerEnv)
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toEqual({
      supported: true,
      sandboxes: [{ sandboxId: "claxedo-ws_1", app: "claxedo", workspaceId: "ws_1", epoch: "7" }],
    })
  })

  test("a runtime whose boot failed answers ensure-runtime with that reason as an exit, not as one still starting", async () => {
    const workerEnv = env()
    sandboxStub.ensureWorkspaceRuntime.mockResolvedValueOnce({ state: "exited", reason: "fatal: couldn't find remote ref refs/heads/missing" })

    const ensure = await call("/sandbox/claxedo-ws_9/ensure-runtime", workerEnv, {
      method: "POST",
      body: ensureBody({ app: "claxedo", workspaceId: "ws_9", epoch: "1" }),
    })

    expect(ensure.status).toBe(502)
    await expect(ensure.json()).resolves.toEqual({ ready: false, exited: true, error: "fatal: couldn't find remote ref refs/heads/missing" })
    await expect(call("/sandboxes", workerEnv).then((res) => res.json())).resolves.toEqual({ supported: true, sandboxes: [] })
  })

  test("labels are capped, so one oversized label cannot make a sandbox unregisterable", async () => {
    // R2 customMetadata is ~2KB. An unregisterable sandbox is an INVISIBLE
    // sandbox, which is the exact orphan this registry exists to surface — so
    // unknown/oversized labels are dropped rather than allowed to fail the write.
    const workerEnv = env()

    await call("/sandbox/claxedo-ws_2/ensure-runtime", workerEnv, {
      method: "POST",
      body: ensureBody({ app: "claxedo", workspaceId: "ws_2", epoch: "1", huge: "x".repeat(5_000) }),
    })

    const body = await call("/sandboxes", workerEnv).then((res) => res.json()) as {
      sandboxes: Array<Record<string, string>>
    }
    expect(body.sandboxes).toHaveLength(1)
    expect(body.sandboxes[0]).not.toHaveProperty("huge")
    expect(body.sandboxes[0]).toMatchObject({ sandboxId: "claxedo-ws_2", app: "claxedo", workspaceId: "ws_2" })
  })

  test("a failed registry write does not fail ensure-runtime", async () => {
    // A user's workspace must not be stranded because the registry is unwell.
    // The cost of the degraded path is one invisible sandbox, which is the
    // pre-registry status quo — strictly better than refusing to provision.
    const bucket = fakeR2()
    bucket.put = async () => { throw new Error("r2 down") }
    const warn = vi.spyOn(console, "error").mockImplementation(() => {})

    const ensure = await call("/sandbox/claxedo-ws_3/ensure-runtime", env({ BACKUP_BUCKET: bucket }), {
      method: "POST",
      body: ensureBody({ app: "claxedo", workspaceId: "ws_3", epoch: "1" }),
    })

    expect(ensure.status).toBe(200)
    await expect(ensure.json()).resolves.toMatchObject({ ready: true })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test("DELETE deregisters, so the next sweep stops reporting a destroyed sandbox", async () => {
    const workerEnv = env()
    await call("/sandbox/claxedo-ws_4/ensure-runtime", workerEnv, {
      method: "POST",
      body: ensureBody({ app: "claxedo", workspaceId: "ws_4", epoch: "1" }),
    })

    const deleted = await call("/sandbox/claxedo-ws_4", workerEnv, { method: "DELETE" })

    expect(deleted.status).toBe(200)
    expect(sandboxStub.destroy).toHaveBeenCalled()
    await expect(call("/sandboxes", workerEnv).then((res) => res.json()))
      .resolves.toEqual({ supported: true, sandboxes: [] })
  })

  test("listing pages through a registry larger than one R2 page", async () => {
    // 2,500 entries against a 1,000-per-page limit: a single-page read would
    // silently hide 1,500 sandboxes from GC.
    const seed = Array.from({ length: 2_500 }, (_, index) => {
      const id = `claxedo-ws_${String(index).padStart(5, "0")}`
      return [`sandbox-registry/${id}`, { sandboxId: id, app: "claxedo" }] as [string, Metadata]
    })
    const body = await call("/sandboxes", env({ BACKUP_BUCKET: fakeR2(seed) })).then((res) => res.json()) as {
      sandboxes: unknown[]
    }

    expect(body.sandboxes).toHaveLength(2_500)
  })

  test("a Worker with no R2 binding reports supported:false, never an empty list", async () => {
    // "No bucket configured" and "no sandboxes running" must not look alike to
    // a reaper — an empty list would be read as a clean sweep.
    const res = await call("/sandboxes", env({ BACKUP_BUCKET: undefined }))

    expect(res.status).toBe(501)
    await expect(res.json()).resolves.toMatchObject({ supported: false })
  })

  test("the listing route is behind the admin token", async () => {
    const unauthed = await worker.fetch(new Request("https://sbx.test/sandboxes"), env())
    expect(unauthed.status).toBe(401)

    const wrong = await worker.fetch(
      new Request("https://sbx.test/sandboxes", { headers: { authorization: "Bearer nope" } }),
      env(),
    )
    expect(wrong.status).toBe(403)
  })

  test("the listing route rejects non-GET methods", async () => {
    expect((await call("/sandboxes", env(), { method: "POST", body: "{}" })).status).toBe(405)
  })
})


describe("native credential registration", () => {
  beforeEach(() => vi.clearAllMocks())
  function credentials() {
    const values = new Map<string, string>()
    return { values, get: async (id: string) => values.get(id) ?? null,
      put: async (id: string, value: string) => { values.set(id, value) },
      delete: async (id: string) => { values.delete(id) } }
  }
  const registration = { name: "MODEL_KEY", hosts: ["api.vendor.test"], header: "Authorization", value: "Bearer real-secret", methods: ["POST"], pathPrefixes: ["/v1"] }
  test("boots with native handlers and stable placeholders instead of an expiring token", async () => {
    const kv = credentials()
    const response = await call("/sandbox/native-proof/ensure-runtime", env({ EGRESS_SECRETS: kv }), {
      method: "POST", body: JSON.stringify({ command: "runtime", env: {}, egress: [registration] }),
    })
    expect(response.status).toBe(200)
    expect(sandboxStub.setCredentialHosts).toHaveBeenCalledWith("native-proof", ["api.vendor.test"])
    const bootEnv = sandboxStub.ensureWorkspaceRuntime.mock.calls.at(-1)?.[1]
    expect(bootEnv).toMatchObject({ MODEL_KEY: "claxedo-broker:MODEL_KEY" })
    expect(JSON.stringify(bootEnv)).not.toContain("real-secret")
  })
  test("explicit empty registrations withdraw stored values and every credential host", async () => {
    const kv = credentials()
    await kv.put("withdraw-proof", JSON.stringify([registration]))
    const response = await call("/sandbox/withdraw-proof/ensure-runtime", env({ EGRESS_SECRETS: kv }), {
      method: "POST", body: JSON.stringify({ command: "runtime", env: {}, egress: [] }),
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(kv.values.get("withdraw-proof")!)).toEqual([])
    expect(sandboxStub.setCredentialHosts).toHaveBeenLastCalledWith("withdraw-proof", [])
  })
  test("omitted registrations preserve the authority and placeholders on wake", async () => {
    const kv = credentials()
    kv.values.set("wake-proof", JSON.stringify([registration]))
    const response = await call("/sandbox/wake-proof/ensure-runtime", env({ EGRESS_SECRETS: kv }), {
      method: "POST", body: JSON.stringify({ command: "runtime", env: {} }),
    })
    expect(response.status).toBe(200)
    expect(sandboxStub.ensureWorkspaceRuntime.mock.calls.at(-1)?.[1]).toMatchObject({ MODEL_KEY: "claxedo-broker:MODEL_KEY" })
    expect(JSON.parse(kv.values.get("wake-proof")!)).toEqual([registration])
  })

  test("missing credential storage fails before runtime launch", async () => {
    const response = await call("/sandbox/no-storage/ensure-runtime", env(), {
      method: "POST", body: JSON.stringify({ command: "runtime", egress: [registration] }),
    })
    expect(response.status).toBe(503)
    expect(sandboxStub.ensureWorkspaceRuntime).not.toHaveBeenCalled()
  })

  test("malformed registrations reject provisioning instead of disappearing", async () => {
    const response = await call("/sandbox/invalid-proof/ensure-runtime", env({ EGRESS_SECRETS: credentials() }), {
      method: "POST", body: JSON.stringify({ command: "runtime", env: {}, egress: [{ ...registration, value: 42 }] }),
    })
    expect(response.status).toBe(400)
  })
})

describe("workspace-runtime process env", () => {
  function process(overrides: Record<string, unknown> = {}) {
    return {
      id: "claxedo-workspace-runtime",
      status: "running",
      startTime: new Date(),
      waitForPort: vi.fn(async () => {}),
      getStatus: vi.fn(async () => "running"),
      kill: vi.fn(async () => {}),
      getLogs: vi.fn(async () => ({ stdout: "", stderr: "" })),
      ...overrides,
    }
  }

  /**
   * The container's view of the runtime process. As in the SDK, the process
   * `startProcess` answers is stamped with the Worker's clock, while
   * `listProcesses` and `getProcess` report the container's own start time.
   */
  function operations(
    existing: ReturnType<typeof process> | null,
    started = process(),
    containerStart = new Date(started.startTime.getTime() - 1_234),
  ) {
    let readyAt: number | undefined
    let listed = existing
    return {
      started,
      markReady: (entry: { startTime: Date }) => { readyAt = entry.startTime.getTime() },
      listProcesses: vi.fn(async () => (listed ? [listed] : [])),
      getProcess: vi.fn(async () => listed),
      startProcess: vi.fn(async () => {
        listed = { ...started, startTime: containerStart }
        return started
      }),
      cleanupCompletedProcesses: vi.fn(async () => {
        if (listed && !["starting", "running"].includes(await listed.getStatus())) listed = null
      }),
      runtimeWasReady: vi.fn(async (entry: { startTime: Date }) => readyAt === entry.startTime.getTime()),
      recordRuntimeReady: vi.fn(async (entry: { startTime: Date }) => { readyAt = entry.startTime.getTime() }),
    }
  }

  const bootFailure = [
    "[claxedo-workspace-runtime] workspace_runtime_boot_failed: Error: Command failed: git fetch --quiet --depth=1 origin",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "    at ChildProcess.exithandler (node:child_process:422:12)",
    "",
  ].join("\n")

  test("a running runtime is left alone when the caller says its env is unchanged", async () => {
    const existing = process()
    const sandbox = operations(existing)

    await expect(
      ensureRuntimeProcess(sandbox as never, "runtime", { MODEL_KEY: "claxedo-broker:MODEL_KEY" }, 2593, {
        reuseRunning: true,
      }),
    ).resolves.toEqual({ state: "ready" })

    expect(sandbox.startProcess).not.toHaveBeenCalled()
    expect(existing.kill).not.toHaveBeenCalled()
  })

  test("a live runtime still preparing its repository keeps running across polls, so a large clone can finish", async () => {
    let ready = false
    const existing = process({ waitForPort: vi.fn(async () => { if (!ready) throw new Error("not listening") }) })
    const sandbox = operations(existing)
    const poll = () => ensureRuntimeProcess(sandbox as never, "runtime", {}, 2593, { reuseRunning: true })

    await expect(poll()).resolves.toEqual({ state: "preparing" })
    await expect(poll()).resolves.toEqual({ state: "preparing" })
    ready = true
    await expect(poll()).resolves.toEqual({ state: "ready" })

    expect(existing.kill).not.toHaveBeenCalled()
    expect(sandbox.startProcess).not.toHaveBeenCalled()
  })

  test("a live runtime still not ready past the preparation limit is wedged and replaced", async () => {
    const existing = process({
      startTime: new Date(Date.now() - 36 * 60_000),
      waitForPort: vi.fn(async () => { throw new Error("not listening") }),
    })
    const sandbox = operations(existing)

    await expect(ensureRuntimeProcess(sandbox as never, "runtime", {}, 2593, { reuseRunning: true })).resolves.toEqual({ state: "ready" })

    expect(existing.kill).toHaveBeenCalled()
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
  })

  test("a runtime that has answered ready is never replaced for a slow health check, however long it has run", async () => {
    let healthy = true
    const existing = process({
      startTime: new Date(Date.now() - 3 * 24 * 60 * 60_000),
      waitForPort: vi.fn(async () => { if (!healthy) throw new Error("health check timed out") }),
    })
    const sandbox = operations(existing)
    const poll = () => ensureRuntimeProcess(sandbox as never, "runtime", {}, 2593, { reuseRunning: true })

    await expect(poll()).resolves.toEqual({ state: "ready" })
    healthy = false
    await expect(poll()).resolves.toEqual({ state: "preparing" })

    expect(existing.kill).not.toHaveBeenCalled()
    expect(sandbox.startProcess).not.toHaveBeenCalled()
  })

  test("a runtime this ensure started is remembered by the container's start time, so a later slow health check keeps it", async () => {
    let healthy = true
    const started = process({ waitForPort: vi.fn(async () => { if (!healthy) throw new Error("health check timed out") }) })
    const sandbox = operations(null, started, new Date(Date.now() - 40 * 60_000))
    const ensure = () => ensureRuntimeProcess(sandbox as never, "runtime", {}, 2593, { reuseRunning: true })

    await expect(ensure()).resolves.toEqual({ state: "ready" })
    await expect(ensure()).resolves.toEqual({ state: "ready" })
    expect(sandbox.recordRuntimeReady).toHaveBeenCalledTimes(1)
    healthy = false
    await expect(ensure()).resolves.toEqual({ state: "preparing" })

    expect(started.kill).not.toHaveBeenCalled()
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
  })

  test("a runtime whose boot exits answers with the boot's own reason instead of starting the same boot again", async () => {
    const exited = process({
      waitForPort: vi.fn(async () => { throw new Error("process exited before ready") }),
      getStatus: vi.fn(async () => "failed"),
      getLogs: vi.fn(async () => ({ stdout: "", stderr: bootFailure })),
    })
    const sandbox = operations(null, exited)

    await expect(ensureRuntimeProcess(sandbox as never, "runtime", {}, 2593, { reuseRunning: true })).resolves.toEqual({
      state: "exited",
      reason: "Command failed: git fetch --quiet --depth=1 origin\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
    })
    expect(sandbox.cleanupCompletedProcesses).toHaveBeenCalled()
  })

  test("a runtime found exited before it was ever ready is reported once and cleared, so the next ensure boots afresh", async () => {
    const existing = process({ status: "failed", getStatus: vi.fn(async () => "failed"), getLogs: vi.fn(async () => ({ stdout: "", stderr: bootFailure })) })
    const sandbox = operations(existing)

    const ensure = () => ensureRuntimeProcess(sandbox as never, "runtime", {}, 2593, { reuseRunning: true })

    await expect(ensure()).resolves.toMatchObject({ state: "exited", reason: expect.stringContaining("could not read Username") })
    expect(sandbox.startProcess).not.toHaveBeenCalled()
    await expect(ensure()).resolves.toEqual({ state: "ready" })
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
  })

  test("a runtime that exited after serving is replaced even when the env is unchanged", async () => {
    const existing = process({ status: "failed", getStatus: vi.fn(async () => "failed") })
    const sandbox = operations(existing)
    sandbox.markReady(existing)

    await expect(ensureRuntimeProcess(sandbox as never, "runtime", {}, 2593, { reuseRunning: true })).resolves.toEqual({ state: "ready" })

    expect(existing.kill).not.toHaveBeenCalled()
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
  })

  test("a running runtime is replaced when the caller says its env changed", async () => {
    // A process keeps the environment it was spawned with, so a credential
    // registered after boot becomes its placeholder env var only once the
    // process itself is replaced.
    const existing = process()
    const sandbox = operations(existing)
    const env = { MODEL_KEY: "claxedo-broker:MODEL_KEY" }

    await expect(
      ensureRuntimeProcess(sandbox as never, "runtime", env, 2593, { reuseRunning: false }),
    ).resolves.toEqual({ state: "ready" })

    expect(existing.kill).toHaveBeenCalled()
    expect(sandbox.startProcess).toHaveBeenCalledWith("runtime", {
      env,
      processId: "claxedo-workspace-runtime",
    })
  })
})

describe("runtime env reconciliation on ensure-runtime", () => {
  beforeEach(() => vi.clearAllMocks())
  function credentials(seed: Record<string, string> = {}) {
    const values = new Map(Object.entries(seed))
    return {
      values,
      get: async (id: string) => values.get(id) ?? null,
      put: async (id: string, value: string) => { values.set(id, value) },
      delete: async (id: string) => { values.delete(id) },
    }
  }
  const registration = { name: "CLAXEDO_MCP_NOTION", hosts: ["api.vendor.test"], header: "Authorization", value: "Bearer real", methods: ["POST"], pathPrefixes: ["/v1"] }

  test("a newly registered credential replaces the running runtime so its placeholder exists", async () => {
    const kv = credentials()
    await call("/sandbox/added/ensure-runtime", env({ EGRESS_SECRETS: kv }), {
      method: "POST",
      body: JSON.stringify({ command: "runtime", env: {}, egress: [registration] }),
    })

    expect(sandboxStub.ensureWorkspaceRuntime).toHaveBeenLastCalledWith(
      "runtime",
      expect.objectContaining({ CLAXEDO_MCP_NOTION: "claxedo-broker:CLAXEDO_MCP_NOTION" }),
      2593,
      { reuseRunning: false },
    )
  })

  test("a rotated value keeps the same placeholder and leaves the running runtime alone", async () => {
    const kv = credentials({ rotated: JSON.stringify([registration]) })
    await call("/sandbox/rotated/ensure-runtime", env({ EGRESS_SECRETS: kv }), {
      method: "POST",
      body: JSON.stringify({ command: "runtime", env: {}, egress: [{ ...registration, value: "Bearer fresh" }] }),
    })

    expect(sandboxStub.ensureWorkspaceRuntime.mock.calls.at(-1)?.[3]).toEqual({ reuseRunning: true })
  })

  test("withdrawing a credential replaces the runtime so its placeholder stops existing", async () => {
    const kv = credentials({ withdrawn: JSON.stringify([registration]) })
    await call("/sandbox/withdrawn/ensure-runtime", env({ EGRESS_SECRETS: kv }), {
      method: "POST",
      body: JSON.stringify({ command: "runtime", env: {}, egress: [] }),
    })

    expect(sandboxStub.ensureWorkspaceRuntime.mock.calls.at(-1)?.[3]).toEqual({ reuseRunning: false })
  })
})

describe("credential host interception", () => {
  const TRUST_ANCHOR = "claxedo-credential-trust.invalid"

  function objectState(running: boolean) {
    const intercepted: string[] = []
    const stored = new Map<string, unknown>()
    const ctx = {
      container: {
        running,
        interceptOutboundHttps: vi.fn(async (host: string, egress: { props: { sandboxId: string } }) => {
          intercepted.push(`${host}->${egress.props.sandboxId}`)
          lifecycle.push(`intercept ${host}`)
        }),
      },
      storage: { get: async (key: string) => stored.get(key), put: async (key: string, value: unknown) => { stored.set(key, value) } },
      exports: { CredentialEgress: (options: { props: { sandboxId: string } }) => options },
      blockConcurrencyWhile: async (callback: () => Promise<unknown>) => callback(),
    }
    return { ctx, intercepted }
  }

  beforeEach(() => { lifecycle.length = 0 })

  test("a fresh sandbox with no credential host intercepts only the unresolvable trust anchor, before its container starts", async () => {
    const { ctx, intercepted } = objectState(false)
    const sandbox = new Sandbox(ctx as never, {} as never)
    expect(intercepted).toEqual([])
    await sandbox.startAndWaitForPorts()
    expect(intercepted).toEqual([`${TRUST_ANCHOR}->`])
    expect(lifecycle).toEqual([`intercept ${TRUST_ANCHOR}`, "startAndWaitForPorts"])
  })

  test("a fresh sandbox's first ensure-runtime records its hosts and boots without any SDK outbound configuration", async () => {
    sandboxStub.setCredentialHosts.mockClear()
    sandboxStub.ensureWorkspaceRuntime.mockClear()
    const response = await call("/sandbox/fresh-sandbox/ensure-runtime", env(), { method: "POST", body: JSON.stringify({ command: "runtime", env: {}, egress: [] }) })
    expect(response.status).toBe(200)
    expect(sandboxStub.setCredentialHosts).toHaveBeenCalledWith("fresh-sandbox", [])
    expect(sandboxStub.ensureWorkspaceRuntime).toHaveBeenCalledTimes(1)
  })

  test("registered hosts are intercepted on every container start, and at once on a running container", async () => {
    const stopped = objectState(false)
    const cold = new Sandbox(stopped.ctx as never, {} as never)
    await cold.setCredentialHosts("ws_1", ["api.vendor.test", "github.com", "api.vendor.test"])
    expect(stopped.intercepted).toEqual([])
    await cold.start()
    expect(stopped.intercepted).toEqual([`${TRUST_ANCHOR}->ws_1`, "api.vendor.test->ws_1", "github.com->ws_1"])
    expect(lifecycle.at(-1)).toBe("start")

    const running = objectState(true)
    const live = new Sandbox(running.ctx as never, {} as never)
    await live.setCredentialHosts("ws_2", ["api.vendor.test"])
    expect(running.intercepted.slice(-2)).toEqual([`${TRUST_ANCHOR}->ws_2`, "api.vendor.test->ws_2"])
  })

  test("the egress entrypoint spends only the registrations of the sandbox it was created for", async () => {
    const registration = { name: "KEY", hosts: ["api.vendor.test"], header: "Authorization", value: "Bearer real", methods: ["POST"], pathPrefixes: ["/v1"] }
    const kv = { get: async (id: string) => (id === "ws_1" ? JSON.stringify([registration]) : null) }
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response((input as Request).headers.get("authorization")))
    try {
      const request = () => new Request("https://api.vendor.test/v1/messages", { method: "POST", headers: { authorization: "claxedo-broker:KEY" } })
      const own = new CredentialEgress({ props: { sandboxId: "ws_1" } } as never, { EGRESS_SECRETS: kv } as never)
      expect(await (await own.fetch(request() as never)).text()).toBe("Bearer real")
      const other = new CredentialEgress({ props: { sandboxId: "ws_2" } } as never, { EGRESS_SECRETS: kv } as never)
      expect((await other.fetch(request() as never)).status).toBe(403)
    } finally {
      upstream.mockRestore()
    }
  })
})

describe("runtime proxy transports", () => {
  beforeEach(() => {
    sandboxStub.containerFetch.mockClear()
    sandboxStub.wsConnect.mockClear()
  })

  test("a WebSocket upgrade reaches the runtime port through the SDK's fetch boundary and keeps the upgrade answer", async () => {
    const upgraded = { status: 101, webSocket: {} } as unknown as Response
    sandboxStub.wsConnect.mockResolvedValueOnce(upgraded)
    const response = await worker.fetch(new Request("https://sbx.test/sandbox/claxedo-ws/proxy/api/wr/pty/pty_1/connect?cursor=42", {
      headers: { upgrade: "websocket", connection: "Upgrade", authorization: "Bearer relay-host-token" },
    }), env())
    expect(response).toBe(upgraded)
    expect(sandboxStub.containerFetch).not.toHaveBeenCalled()
    const [request, port] = sandboxStub.wsConnect.mock.calls.at(-1)!
    expect(new URL(request.url).pathname + new URL(request.url).search).toBe("/api/wr/pty/pty_1/connect?cursor=42")
    expect(request.headers.get("authorization")).toBe("Bearer relay-host-token")
    expect(port).toBe(2593)
  })

  test("ordinary runtime HTTP stays on containerFetch", async () => {
    await worker.fetch(new Request("https://sbx.test/sandbox/claxedo-ws/proxy/api/wr/health"), env())
    expect(sandboxStub.containerFetch).toHaveBeenCalledTimes(1)
    expect(sandboxStub.wsConnect).not.toHaveBeenCalled()
  })
})

describe("workspace idle lifecycle and checkpoints", () => {
  const WORKSPACE = "00000000-0000-4000-8000-000000000001"
  const HOME = "00000000-0000-4000-8000-000000000002"

  test("ensure-runtime gives the runtime its health token, then watches it for idleness once it is ready", async () => {
    sandboxStub.configureWorkspaceIdle.mockClear()
    sandboxStub.watchWorkspaceIdle.mockClear()
    sandboxStub.ensureWorkspaceRuntime.mockClear()
    const response = await call("/sandbox/claxedo-ws_9/ensure-runtime", env(), { method: "POST", body: ensureBody({ workspaceId: "ws_9", epoch: "4" }) })
    expect(response.status).toBe(200)
    expect(sandboxStub.configureWorkspaceIdle).toHaveBeenCalledWith({ workspaceId: "ws_9", epoch: 4, port: 2593, idleMs: 600_000 })
    expect(sandboxStub.ensureWorkspaceRuntime.mock.calls[0]?.[1]).toMatchObject({ WORKSPACE_RUNTIME_CONFIG_TOKEN: "health-token" })
    expect(sandboxStub.watchWorkspaceIdle.mock.invocationCallOrder[0]).toBeGreaterThan(sandboxStub.ensureWorkspaceRuntime.mock.invocationCallOrder[0])
  })

  test("without the control plane's origin a runtime is not started, because nothing would ever stop it", async () => {
    sandboxStub.ensureWorkspaceRuntime.mockClear()
    const response = await call("/sandbox/claxedo-ws_9/ensure-runtime", env({ CONTROL_PLANE_URL: undefined }), { method: "POST", body: ensureBody({}) })
    expect(response.status).toBe(503)
    expect(sandboxStub.ensureWorkspaceRuntime).not.toHaveBeenCalled()
  })

  test("a restore hands every captured directory its own backup to the single runtime launch", async () => {
    sandboxStub.ensureWorkspaceRuntime.mockClear()
    const body = (backupId: string) => JSON.stringify({ command: "runtime", env: {}, restore: { backupId, directories: ["/workspace", "/home/claxedo"] } })
    expect((await call("/sandbox/claxedo-ws_9/ensure-runtime", env(), { method: "POST", body: body(`${WORKSPACE},${HOME}`) })).status).toBe(200)
    expect(sandboxStub.ensureWorkspaceRuntime.mock.calls[0]?.[3]).toMatchObject({
      restore: [{ id: WORKSPACE, dir: "/workspace" }, { id: HOME, dir: "/home/claxedo" }],
    })
    expect((await call("/sandbox/claxedo-ws_9/ensure-runtime", env(), { method: "POST", body: body(WORKSPACE) })).status).toBe(400)
  })

  test("backup, delete-backup and stop hand the committed checkpoint to the sandbox, which owns every backup it made", async () => {
    sandboxStub.captureBackups.mockClear()
    sandboxStub.deleteCheckpointBackups.mockClear()
    sandboxStub.stopWorkspace.mockClear()
    const post = (action: string, body: unknown) => call(`/sandbox/claxedo-ws_9/${action}`, env(), { method: "POST", body: JSON.stringify(body) })
    expect(await (await post("backup", { directories: ["/workspace", "/home/claxedo"], committed: WORKSPACE })).json()).toEqual({ backupId: `${WORKSPACE},${HOME}` })
    expect(sandboxStub.captureBackups).toHaveBeenCalledWith(["/workspace", "/home/claxedo"], WORKSPACE)
    expect((await post("delete-backup", { backupId: WORKSPACE })).status).toBe(200)
    expect((await post("delete-backup", { backupId: "../sandbox-registry/claxedo-ws_9" })).status).toBe(400)
    expect(sandboxStub.deleteCheckpointBackups.mock.calls).toEqual([[[WORKSPACE]]])
    expect((await post("stop", { epoch: 1, committed: HOME })).status).toBe(200)
    expect(sandboxStub.stopWorkspace).toHaveBeenCalledWith(1, HOME)
    expect((await post("stop", { epoch: 0 })).status).toBe(409)
    expect((await post("stop", {})).status).toBe(400)
  })

  function idleObject(running: boolean, health: Record<string, number>, bucket = fakeR2()) {
    const stored = new Map<string, unknown>()
    const calls: string[] = []
    const ctx = {
      container: { running, interceptOutboundHttps: async () => {} },
      storage: {
        get: async (key: string) => stored.get(key),
        put: async (key: string, value: unknown) => { stored.set(key, value) },
        delete: async (key: string) => { stored.delete(key) },
      },
      exports: { CredentialEgress: (options: unknown) => options },
      blockConcurrencyWhile: async (callback: () => Promise<unknown>) => callback(),
    }
    const workerEnv = { IDLE_STOP_TOKEN: "idle-token", CONTROL_PLANE_URL: "https://control.test", BACKUP_BUCKET: bucket }
    const sandbox = Object.assign(new Sandbox(ctx as never, workerEnv as never), {
      setKeepAlive: vi.fn(async (value: boolean) => { calls.push(`keepAlive:${value}`) }),
      schedule: vi.fn(async (seconds: number, callback: string) => { calls.push(`schedule:${seconds}:${callback}`) }),
      deleteSchedules: vi.fn((callback: string) => { calls.push(`unschedule:${callback}`) }),
      stop: vi.fn(async () => { calls.push("stop") }),
      createBackup: vi.fn(async (options: { dir: string; excludes?: string[] }) => {
        calls.push(`backup:${options.dir}:${options.excludes?.join("|") ?? ""}`)
        if (options.dir === "/fails") throw new Error("upload failed")
        return { id: backupIdFor(options.dir), dir: options.dir }
      }),
      containerFetch: vi.fn(async (request: Request) => {
        calls.push(`probe:${request.headers.get("authorization")}`)
        return Response.json({ workspaceId: "ws_9", ...health })
      }),
    })
    return { sandbox, calls, bucket }
  }
  const placement = { workspaceId: "ws_9", epoch: 4, port: 2593, idleMs: 600_000 }
  const backupObjects = (id: string): Array<[string, Record<string, string>]> => [[`backups/${id}/data.sqsh`, {}], [`backups/${id}/meta.json`, {}]]

  test("an idle check probes the runtime with its own token, and a busy runtime is checked again", async () => {
    const { sandbox, calls } = idleObject(true, {})
    const token = await sandbox.configureWorkspaceIdle(placement)
    await sandbox.watchWorkspaceIdle()
    await sandbox.checkWorkspaceIdle()
    expect(calls).toEqual(["keepAlive:true", "unschedule:checkWorkspaceIdle", "schedule:30:checkWorkspaceIdle", `probe:Bearer ${token}`, "schedule:30:checkWorkspaceIdle"])
    expect(await sandbox.configureWorkspaceIdle({ ...placement, epoch: 5 })).toBe(token)
  })

  test("once the control plane stops the lease, the sandbox stops its own container, and a stopped container is never probed", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, status: "stopped", checkpoint: WORKSPACE }))
    try {
      const { sandbox, calls } = idleObject(true, { idleSince: 0 })
      await sandbox.configureWorkspaceIdle(placement)
      await sandbox.checkWorkspaceIdle()
      expect(upstream).toHaveBeenCalledOnce()
      expect(calls.slice(1)).toEqual(["unschedule:checkWorkspaceIdle", "keepAlive:false", "stop"])
      const asleep = idleObject(false, { idleSince: 0 })
      await asleep.sandbox.configureWorkspaceIdle(placement)
      await asleep.sandbox.checkWorkspaceIdle()
      expect(asleep.calls).toEqual([])
    } finally {
      upstream.mockRestore()
    }
  })

  test("a runtime frozen past every checkpoint's deadline is settled, so a lease stopped before a failed host stop still stops its container", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, status: "stopped", checkpoint: WORKSPACE }))
    try {
      const { sandbox, calls } = idleObject(true, { frozenSince: 0 })
      await sandbox.configureWorkspaceIdle(placement)
      await sandbox.checkWorkspaceIdle()
      expect(calls.slice(-1)).toEqual(["stop"])
    } finally {
      upstream.mockRestore()
    }
  })

  test("idle checks that keep failing stop keeping the container alive, so the SDK's own sleep bounds the cost", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("runtime_lease_changed", { status: 409 }))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { sandbox, calls } = idleObject(true, { idleSince: 0 })
      await sandbox.configureWorkspaceIdle(placement)
      for (let check = 0; check < 20; check++) await sandbox.checkWorkspaceIdle()
      expect(calls.filter((call) => call.startsWith("schedule"))).toHaveLength(19)
      expect(calls.at(-1)).toBe("keepAlive:false")
    } finally {
      upstream.mockRestore()
      error.mockRestore()
    }
  })

  test("a capture records its backups as it makes them; the next capture or stop deletes those the lease did not commit", async () => {
    const { sandbox, calls, bucket } = idleObject(true, {}, fakeR2([...backupObjects(WORKSPACE), ...backupObjects(HOME)]))
    expect(await sandbox.captureBackups(["/workspace", "/home/claxedo"], undefined)).toBe(`${WORKSPACE},${HOME}`)
    expect(calls).toEqual(["backup:/workspace:", "backup:/home/claxedo:.cache|.npm/_cacache|.bun/install/cache"])
    await sandbox.captureBackups(["/workspace", "/home/claxedo"], `${WORKSPACE},${HOME}`)
    expect(bucket.store.size).toBe(4)
    await sandbox.configureWorkspaceIdle(placement)
    expect(await sandbox.stopWorkspace(4, undefined)).toBe(true)
    expect(bucket.store.size).toBe(0)
  })

  test("a capture that fails partway deletes what it made", async () => {
    const { sandbox, bucket } = idleObject(true, {}, fakeR2(backupObjects(WORKSPACE)))
    await expect(sandbox.captureBackups(["/workspace", "/fails"], undefined)).rejects.toThrow("upload failed")
    expect(bucket.store.size).toBe(0)
  })

  test("a stop for an older lease generation leaves the container running", async () => {
    const { sandbox, calls } = idleObject(true, {})
    await sandbox.configureWorkspaceIdle({ ...placement, epoch: 5 })
    expect(await sandbox.stopWorkspace(4)).toBe(false)
    expect(calls).toEqual([])
    expect(await sandbox.stopWorkspace(5)).toBe(true)
    expect(calls).toEqual(["unschedule:checkWorkspaceIdle", "keepAlive:false", "stop"])
  })
})
