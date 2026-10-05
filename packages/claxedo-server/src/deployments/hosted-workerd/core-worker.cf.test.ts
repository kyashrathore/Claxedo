import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

const mocks = vi.hoisted(() => ({ createHostedCoreApp: vi.fn() }))

vi.mock("../hosted-shared/hosted-core-app", () => ({
  createHostedCoreApp: mocks.createHostedCoreApp,
}))

import { createHostedCoreWorker } from "./core-worker.cf"

const documentAccess = { database: { prepare: vi.fn() }, now: Date.now } as never

function app() {
  return {
    onError: vi.fn(),
    fetch: vi.fn(async () => Response.json({ ok: true })),
  }
}

function env() {
  return {
    CLAXEDO_DOCUMENTS: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() } as never,
    CONTROL_PLANE_DB: { prepare: vi.fn() } as never,
    CLAXEDO_REQUEST_LIMITER: {
      limit: vi.fn(async () => ({ success: true })),
    },
    LIVE_SYNC_ROOM: {
      idFromName: vi.fn(),
      get: vi.fn(),
    },
  }
}

describe("hosted core Worker root", () => {
  test("injects mandatory core bindings into one static composition and exposes no cron handler", async () => {
    const application = app()
    mocks.createHostedCoreApp.mockReturnValue(application)
    const product = { productPosture: "user-deployed" }
    const selected = { plane: {} as never, options: { product } as never, documentAccess }
    const compose = vi.fn(() => selected)
    const worker = createHostedCoreWorker(compose)
    const bindings = env()

    const first = await worker.fetch(new Request("https://core.example.test/api/claxedo/health"), bindings)
    const second = await worker.fetch(new Request("https://core.example.test/api/claxedo/mode"), bindings)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // compose runs per request (it owns the settled-composition rule and may
    // replace a wedged instance); the app is built once per composed plane.
    expect(compose).toHaveBeenCalledTimes(2)
    expect(mocks.createHostedCoreApp).toHaveBeenCalledTimes(1)
    expect(mocks.createHostedCoreApp).toHaveBeenCalledWith(selected.plane, expect.objectContaining({
      product,
      documents: expect.objectContaining({ placement: "hosted", access: expect.any(Object) }),
      liveSyncRoom: bindings.LIVE_SYNC_ROOM,
      sharedRateLimitStore: expect.objectContaining({ periodSeconds: 60 }),
    }))
    expect("scheduled" in worker).toBe(false)
  })

  test("follows the composition cache: a replaced plane gets a fresh app instead of the pinned first one", async () => {
    // The settled-composition rule hands out a NEW composition while a prior
    // one's lazy auth init has not settled (its constructor request was
    // canceled). Caching the app per env pinned the wedged first composition
    // for the isolate's lifetime — every authenticated core route hung at ~2ms
    // CPU forever (observed live 2026-09-01 on staging: bootstrap/orgs/
    // workspace/host-assignment all canceled after 8-150s while auth routes worked).
    const firstApp = app()
    const secondApp = app()
    mocks.createHostedCoreApp.mockReset()
    mocks.createHostedCoreApp.mockReturnValueOnce(firstApp).mockReturnValueOnce(secondApp)
    const planes = [{ wedged: true }, { settled: true }]
    const compose = vi.fn(() => ({ plane: (planes.shift() ?? { settled: true }) as never, options: {} as never, documentAccess }))
    const worker = createHostedCoreWorker(compose)
    const bindings = env()

    await worker.fetch(new Request("https://core.example.test/api/claxedo/health"), bindings)
    await worker.fetch(new Request("https://core.example.test/api/claxedo/health"), bindings)

    expect(mocks.createHostedCoreApp).toHaveBeenCalledTimes(2)
    expect(firstApp.fetch).toHaveBeenCalledTimes(1)
    expect(secondApp.fetch).toHaveBeenCalledTimes(1)
  })

  test.each(["CLAXEDO_REQUEST_LIMITER", "LIVE_SYNC_ROOM", "CONTROL_PLANE_DB", "CLAXEDO_DOCUMENTS"] as const)(
    "fails closed before composition when %s is absent",
    async (binding) => {
      mocks.createHostedCoreApp.mockReturnValue(app())
      const compose = vi.fn(() => ({ plane: {} as never, options: {} as never, documentAccess }))
      const worker = createHostedCoreWorker(compose)
      const bindings: Partial<ReturnType<typeof env>> = env()
      delete bindings[binding]

      const response = await worker.fetch(
        new Request("https://core.example.test/api/claxedo/health"),
        bindings,
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: {
          code: "hosted_dependency_missing",
          message: `Hosted core requires the ${binding} binding`,
        },
      })
      expect(response.headers.get("strict-transport-security")).toContain("max-age=")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(compose).not.toHaveBeenCalled()
    },
  )

  test.each([
    ["CLAXEDO_REQUEST_LIMITER", {}],
    ["LIVE_SYNC_ROOM", { idFromName: vi.fn() }],
    ["CLAXEDO_DOCUMENTS", {}],
  ] as const)("rejects a malformed %s binding instead of degrading", async (binding, malformed) => {
    const compose = vi.fn(() => ({ plane: {} as never, options: {} as never, documentAccess }))
    const worker = createHostedCoreWorker(compose)
    const bindings = { ...env(), [binding]: malformed }

    const response = await worker.fetch(
      new Request("https://core.example.test/api/claxedo/health"),
      bindings as never,
    )

    expect(response.status).toBe(503)
    expect(await response.text()).toContain(binding)
    expect(compose).not.toHaveBeenCalled()
  })

  test("an unhandled route error is captured once with its route and code, never the request body", async () => {
    const posted: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(String(init.body))
      return new Response("ok")
    }))
    const routes = new Hono().post("/api/things/:thingId", () => {
      throw new ClaxedoError({ code: "thing_store_unavailable", message: "Thing store is unavailable" })
    })
    mocks.createHostedCoreApp.mockReturnValue(routes)
    const plane = { env: { CLAXEDO_TELEMETRY_MODE: "on", CLAXEDO_POSTHOG_KEY: "phc_test", CLAXEDO_POSTHOG_HOST: "https://ph.test" } }
    const worker = createHostedCoreWorker(vi.fn(() => ({ plane: plane as never, options: {} as never, documentAccess })))
    const waits: Promise<unknown>[] = []

    const response = await worker.fetch(
      new Request("https://core.example.test/api/things/t_1", { method: "POST", body: "prompt: my secret plan" }),
      env(),
      { waitUntil: (work: Promise<unknown>) => waits.push(work), passThroughOnException: () => {}, props: {} } as never,
    )
    await Promise.all(waits)

    expect(response.status).toBe(500)
    expect(waits).toHaveLength(1)
    expect(posted).toHaveLength(1)
    const capture = JSON.parse(posted[0]!)
    expect(capture.event).toBe("$exception")
    expect(capture.distinct_id).toBe("system")
    expect(capture.properties).toMatchObject({ route: "/api/things/:thingId", method: "POST", code: "thing_store_unavailable" })
    expect(posted[0]).not.toContain("secret plan")
    expect(posted[0]).not.toContain("t_1")
    vi.unstubAllGlobals()
  })
})
