import { describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ createHostedCoreApp: vi.fn() }))

vi.mock("../hosted-shared/hosted-core-app", () => ({
  createHostedCoreApp: mocks.createHostedCoreApp,
}))

import { createHostedCoreWorker } from "./core-worker.cf"

function app() {
  return {
    onError: vi.fn(),
    fetch: vi.fn(async () => Response.json({ ok: true })),
  }
}

function env() {
  return {
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
    const selected = { plane: {} as never, options: { product } as never }
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
    // workspace/hostLink all canceled after 8-150s while auth routes worked).
    const firstApp = app()
    const secondApp = app()
    mocks.createHostedCoreApp.mockReset()
    mocks.createHostedCoreApp.mockReturnValueOnce(firstApp).mockReturnValueOnce(secondApp)
    const planes = [{ wedged: true }, { settled: true }]
    const compose = vi.fn(() => ({ plane: (planes.shift() ?? { settled: true }) as never, options: {} as never }))
    const worker = createHostedCoreWorker(compose)
    const bindings = env()

    await worker.fetch(new Request("https://core.example.test/api/claxedo/health"), bindings)
    await worker.fetch(new Request("https://core.example.test/api/claxedo/health"), bindings)

    expect(mocks.createHostedCoreApp).toHaveBeenCalledTimes(2)
    expect(firstApp.fetch).toHaveBeenCalledTimes(1)
    expect(secondApp.fetch).toHaveBeenCalledTimes(1)
  })

  test.each(["CLAXEDO_REQUEST_LIMITER", "LIVE_SYNC_ROOM"] as const)(
    "fails closed before composition when %s is absent",
    async (binding) => {
      mocks.createHostedCoreApp.mockReturnValue(app())
      const compose = vi.fn(() => ({ plane: {} as never, options: {} as never }))
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
  ] as const)("rejects a malformed %s binding instead of degrading", async (binding, malformed) => {
    const compose = vi.fn(() => ({ plane: {} as never, options: {} as never }))
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
})
