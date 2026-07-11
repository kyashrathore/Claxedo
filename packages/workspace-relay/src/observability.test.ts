import { describe, expect, test } from "bun:test"
import { initRelayObservability, relaySentryOptions } from "./main"

/**
 * D12 observability gates (ops floor ADR 2026-07-11-016 §4).
 *
 * Load-bearing contract: with no CLAXEDO_RELAY_SENTRY_DSN the relay's
 * observability is a clean disabled no-op — Sentry.init is never reached
 * (relaySentryOptions returns undefined), so no client exists and no network
 * is ever attempted. Safe to ship before the Sentry account exists.
 *
 * The DSN-present path is asserted on the pure options resolver only:
 * actually calling Sentry.init in a test process would install a global
 * client, which no relay test should do.
 */

describe("relaySentryOptions", () => {
  test("DSN absent → undefined (init is never called; zero network)", () => {
    expect(relaySentryOptions({})).toBeUndefined()
  })

  test("whitespace-only DSN counts as absent", () => {
    expect(relaySentryOptions({ CLAXEDO_RELAY_SENTRY_DSN: "   " })).toBeUndefined()
  })

  test("DSN present → dsn/release/tags resolved, tracing off", () => {
    const options = relaySentryOptions({
      CLAXEDO_RELAY_SENTRY_DSN: "https://key@o1.ingest.sentry.io/3",
      CLAXEDO_RELEASE: "abc123",
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
    })
    expect(options).toEqual({
      dsn: "https://key@o1.ingest.sentry.io/3",
      release: "abc123",
      tracesSampleRate: 0,
      initialScope: { tags: { unit: "relay", deployment_mode: "hosted" } },
    })
  })

  test("release: CLAXEDO_RELEASE wins over GIT_SHA; GIT_SHA accepted as alias", () => {
    const base = { CLAXEDO_RELAY_SENTRY_DSN: "https://key@o1.ingest.sentry.io/3" }
    expect(relaySentryOptions({ ...base, CLAXEDO_RELEASE: "a", GIT_SHA: "b" })?.release).toBe("a")
    expect(relaySentryOptions({ ...base, GIT_SHA: "b" })?.release).toBe("b")
    expect(relaySentryOptions(base)?.release).toBeUndefined()
  })

  test("deployment mode: absent → self-host (D9 default), value lowercased", () => {
    const base = { CLAXEDO_RELAY_SENTRY_DSN: "https://key@o1.ingest.sentry.io/3" }
    expect(relaySentryOptions(base)?.initialScope.tags.deployment_mode).toBe("self-host")
    expect(
      relaySentryOptions({ ...base, CLAXEDO_DEPLOYMENT_MODE: "HOSTED" })?.initialScope.tags.deployment_mode,
    ).toBe("hosted")
  })
})

describe("initRelayObservability", () => {
  test("DSN absent → { enabled: false } cleanly, without touching the SDK", () => {
    expect(initRelayObservability({})).toEqual({ enabled: false })
  })
})
