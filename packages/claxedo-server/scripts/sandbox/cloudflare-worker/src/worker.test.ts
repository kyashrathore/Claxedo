import { beforeEach, describe, expect, test, vi } from "vitest"
import type { WorkspaceEnsure, WorkspaceEnsureInput } from "./workspace-sandbox"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}))

const { default: worker, CredentialEgress } = await import("./index")

// The Workers runtime's constant-time comparison, which Node's WebCrypto lacks.
const timingSafeEqual = vi.fn((a: ArrayBuffer, b: ArrayBuffer) => Buffer.from(a).equals(Buffer.from(b)))
Object.defineProperty(crypto.subtle, "timingSafeEqual", { value: timingSafeEqual, configurable: true })

const stub = {
  fetch: vi.fn(async (_request: Request) => new Response("from runtime")),
  setCredentialHosts: vi.fn(async (_sandboxId: string, _hosts: readonly string[]) => {}),
  configureWorkspaceIdle: vi.fn(async () => "health-token"),
  ensureWorkspace: vi.fn(async (_input: WorkspaceEnsureInput): Promise<WorkspaceEnsure> => ({ state: "ready" })),
  workspaceRuntimeReady: vi.fn(async () => true),
  watchWorkspaceIdle: vi.fn(async () => {}),
  stopWorkspace: vi.fn(async (epoch: number) => epoch === 3),
  snapshotWorkspace: vi.fn(async () => ({ snapshotId: "snap-1", sizeBytes: 4_096 })),
  destroyWorkspace: vi.fn(async () => {}),
}
const getByName = vi.fn((_name: string, _options?: { locationHint?: "enam" }) => stub)

type Metadata = Record<string, string>

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
      const truncated = start + page.length < keys.length
      return { objects: page.map((key) => ({ key, customMetadata: store.get(key) })), truncated, ...(truncated ? { cursor: String(start + page.length) } : {}) }
    },
  }
}

function credentials(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))
  return {
    values,
    get: async (id: string) => values.get(id) ?? null,
    put: async (id: string, value: string) => {
      values.set(id, value)
    },
    delete: async (id: string) => {
      values.delete(id)
    },
  }
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    WORKSPACE_SANDBOX: { getByName },
    API_TOKEN: "tok",
    RUNTIME_BUILD_ID: "build-1",
    RUNTIME_VERSION: "0.5.2",
    RUNTIME_DIGEST: "d".repeat(64),
    CONTROL_PLANE_URL: "https://control.test",
    IDLE_STOP_TOKEN: "idle-token",
    SANDBOX_REGISTRY: fakeR2(),
    ...overrides,
  } as never
}

function call(path: string, workerEnv: never, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://sbx.test${path}`, {
    ...init,
    headers: { authorization: "Bearer tok", "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
  }), workerEnv)
}

function ensure(sandboxId: string, workerEnv: never, body: Record<string, unknown> = {}) {
  const labels = { app: "claxedo", workspaceId: "ws_1", epoch: "3", ...body.labels as Metadata | undefined }
  return call(`/sandbox/${sandboxId}/ensure-runtime`, workerEnv, {
    method: "POST",
    body: JSON.stringify({ command: "/usr/local/bin/workspace-runtime", env: {}, ...body, labels }),
  })
}

const registration = { name: "MODEL_KEY", hosts: ["api.vendor.test"], header: "Authorization", value: "Bearer real-secret", methods: ["POST"], pathPrefixes: ["/v1"] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("sandbox placement and the runtime proxy", () => {
  test("every sandbox object is placed in ENAM, beside the control plane and away from vendor-blocked regions", async () => {
    await ensure("claxedo-ws_1", env())
    await worker.fetch(new Request("https://sbx.test/sandbox/claxedo-ws_1/proxy/global/health"), env())
    expect(getByName.mock.calls.every(([, options]) => options?.locationHint === "enam")).toBe(true)
    expect(getByName.mock.calls.map(([name]) => name)).toContain("claxedo-ws_1")
  })

  test("relay traffic reaches the sandbox's object with the runtime path, query and Relay Host Token, outside the admin token", async () => {
    const response = await worker.fetch(new Request("https://sbx.test/sandbox/claxedo-ws_1/proxy/api/wr/pty/pty_1/connect?cursor=42", {
      headers: { authorization: "Bearer relay-host-token", "x-claxedo-trace-id": "trace-1" },
    }), env())
    expect(await response.text()).toBe("from runtime")
    expect(response.headers.get("x-claxedo-trace-id")).toBe("trace-1")
    expect(response.headers.get("server-timing")).toMatch(/^sandbox-container;dur=/)
    const [request] = stub.fetch.mock.calls[0]
    expect(new URL(request.url).pathname + new URL(request.url).search).toBe("/api/wr/pty/pty_1/connect?cursor=42")
    expect(request.headers.get("authorization")).toBe("Bearer relay-host-token")
  })

  test("a WebSocket upgrade answer is passed back as the object returned it", async () => {
    const upgraded = { status: 101, webSocket: {} } as unknown as Response
    stub.fetch.mockResolvedValueOnce(upgraded)
    const response = await worker.fetch(new Request("https://sbx.test/sandbox/claxedo-ws_1/proxy/api/wr/pty/pty_1/connect", {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    }), env())
    expect(response).toBe(upgraded)
  })
})

describe("ensure-runtime", () => {
  test("hands the runtime its health token, starts it, registers the sandbox, then watches it for idleness", async () => {
    const workerEnv = env()
    const response = await ensure("claxedo-ws_1", workerEnv)
    expect(await response.json()).toEqual({ ready: true, url: "https://sbx.test/sandbox/claxedo-ws_1/proxy", port: 2593 })
    expect(stub.ensureWorkspace).toHaveBeenCalledWith({
      command: "/usr/local/bin/workspace-runtime",
      env: { WORKSPACE_RUNTIME_CONFIG_TOKEN: "health-token" },
      port: 2593,
      reuseRunning: true,
    })
    expect(stub.watchWorkspaceIdle).toHaveBeenCalledOnce()
    expect(await (await call("/sandboxes", workerEnv)).json()).toEqual({
      supported: true,
      sandboxes: [{ sandboxId: "claxedo-ws_1", app: "claxedo", workspaceId: "ws_1", epoch: "3" }],
    })
  })

  test("a restore names the checkpoint's snapshot and the control plane's minimum runtime to the object, and a restore without a snapshot is refused", async () => {
    await ensure("claxedo-ws_1", env(), { restore: { snapshotId: "snap-7" }, minimumRuntimeVersion: "0.5.2" })
    expect(stub.ensureWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ restore: "snap-7", minimumRuntimeVersion: "0.5.2" }))
    const refused = await ensure("claxedo-ws_1", env(), { restore: { backupId: "a,b" } })
    expect(refused.status).toBe(400)
    expect(stub.ensureWorkspace).toHaveBeenCalledOnce()
  })

  test.each([
    ["expired", "This workspace's saved files expired after 30 days unused; choose Start fresh."],
    ["runtime_outdated", "This workspace was saved by a runtime that has since had a security fix; choose Start fresh."],
    ["runtime_modified", "This workspace's saved runtime was changed inside the machine; choose Start fresh."],
    ["not_restorable", "This workspace's saved files can't be restored here; choose Start fresh."],
  ] as const)("an unusable checkpoint (%s) is a 410 carrying its cause and the one line a person reads", async (cause, line) => {
    stub.ensureWorkspace.mockResolvedValueOnce({ state: "checkpoint-unusable", cause })
    const response = await ensure("claxedo-ws_1", env(), { restore: { snapshotId: "snap-7" } })
    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({ ready: false, checkpointUnusable: cause, error: line })
    expect(stub.watchWorkspaceIdle).not.toHaveBeenCalled()
  })

  test("a Worker deployed without its runtime build identity starts nothing", async () => {
    const response = await ensure("claxedo-ws_1", env({ RUNTIME_DIGEST: undefined }))
    expect(response.status).toBe(503)
    expect(stub.ensureWorkspace).not.toHaveBeenCalled()
  })

  test("a runtime whose boot failed answers with that reason as an exit, and is not registered", async () => {
    stub.ensureWorkspace.mockResolvedValueOnce({ state: "exited", reason: "fatal: couldn't find remote ref refs/heads/missing" })
    const workerEnv = env()
    const response = await ensure("claxedo-ws_9", workerEnv)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ ready: false, exited: true, error: "fatal: couldn't find remote ref refs/heads/missing" })
    expect(await (await call("/sandboxes", workerEnv)).json()).toEqual({ supported: true, sandboxes: [] })
  })

  test("a runtime still preparing is the one retryable 503", async () => {
    stub.ensureWorkspace.mockResolvedValueOnce({ state: "preparing" })
    const response = await ensure("claxedo-ws_1", env())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ready: false, error: "workspace-runtime did not become ready" })
  })

  test("without the control plane's origin no runtime is started, because nothing would ever stop it", async () => {
    const response = await ensure("claxedo-ws_1", env({ CONTROL_PLANE_URL: undefined }))
    expect(response.status).toBe(503)
    expect(stub.ensureWorkspace).not.toHaveBeenCalled()
  })
})

describe("native credential registration", () => {
  test("boots with stable placeholders, the raw value staying in KV, and the hosts handed over before the runtime starts", async () => {
    const kv = credentials()
    expect((await ensure("native", env({ EGRESS_SECRETS: kv }), { egress: [registration] })).status).toBe(200)
    expect(stub.setCredentialHosts).toHaveBeenCalledWith("native", ["api.vendor.test"])
    expect(stub.setCredentialHosts.mock.invocationCallOrder[0]).toBeLessThan(stub.ensureWorkspace.mock.invocationCallOrder[0])
    const input = stub.ensureWorkspace.mock.calls[0][0]
    expect(input.env).toMatchObject({ MODEL_KEY: "claxedo-broker:MODEL_KEY" })
    expect(input.reuseRunning).toBe(false)
    expect(JSON.stringify(input)).not.toContain("real-secret")
    expect(JSON.parse(kv.values.get("native") ?? "[]")).toEqual([registration])
  })

  test("explicit empty registrations withdraw the stored values and every credential host, leaving the running runtime alone", async () => {
    const kv = credentials({ withdrawn: JSON.stringify([registration]) })
    await ensure("withdrawn", env({ EGRESS_SECRETS: kv }), { egress: [] })
    expect(JSON.parse(kv.values.get("withdrawn") ?? "null")).toEqual([])
    expect(stub.setCredentialHosts).toHaveBeenLastCalledWith("withdrawn", [])
    expect(stub.ensureWorkspace.mock.calls[0][0].reuseRunning).toBe(true)
  })

  test("omitted registrations preserve the authority and placeholders on wake", async () => {
    const kv = credentials({ wake: JSON.stringify([registration]) })
    await ensure("wake", env({ EGRESS_SECRETS: kv }))
    expect(stub.ensureWorkspace.mock.calls[0][0]).toMatchObject({ env: { MODEL_KEY: "claxedo-broker:MODEL_KEY" }, reuseRunning: true })
    expect(JSON.parse(kv.values.get("wake") ?? "null")).toEqual([registration])
  })

  test("a rotated value keeps its placeholder and the running runtime", async () => {
    const kv = credentials({ rotated: JSON.stringify([registration]) })
    await ensure("rotated", env({ EGRESS_SECRETS: kv }), { egress: [{ ...registration, value: "Bearer fresh" }] })
    expect(stub.ensureWorkspace.mock.calls[0][0].reuseRunning).toBe(true)
  })

  test("missing credential storage fails before any runtime launch, and malformed registrations are refused", async () => {
    expect((await ensure("no-storage", env(), { egress: [registration] })).status).toBe(503)
    expect((await ensure("bad", env({ EGRESS_SECRETS: credentials() }), { egress: [{ ...registration, value: 42 }] })).status).toBe(400)
    expect(stub.ensureWorkspace).not.toHaveBeenCalled()
  })

  test("the egress entrypoint spends only the registrations of the sandbox it was created for", async () => {
    const kv = { get: async (id: string) => (id === "ws_1" ? JSON.stringify([{ ...registration, name: "KEY", value: "Bearer real" }]) : null) }
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

describe("lifecycle routes", () => {
  test("snapshot answers the object's snapshot id and size", async () => {
    const response = await call("/sandbox/claxedo-ws_1/snapshot", env(), { method: "POST", body: "{}" })
    expect(await response.json()).toEqual({ snapshotId: "snap-1", sizeBytes: 4_096 })
  })

  test("stop is fenced by lease generation and needs one", async () => {
    expect((await call("/sandbox/claxedo-ws_1/stop", env(), { method: "POST", body: JSON.stringify({ epoch: 3 }) })).status).toBe(200)
    expect((await call("/sandbox/claxedo-ws_1/stop", env(), { method: "POST", body: JSON.stringify({ epoch: 2 }) })).status).toBe(409)
    expect((await call("/sandbox/claxedo-ws_1/stop", env(), { method: "POST", body: "{}" })).status).toBe(400)
  })

  test("the retired directory-backup actions are unknown", async () => {
    for (const action of ["backup", "delete-backup"]) {
      expect((await call(`/sandbox/claxedo-ws_1/${action}`, env(), { method: "POST", body: "{}" })).status).toBe(404)
    }
  })

  test("DELETE destroys the sandbox, drops its brokered values, then deregisters it", async () => {
    const workerEnv = env({ EGRESS_SECRETS: credentials({ "claxedo-ws_4": "[]" }) })
    await ensure("claxedo-ws_4", workerEnv)
    expect((await call("/sandbox/claxedo-ws_4", workerEnv, { method: "DELETE" })).status).toBe(200)
    expect(stub.destroyWorkspace).toHaveBeenCalledOnce()
    expect(await (await call("/sandboxes", workerEnv)).json()).toEqual({ supported: true, sandboxes: [] })
  })
})

describe("sandbox registry", () => {
  test("labels are capped, so one oversized label cannot make a sandbox unregisterable", async () => {
    const workerEnv = env()
    await ensure("claxedo-ws_2", workerEnv, { labels: { huge: "x".repeat(5_000) } })
    const body = await (await call("/sandboxes", workerEnv)).json() as { sandboxes: Metadata[] }
    expect(body.sandboxes).toEqual([{ sandboxId: "claxedo-ws_2", app: "claxedo", workspaceId: "ws_1", epoch: "3" }])
  })

  test("a failed registry write does not fail ensure-runtime", async () => {
    const bucket = fakeR2()
    bucket.put = async () => {
      throw new Error("r2 down")
    }
    const warn = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const response = await ensure("claxedo-ws_3", env({ SANDBOX_REGISTRY: bucket }))
      expect(await response.json()).toMatchObject({ ready: true })
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("listing pages through a registry larger than one R2 page", async () => {
    const seed = Array.from({ length: 2_500 }, (_, index): [string, Metadata] => {
      const id = `claxedo-ws_${String(index).padStart(5, "0")}`
      return [`sandbox-registry/${id}`, { sandboxId: id, app: "claxedo" }]
    })
    const body = await (await call("/sandboxes", env({ SANDBOX_REGISTRY: fakeR2(seed) }))).json() as { sandboxes: unknown[] }
    expect(body.sandboxes).toHaveLength(2_500)
  })

  test("a Worker with no registry binding reports supported:false, never an empty list", async () => {
    const response = await call("/sandboxes", env({ SANDBOX_REGISTRY: undefined }))
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ supported: false })
  })

  test("the admin token is compared in constant time over digests of equal length", async () => {
    expect((await worker.fetch(new Request("https://sbx.test/sandboxes", { headers: { authorization: "Bearer a-much-longer-wrong-token" } }), env())).status).toBe(403)
    const [presented, expected] = timingSafeEqual.mock.calls.at(-1) ?? []
    expect(presented?.byteLength).toBe(32)
    expect(expected?.byteLength).toBe(32)
  })

  test("the listing is behind the admin token and answers GET only", async () => {
    expect((await worker.fetch(new Request("https://sbx.test/sandboxes"), env())).status).toBe(401)
    expect((await worker.fetch(new Request("https://sbx.test/sandboxes", { headers: { authorization: "Bearer nope" } }), env())).status).toBe(403)
    expect((await call("/sandboxes", env(), { method: "POST", body: "{}" })).status).toBe(405)
  })
})
