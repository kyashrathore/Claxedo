import { describe, expect, test } from "vitest"
import { resolveTelemetryHost, resolveTelemetryKey, telemetryEnabled } from "./config"

/**
 * Observability gates.
 *
 * The load-bearing contract: sending takes two opt-ins — CLAXEDO_TELEMETRY_MODE=on
 * AND a PostHog key. Miss either and no key resolves, so the Worker's sink
 * sends nothing and throws nothing. The published
 * promises ("a build running in `on` mode is the only build that sends anything",
 * "no keys configured ⇒ nothing is sent") are exactly these assertions.
 */

/** Both opt-ins, spread into the env a test wants to reach the network. */
const ON = { CLAXEDO_TELEMETRY_MODE: "on" } as const

/** Shaped like a genuine PostHog project key, so the mode gate is provably
 *  what silences these envs rather than an obviously-invalid key. */
const REAL_KEY = "phc_0123456789abcdefghijklmnopqrstuvwxyzABCD"

describe("resolveTelemetryKey / resolveTelemetryHost", () => {
  test("CLAXEDO_POSTHOG_KEY wins over the unprefixed alias", () => {
    expect(resolveTelemetryKey({ ...ON, CLAXEDO_POSTHOG_KEY: "a", POSTHOG_KEY: "b" })).toBe("a")
    expect(resolveTelemetryKey({ ...ON, POSTHOG_KEY: "b" })).toBe("b")
    expect(resolveTelemetryKey({ ...ON })).toBeUndefined()
  })

  test("host defaults to the canonical ingest host and never keeps a trailing slash", () => {
    expect(resolveTelemetryHost({})).toBe("https://us.i.posthog.com")
    expect(resolveTelemetryHost({ CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com/" })).toBe("https://eu.i.posthog.com")
    expect(resolveTelemetryHost({ POSTHOG_HOST: "https://ph.internal//" })).toBe("https://ph.internal")
  })
})

describe("CLAXEDO_TELEMETRY_MODE", () => {
  test("only `on` opts in; off, unset and unrecognized values all mean off", () => {
    expect(telemetryEnabled({ ...ON })).toBe(true)
    expect(telemetryEnabled({ CLAXEDO_TELEMETRY_MODE: "off" })).toBe(false)
    expect(telemetryEnabled({})).toBe(false)
    expect(telemetryEnabled({ CLAXEDO_TELEMETRY_MODE: "true" })).toBe(false)
    expect(telemetryEnabled({ CLAXEDO_TELEMETRY_MODE: "1" })).toBe(false)
    expect(telemetryEnabled({ CLAXEDO_TELEMETRY_MODE: "enabled" })).toBe(false)
  })

  test("`on` is matched case-insensitively after trimming", () => {
    expect(telemetryEnabled({ CLAXEDO_TELEMETRY_MODE: "ON" })).toBe(true)
    expect(telemetryEnabled({ CLAXEDO_TELEMETRY_MODE: "  On  " })).toBe(true)
    expect(telemetryEnabled({ CLAXEDO_TELEMETRY_MODE: "OFF" })).toBe(false)
    expect(telemetryEnabled({ CLAXEDO_TELEMETRY_MODE: "  " })).toBe(false)
  })

  test("mode off + a real-looking key → no key resolves, so no sink can start", () => {
    expect(
      resolveTelemetryKey({ CLAXEDO_TELEMETRY_MODE: "off", CLAXEDO_POSTHOG_KEY: REAL_KEY }),
    ).toBeUndefined()
    // The unprefixed alias is silenced by the same branch.
    expect(resolveTelemetryKey({ CLAXEDO_TELEMETRY_MODE: "off", POSTHOG_KEY: REAL_KEY })).toBeUndefined()
  })

  test("mode unset + a real-looking key → still off (opting in is deliberate)", () => {
    expect(resolveTelemetryKey({ CLAXEDO_POSTHOG_KEY: REAL_KEY })).toBeUndefined()
  })

  test("mode on + no key → clean no-op; saying `on` cannot start sending by itself", () => {
    expect(resolveTelemetryKey({ ...ON })).toBeUndefined()
  })

  test("mode on + key → the one combination that resolves", () => {
    expect(resolveTelemetryKey({ ...ON, CLAXEDO_POSTHOG_KEY: REAL_KEY })).toBe(REAL_KEY)
  })
})
