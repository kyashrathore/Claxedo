import { beforeEach, describe, expect, test, vi } from "vitest"

// The real SDK pulls in `cloudflare:workers`, which does not exist outside
// workerd — so the container/DO layer is stubbed and this suite covers the
// Worker's OWN registry logic: what it records on ensure, what it drops on
// destroy, and what `GET /sandboxes` reports. That registry is the only way a
// Cloudflare sandbox can be enumerated (DO namespaces are not listable), so it
// is what the control plane's GC sweep depends on.
const sandboxStub = {
  ensureWorkspaceRuntime: vi.fn(async () => true),
  workspaceRuntimeReady: vi.fn(async () => true),
  destroy: vi.fn(async () => {}),
  createBackup: vi.fn(async () => ({ id: "bk_1", dir: "/workspace" })),
  restoreBackup: vi.fn(async () => {}),
  containerFetch: vi.fn(async () => new Response("ok")),
}
const getSandboxMock = vi.fn(() => sandboxStub)
const containerProxyStub = class {}

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: getSandboxMock,
  Sandbox: class {},
  ContainerProxy: containerProxyStub,
}))

vi.mock("./egress", () => ({
  EGRESS_TARGET_HEADER: "x-claxedo-egress-target",
  handleEgressRequest: async () => new Response("{}"),
  mintEgressToken: async () => "egress-token",
}))

const { default: worker, ContainerProxy } = await import("./index")

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
        ...(init.headers as Record<string, string> ?? {}),
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
