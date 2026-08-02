import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { initRelayObservability, relayTelemetryOptions, reportFatal } from "./main"

/**
 * W2c (2026-07-28-001) observability gates, W3 kill-switch.
 *
 * Load-bearing contract: sending takes two opt-ins — CLAXEDO_TELEMETRY_MODE=on
 * AND CLAXEDO_POSTHOG_KEY (or the POSTHOG_KEY fallback). Miss either and the
 * relay's observability is a clean disabled no-op: relayTelemetryOptions
 * returns undefined, so initRelayObservability never reaches `new PostHog` and
 * reportFatal has no client to call. Safe to ship before any PostHog project
 * exists.
 *
 * The enabled path is asserted on the pure options resolver only: actually
 * constructing a PostHog client in a test process would start its background
 * flush timer, which no relay test should do. `{ enabled: false }` is itself
 * the no-construction proof — initRelayObservability only returns true on the
 * line after the constructor runs.
 */

/** Both opt-ins, spread into the env a test wants to reach the network. */
const ON = { CLAXEDO_TELEMETRY_MODE: "on" } as const

/** Shaped like a genuine PostHog project key, so the mode gate is provably
 *  what silences these envs rather than an obviously-invalid key. */
const REAL_KEY = "phc_0123456789abcdefghijklmnopqrstuvwxyzABCD"

describe("relayTelemetryOptions", () => {
  test("opted in but key absent → undefined (no client is ever constructed; zero network)", () => {
    expect(relayTelemetryOptions({ ...ON })).toBeUndefined()
  })

  test("whitespace-only key counts as absent", () => {
    expect(relayTelemetryOptions({ ...ON, CLAXEDO_POSTHOG_KEY: "   " })).toBeUndefined()
  })

  test("POSTHOG_KEY is accepted as a fallback when CLAXEDO_POSTHOG_KEY is unset", () => {
    expect(relayTelemetryOptions({ ...ON, POSTHOG_KEY: "phc_fallback" })).toEqual({
      key: "phc_fallback",
      host: "https://us.i.posthog.com",
      tags: { unit: "relay", deployment_mode: "local" },
    })
  })

  test("CLAXEDO_POSTHOG_KEY wins over POSTHOG_KEY when both are set", () => {
    const options = relayTelemetryOptions({
      ...ON,
      CLAXEDO_POSTHOG_KEY: "phc_primary",
      POSTHOG_KEY: "phc_fallback",
    })
    expect(options?.key).toBe("phc_primary")
  })

  test("both opt-ins → key/host/release/tags resolved", () => {
    const options = relayTelemetryOptions({
      ...ON,
      CLAXEDO_POSTHOG_KEY: "phc_abc123",
      CLAXEDO_RELEASE: "abc123",
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
    })
    expect(options).toEqual({
      key: "phc_abc123",
      host: "https://us.i.posthog.com",
      release: "abc123",
      tags: { unit: "relay", deployment_mode: "hosted" },
    })
  })

  test("host defaults to the canonical us.i.posthog.com ingest host, not the legacy app.posthog.com default", () => {
    expect(relayTelemetryOptions({ ...ON, CLAXEDO_POSTHOG_KEY: "phc_abc123" })?.host).toBe("https://us.i.posthog.com")
  })

  test("CLAXEDO_POSTHOG_HOST overrides the default ingest host", () => {
    const options = relayTelemetryOptions({
      ...ON,
      CLAXEDO_POSTHOG_KEY: "phc_abc123",
      CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com",
    })
    expect(options?.host).toBe("https://eu.i.posthog.com")
  })

  test("release: CLAXEDO_RELEASE wins over GIT_SHA; GIT_SHA accepted as alias", () => {
    const base = { ...ON, CLAXEDO_POSTHOG_KEY: "phc_abc123" }
    expect(relayTelemetryOptions({ ...base, CLAXEDO_RELEASE: "a", GIT_SHA: "b" })?.release).toBe("a")
    expect(relayTelemetryOptions({ ...base, GIT_SHA: "b" })?.release).toBe("b")
    expect(relayTelemetryOptions(base)?.release).toBeUndefined()
  })

  test("deployment mode: absent → local (D9 default), value lowercased", () => {
    const base = { ...ON, CLAXEDO_POSTHOG_KEY: "phc_abc123" }
    expect(relayTelemetryOptions(base)?.tags.deployment_mode).toBe("local")
    expect(
      relayTelemetryOptions({ ...base, CLAXEDO_DEPLOYMENT_MODE: "HOSTED" })?.tags.deployment_mode,
    ).toBe("hosted")
  })
})

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
    expect(relayTelemetryOptions({ ...key, CLAXEDO_TELEMETRY_MODE: "on" })).toBeDefined()
    expect(relayTelemetryOptions({ ...key, CLAXEDO_TELEMETRY_MODE: "off" })).toBeUndefined()
    expect(relayTelemetryOptions({ ...key, CLAXEDO_TELEMETRY_MODE: "true" })).toBeUndefined()
    expect(relayTelemetryOptions(key)).toBeUndefined()
  })

  test("`on` is matched case-insensitively after trimming", () => {
    const key = { CLAXEDO_POSTHOG_KEY: REAL_KEY }
    expect(relayTelemetryOptions({ ...key, CLAXEDO_TELEMETRY_MODE: "  ON  " })).toBeDefined()
    expect(relayTelemetryOptions({ ...key, CLAXEDO_TELEMETRY_MODE: "OFF" })).toBeUndefined()
  })

  test("mode off + a real-looking key → no client constructed and zero network, fatals included", async () => {
    const spy = watchFetch()
    expect(
      initRelayObservability({ CLAXEDO_TELEMETRY_MODE: "off", CLAXEDO_POSTHOG_KEY: REAL_KEY }),
    ).toEqual({ enabled: false })
    // A fatal is the relay's one capture path; it must find no client either.
    await expect(reportFatal(new Error("silenced by the switch"))).resolves.toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode unset + a real-looking key → no client constructed and zero network", async () => {
    const spy = watchFetch()
    expect(initRelayObservability({ CLAXEDO_POSTHOG_KEY: REAL_KEY })).toEqual({ enabled: false })
    await expect(reportFatal(new Error("silenced by the absent opt-in"))).resolves.toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode on + no key → clean no-op; saying `on` cannot start sending by itself", async () => {
    const spy = watchFetch()
    expect(initRelayObservability({ ...ON })).toEqual({ enabled: false })
    await expect(reportFatal(new Error("no key to send with"))).resolves.toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode on + key → the one combination that resolves options to send with", () => {
    expect(relayTelemetryOptions({ ...ON, CLAXEDO_POSTHOG_KEY: REAL_KEY })?.key).toBe(REAL_KEY)
  })
})

describe("initRelayObservability", () => {
  test("key absent → { enabled: false } cleanly, without touching the SDK", () => {
    expect(initRelayObservability({ ...ON })).toEqual({ enabled: false })
  })
})

describe("reportFatal", () => {
  // No test in this file ever calls initRelayObservability with BOTH opt-ins,
  // so the module-scoped client stays undefined for the whole run — this is
  // exactly what a fatal handler sees on a relay that never opted in.
  test("never throws when no client was ever initialized (key absent)", async () => {
    await expect(reportFatal(new Error("boom"))).resolves.toBeUndefined()
  })

  test("never throws for non-Error values either", async () => {
    await expect(reportFatal("a string, not an Error")).resolves.toBeUndefined()
  })
})
