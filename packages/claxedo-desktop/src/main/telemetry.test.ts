import { describe, expect, mock, test } from "bun:test"
import { PostHog } from "posthog-node"
import {
  captureFatal,
  createTelemetryClient,
  registerFatalHandlers,
  resolveBaseProperties,
  resolveHost,
  resolveKey,
} from "./telemetry"

describe("resolveKey", () => {
  test("no key configured", () => {
    expect(resolveKey({})).toBeUndefined()
  })

  test("blank key counts as absent", () => {
    expect(resolveKey({ CLAXEDO_POSTHOG_KEY: "   " })).toBeUndefined()
  })

  test("CLAXEDO_POSTHOG_KEY wins over the unprefixed fallback", () => {
    expect(resolveKey({ CLAXEDO_POSTHOG_KEY: "phc_primary", POSTHOG_KEY: "phc_fallback" })).toBe("phc_primary")
  })

  test("POSTHOG_KEY is accepted when CLAXEDO_POSTHOG_KEY is absent", () => {
    expect(resolveKey({ POSTHOG_KEY: "phc_fallback" })).toBe("phc_fallback")
  })
})

describe("resolveHost", () => {
  test("defaults to the canonical US ingest host", () => {
    expect(resolveHost({})).toBe("https://us.i.posthog.com")
  })

  test("CLAXEDO_POSTHOG_HOST overrides the default", () => {
    expect(resolveHost({ CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com" })).toBe("https://eu.i.posthog.com")
  })
})

describe("resolveBaseProperties", () => {
  test("fixed unit/deployment_mode tags, no release when unset", () => {
    expect(resolveBaseProperties({})).toEqual({
      unit: "desktop-main",
      deployment_mode: "desktop-local",
    })
  })

  test("CLAXEDO_RELEASE wins over GIT_SHA", () => {
    expect(resolveBaseProperties({ CLAXEDO_RELEASE: "a", GIT_SHA: "b" }).release).toBe("a")
  })

  test("falls back to GIT_SHA", () => {
    expect(resolveBaseProperties({ GIT_SHA: "b" }).release).toBe("b")
  })

  test("whitespace-only release counts as absent", () => {
    expect(resolveBaseProperties({ CLAXEDO_RELEASE: "   " }).release).toBeUndefined()
  })
})

describe("createTelemetryClient", () => {
  test("no key -> undefined: no client constructed, no network (the load-bearing gate)", () => {
    expect(createTelemetryClient({})).toBeUndefined()
  })

  test("blank key -> undefined", () => {
    expect(createTelemetryClient({ CLAXEDO_POSTHOG_KEY: "   " })).toBeUndefined()
  })

  test("key present -> a client is constructed with the resolved host", () => {
    const client = createTelemetryClient({ CLAXEDO_POSTHOG_KEY: "phc_test_key" })
    expect(client).toBeInstanceOf(PostHog)
    expect(client?.options.host).toBe("https://us.i.posthog.com")
  })

  test("key present -> honors a custom host", () => {
    const client = createTelemetryClient({
      CLAXEDO_POSTHOG_KEY: "phc_test_key",
      CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com",
    })
    expect(client?.options.host).toBe("https://eu.i.posthog.com")
  })
})

const baseProperties = { unit: "desktop-main", deployment_mode: "desktop-local" } as const

/** Minimal fake matching only the two methods captureFatal calls — a real
 *  PostHog client would attempt actual network I/O on flush(). */
function fakeClient(overrides: { captureException?: () => void; flush?: () => Promise<void> } = {}) {
  return {
    captureException: mock(overrides.captureException ?? (() => {})),
    flush: mock(overrides.flush ?? (() => Promise.resolve())),
  } as unknown as PostHog
}

describe("captureFatal", () => {
  test("no client -> resolves without touching anything", async () => {
    await expect(captureFatal(undefined, baseProperties, new Error("boom"))).resolves.toBeUndefined()
  })

  test("captures with the system distinct id and the base properties, then flushes", async () => {
    const client = fakeClient()
    const error = new Error("boom")
    await captureFatal(client, baseProperties, error)
    expect(client.captureException).toHaveBeenCalledWith(error, "system", baseProperties)
    expect(client.flush).toHaveBeenCalledTimes(1)
  })

  test("a throwing captureException never propagates", async () => {
    const client = fakeClient({
      captureException: () => {
        throw new Error("sink exploded")
      },
    })
    await expect(captureFatal(client, baseProperties, new Error("boom"))).resolves.toBeUndefined()
  })

  test("a rejecting flush never propagates", async () => {
    const client = fakeClient({ flush: () => Promise.reject(new Error("network down")) })
    await expect(captureFatal(client, baseProperties, new Error("boom"))).resolves.toBeUndefined()
  })

  test("a flush that never resolves is bounded by the timeout, not left hanging", async () => {
    const client = fakeClient({ flush: () => new Promise(() => {}) })
    // A short bound keeps this test fast; production uses the 2s default.
    await expect(captureFatal(client, baseProperties, new Error("boom"), 10)).resolves.toBeUndefined()
  })
})

describe("registerFatalHandlers", () => {
  test("wires exactly one uncaughtException and one unhandledRejection listener", () => {
    const before = {
      uncaught: process.listeners("uncaughtException"),
      rejection: process.listeners("unhandledRejection"),
    }

    registerFatalHandlers(undefined, baseProperties)

    const addedUncaught = process.listeners("uncaughtException").filter((l) => !before.uncaught.includes(l))
    const addedRejection = process.listeners("unhandledRejection").filter((l) => !before.rejection.includes(l))
    expect(addedUncaught).toHaveLength(1)
    expect(addedRejection).toHaveLength(1)

    // Remove only what this test added — never disturb bun:test's own
    // handlers, which the rest of this run's files depend on.
    addedUncaught.forEach((l) => process.removeListener("uncaughtException", l as NodeJS.UncaughtExceptionListener))
    addedRejection.forEach((l) => process.removeListener("unhandledRejection", l as NodeJS.UnhandledRejectionListener))
  })
})
