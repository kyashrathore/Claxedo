import { beforeEach, describe, expect, test, vi } from "vitest"

// The real SDK pulls in `cloudflare:workers`, which does not exist outside
// workerd — so the container/DO layer is stubbed and this suite covers the
// Worker's OWN registry logic: what it records on ensure, what it drops on
// destroy, and what `GET /sandboxes` reports. That registry is the only way a
// Cloudflare sandbox can be enumerated (DO namespaces are not listable), so it
// is what the control plane's GC sweep depends on.
const sandboxStub = {
  setOutboundByHosts: vi.fn(async (_handlers: Record<string, { method: string; params: unknown }>) => {}),
  ensureWorkspaceRuntime: vi.fn(async (
    _command: string,
    _env: Record<string, string>,
    _port: number,
    _options: { reuseRunning: boolean },
  ) => true),
  workspaceRuntimeReady: vi.fn(async () => true),
  destroy: vi.fn(async () => {}),
  createBackup: vi.fn(async () => ({ id: "bk_1", dir: "/workspace" })),
  restoreBackup: vi.fn(async () => {}),
  containerFetch: vi.fn(async () => new Response("ok")),
}
const getSandboxMock = vi.fn(() => sandboxStub)
const containerProxyStub = class ContainerProxy { readonly stub = "container-proxy" }

// `@cloudflare/containers` cannot be imported outside workerd (its module scope
// pulls `cloudflare:workers`), so the one piece of the base class our code
// depends on is reproduced exactly: `outboundHandlers` is a registry-backed
// static ACCESSOR, keyed by class name. A static field on the subclass shadows
// it and the SDK then finds no handler — that is what this base is here to
// catch.
const outboundHandlersRegistry = new Map<string, Record<string, unknown>>()

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: getSandboxMock,
  Sandbox: class Sandbox {
    readonly stub = "sandbox"
    static get outboundHandlers() {
      return outboundHandlersRegistry.get(this.name)
    }
    static set outboundHandlers(handlers: Record<string, unknown> | undefined) {
      outboundHandlersRegistry.set(this.name, handlers ?? {})
    }
  },
  ContainerProxy: containerProxyStub,
}))

const { default: worker, ContainerProxy, Sandbox, ensureRuntimeProcess } = await import("./index")

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
  return { Sandbox: {}, API_TOKEN: "tok", BACKUP_BUCKET: fakeR2(), ...overrides } as never
}

function call(path: string, workerEnv: never, init: RequestInit = {}) {
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

  test("exports the SDK ContainerProxy so intercepted HTTPS can leave the sandbox", () => {
    expect(ContainerProxy).toBe(containerProxyStub)
  })

  test("the credential handler is registered through the inherited setter, not shadowed by a field", async () => {
    expect(Object.getOwnPropertyDescriptor(Sandbox, "outboundHandlers")).toBeUndefined()
    const handlers = outboundHandlersRegistry.get("Sandbox")
    expect(handlers).toBeDefined()
    // The same key setOutboundByHosts dispatches on below.
    expect(Object.keys(handlers!)).toEqual(["credential"])

    await call("/sandbox/handler-name/ensure-runtime", env({
      EGRESS_SECRETS: { get: async () => null, put: async () => {}, delete: async () => {} },
    }), {
      method: "POST",
      body: JSON.stringify({
        command: "runtime",
        env: {},
        egress: [{ name: "KEY", hosts: ["api.vendor.test"], header: "Authorization", value: "Bearer v" }],
      }),
    })
    expect(sandboxStub.setOutboundByHosts).toHaveBeenLastCalledWith({
      "api.vendor.test": { method: Object.keys(handlers!)[0], params: { sandboxId: "handler-name" } },
    })
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
    expect(sandboxStub.setOutboundByHosts).toHaveBeenCalledWith({ "api.vendor.test": { method: "credential", params: { sandboxId: "native-proof" } } })
    const bootEnv = sandboxStub.ensureWorkspaceRuntime.mock.calls.at(-1)?.[1]
    expect(bootEnv).toMatchObject({ MODEL_KEY: "claxedo-broker:MODEL_KEY" })
    expect(JSON.stringify(bootEnv)).not.toContain("real-secret")
  })
  test("explicit empty registrations withdraw stored values and handlers", async () => {
    const kv = credentials()
    await kv.put("withdraw-proof", JSON.stringify([registration]))
    const response = await call("/sandbox/withdraw-proof/ensure-runtime", env({ EGRESS_SECRETS: kv }), {
      method: "POST", body: JSON.stringify({ command: "runtime", env: {}, egress: [] }),
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(kv.values.get("withdraw-proof")!)).toEqual([])
    expect(sandboxStub.setOutboundByHosts).toHaveBeenLastCalledWith({})
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
      waitForPort: vi.fn(async () => {}),
      getStatus: vi.fn(async () => "running"),
      kill: vi.fn(async () => {}),
      getLogs: vi.fn(async () => ({ stdout: "", stderr: "" })),
      ...overrides,
    }
  }

  function operations(existing: ReturnType<typeof process> | null) {
    const started = process()
    return {
      started,
      listProcesses: vi.fn(async () => (existing ? [existing] : [])),
      startProcess: vi.fn(async () => started),
      cleanupCompletedProcesses: vi.fn(async () => {}),
    }
  }

  test("a running runtime is left alone when the caller says its env is unchanged", async () => {
    const existing = process()
    const sandbox = operations(existing)

    await expect(
      ensureRuntimeProcess(sandbox as never, "runtime", { MODEL_KEY: "claxedo-broker:MODEL_KEY" }, 2593, {
        reuseRunning: true,
      }),
    ).resolves.toBe(true)

    expect(sandbox.startProcess).not.toHaveBeenCalled()
    expect(existing.kill).not.toHaveBeenCalled()
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
    ).resolves.toBe(true)

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
