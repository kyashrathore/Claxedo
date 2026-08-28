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
    expect(compose).toHaveBeenCalledTimes(1)
    expect(mocks.createHostedCoreApp).toHaveBeenCalledTimes(1)
    expect(mocks.createHostedCoreApp).toHaveBeenCalledWith(selected.plane, expect.objectContaining({
      product,
      liveSyncRoom: bindings.LIVE_SYNC_ROOM,
      sharedRateLimitStore: expect.objectContaining({ periodSeconds: 60 }),
    }))
    expect("scheduled" in worker).toBe(false)
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
