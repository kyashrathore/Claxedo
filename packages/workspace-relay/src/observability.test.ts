import { describe, expect, test } from "bun:test"
import { initRelayObservability, relayTelemetryOptions, reportFatal } from "./main"

/**
 * W2c (2026-07-28-001) observability gates.
 *
 * Load-bearing contract: with no CLAXEDO_POSTHOG_KEY (nor the POSTHOG_KEY
 * fallback) the relay's observability is a clean disabled no-op —
 * relayTelemetryOptions returns undefined, so initRelayObservability never
 * constructs a PostHog client and reportFatal has no client to call. Safe to
 * ship before any PostHog project exists.
 *
 * The key-present path is asserted on the pure options resolver only:
 * actually constructing a PostHog client in a test process would start its
 * background flush timer, which no relay test should do.
 */

describe("relayTelemetryOptions", () => {
  test("key absent → undefined (no client is ever constructed; zero network)", () => {
    expect(relayTelemetryOptions({})).toBeUndefined()
  })

  test("whitespace-only key counts as absent", () => {
    expect(relayTelemetryOptions({ CLAXEDO_POSTHOG_KEY: "   " })).toBeUndefined()
  })

  test("POSTHOG_KEY is accepted as a fallback when CLAXEDO_POSTHOG_KEY is unset", () => {
    expect(relayTelemetryOptions({ POSTHOG_KEY: "phc_fallback" })).toEqual({
      key: "phc_fallback",
      host: "https://us.i.posthog.com",
      tags: { unit: "relay", deployment_mode: "self-host" },
    })
  })

  test("CLAXEDO_POSTHOG_KEY wins over POSTHOG_KEY when both are set", () => {
    const options = relayTelemetryOptions({
      CLAXEDO_POSTHOG_KEY: "phc_primary",
      POSTHOG_KEY: "phc_fallback",
    })
    expect(options?.key).toBe("phc_primary")
  })

  test("key present → key/host/release/tags resolved", () => {
    const options = relayTelemetryOptions({
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
    expect(relayTelemetryOptions({ CLAXEDO_POSTHOG_KEY: "phc_abc123" })?.host).toBe("https://us.i.posthog.com")
  })

  test("CLAXEDO_POSTHOG_HOST overrides the default ingest host", () => {
    const options = relayTelemetryOptions({
      CLAXEDO_POSTHOG_KEY: "phc_abc123",
      CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com",
    })
    expect(options?.host).toBe("https://eu.i.posthog.com")
  })

  test("release: CLAXEDO_RELEASE wins over GIT_SHA; GIT_SHA accepted as alias", () => {
    const base = { CLAXEDO_POSTHOG_KEY: "phc_abc123" }
    expect(relayTelemetryOptions({ ...base, CLAXEDO_RELEASE: "a", GIT_SHA: "b" })?.release).toBe("a")
    expect(relayTelemetryOptions({ ...base, GIT_SHA: "b" })?.release).toBe("b")
    expect(relayTelemetryOptions(base)?.release).toBeUndefined()
  })

  test("deployment mode: absent → self-host (D9 default), value lowercased", () => {
    const base = { CLAXEDO_POSTHOG_KEY: "phc_abc123" }
    expect(relayTelemetryOptions(base)?.tags.deployment_mode).toBe("self-host")
    expect(
      relayTelemetryOptions({ ...base, CLAXEDO_DEPLOYMENT_MODE: "HOSTED" })?.tags.deployment_mode,
    ).toBe("hosted")
  })
})

describe("initRelayObservability", () => {
  test("key absent → { enabled: false } cleanly, without touching the SDK", () => {
    expect(initRelayObservability({})).toEqual({ enabled: false })
  })
})

describe("reportFatal", () => {
  // No test in this file ever calls initRelayObservability with a truthy
  // key, so the module-scoped client stays undefined for the whole run —
  // this is exactly what a fatal handler sees when the relay boots with no
  // PostHog key configured.
  test("never throws when no client was ever initialized (key absent)", async () => {
    await expect(reportFatal(new Error("boom"))).resolves.toBeUndefined()
  })

  test("never throws for non-Error values either", async () => {
    await expect(reportFatal("a string, not an Error")).resolves.toBeUndefined()
  })
})
