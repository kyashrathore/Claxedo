import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
// Type-only: the real SDK is imported dynamically inside the two tests that
// construct a client, so the un-opted-in majority of this suite runs without
// posthog-node (and axios) ever loading — the same property telemetry.ts
// itself now guarantees.
import type { PostHog } from "posthog-node"
import {
  captureFatal,
  createTelemetryClient,
  registerFatalHandlers,
  resolveBaseProperties,
  resolveHost,
  resolveKey,
} from "./telemetry"

/** Both opt-ins, spread into the env a test wants to reach the network. */
const ON = { CLAXEDO_TELEMETRY_MODE: "on" } as const

/** Shaped like a genuine PostHog project key, so the mode gate is provably
 *  what silences these envs rather than an obviously-invalid key. */
const REAL_KEY = "phc_0123456789abcdefghijklmnopqrstuvwxyzABCD"

describe("resolveKey", () => {
  test("no key configured", () => {
    expect(resolveKey({ ...ON })).toBeUndefined()
  })

  test("blank key counts as absent", () => {
    expect(resolveKey({ ...ON, CLAXEDO_POSTHOG_KEY: "   " })).toBeUndefined()
  })

  test("CLAXEDO_POSTHOG_KEY wins over the unprefixed fallback", () => {
    expect(resolveKey({ ...ON, CLAXEDO_POSTHOG_KEY: "phc_primary", POSTHOG_KEY: "phc_fallback" })).toBe("phc_primary")
  })

  test("POSTHOG_KEY is accepted when CLAXEDO_POSTHOG_KEY is absent", () => {
    expect(resolveKey({ ...ON, POSTHOG_KEY: "phc_fallback" })).toBe("phc_fallback")
  })
})

/**
 * The desktop main process's half of the W3 switch. Sending takes
 * CLAXEDO_TELEMETRY_MODE=on AND a key; a Claxedo-distributed build opts in
 * explicitly at package time, and every other build stays silent.
 */
describe("CLAXEDO_TELEMETRY_MODE", () => {
  const fetchSpies: Array<{ mockRestore: () => void }> = []

  afterEach(() => {
    while (fetchSpies.length) fetchSpies.pop()!.mockRestore()
  })

  /** `fetch` is the only way anything leaves this process, so one spy covers
   *  every transport the PostHog SDK could reach for. */
  function watchFetch() {
    const spy = spyOn(globalThis, "fetch")
    fetchSpies.push(spy)
    return spy
  }

  test("only `on` opts in — off, unset and unrecognized values all mean off", () => {
    const key = { CLAXEDO_POSTHOG_KEY: REAL_KEY }
    expect(resolveKey({ ...key, CLAXEDO_TELEMETRY_MODE: "on" })).toBe(REAL_KEY)
    expect(resolveKey({ ...key, CLAXEDO_TELEMETRY_MODE: "off" })).toBeUndefined()
    expect(resolveKey({ ...key, CLAXEDO_TELEMETRY_MODE: "true" })).toBeUndefined()
    expect(resolveKey(key)).toBeUndefined()
  })

  test("`on` is matched case-insensitively after trimming", () => {
    const key = { CLAXEDO_POSTHOG_KEY: REAL_KEY }
    expect(resolveKey({ ...key, CLAXEDO_TELEMETRY_MODE: "  ON  " })).toBe(REAL_KEY)
    expect(resolveKey({ ...key, CLAXEDO_TELEMETRY_MODE: "OFF" })).toBeUndefined()
  })

  test("mode off + a real-looking key → no client constructed and zero network, fatals included", async () => {
    const spy = watchFetch()
    const client = await createTelemetryClient({ CLAXEDO_TELEMETRY_MODE: "off", CLAXEDO_POSTHOG_KEY: REAL_KEY })
    expect(client).toBeUndefined()
    // The fatal path is the only thing that would ever send; run it anyway.
    await captureFatal(client, resolveBaseProperties({}), new Error("silenced by the switch"))
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode unset + a real-looking key → no client constructed and zero network", async () => {
    const spy = watchFetch()
    const client = await createTelemetryClient({ CLAXEDO_POSTHOG_KEY: REAL_KEY })
    expect(client).toBeUndefined()
    await captureFatal(client, resolveBaseProperties({}), new Error("silenced by the absent opt-in"))
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode on + no key → clean no-op; saying `on` cannot start sending by itself", async () => {
    const spy = watchFetch()
    const client = await createTelemetryClient({ ...ON })
    expect(client).toBeUndefined()
    await captureFatal(client, resolveBaseProperties({}), new Error("no key to send with"))
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode on + key → the one combination that constructs a client", async () => {
    const { PostHog } = await import("posthog-node")
    expect(await createTelemetryClient({ ...ON, CLAXEDO_POSTHOG_KEY: REAL_KEY })).toBeInstanceOf(PostHog)
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
  test("opted in but no key -> undefined: no client constructed, no network (the load-bearing gate)", async () => {
    expect(await createTelemetryClient({ ...ON })).toBeUndefined()
  })

  test("blank key -> undefined", async () => {
    expect(await createTelemetryClient({ ...ON, CLAXEDO_POSTHOG_KEY: "   " })).toBeUndefined()
  })

  test("both opt-ins -> a client is constructed with the resolved host", async () => {
    const { PostHog } = await import("posthog-node")
    const client = await createTelemetryClient({ ...ON, CLAXEDO_POSTHOG_KEY: "phc_test_key" })
    expect(client).toBeInstanceOf(PostHog)
    expect(client?.options.host).toBe("https://us.i.posthog.com")
  })

  test("both opt-ins -> honors a custom host", async () => {
    const client = await createTelemetryClient({
      ...ON,
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
