import { afterEach, describe, expect, test, vi } from "vitest"
import { reportError, reportPaymentError, setErrorReporterSink } from "./report"
import {
  deploymentModeTag,
  observabilityOptions,
  resolveRelease,
  resolveTelemetryHost,
  resolveTelemetryKey,
  telemetryEnabled,
} from "./config"
import { initNodeObservability } from "./node"
import { initPostHog, shutdownPostHog } from "../observability/posthog"
import { deploymentMode } from "../authority/deployment-mode"

/**
 * Observability gates.
 *
 * The load-bearing contract: sending takes two opt-ins — CLAXEDO_TELEMETRY_MODE=on
 * AND a PostHog key. Miss either and every entrypoint's observability is a clean
 * disabled no-op: no client construction, no network, no throw. The published
 * promises ("a build running in `on` mode is the only build that sends anything",
 * "no keys configured ⇒ nothing is sent") are exactly these assertions.
 */

/** Both opt-ins, spread into the env a test wants to reach the network. */
const ON = { CLAXEDO_TELEMETRY_MODE: "on" } as const

/** Shaped like a genuine PostHog project key, so the mode gate is provably
 *  what silences these envs rather than an obviously-invalid key. */
const REAL_KEY = "phc_0123456789abcdefghijklmnopqrstuvwxyzABCD"

const postHogMock = vi.hoisted(() => {
  const captureException = vi.fn()
  const capture = vi.fn()
  const shutdown = vi.fn(async () => {})
  const flush = vi.fn(async () => {})
  const construct = vi.fn()
  class PostHog {
    captureException = captureException
    capture = capture
    shutdown = shutdown
    flush = flush
    constructor(key: string, options: unknown) {
      construct(key, options)
    }
  }
  return { PostHog, captureException, capture, shutdown, flush, construct }
})

vi.mock("posthog-node", () => ({ PostHog: postHogMock.PostHog }))

afterEach(async () => {
  setErrorReporterSink(undefined)
  // The client is module-cached in posthog.ts; drop it so each test's env wins.
  await shutdownPostHog()
  postHogMock.construct.mockClear()
  postHogMock.captureException.mockClear()
  postHogMock.capture.mockClear()
})

describe("observabilityOptions", () => {
  test("opted in but key absent → disabled no-op options (enabled false, no key)", () => {
    const options = observabilityOptions({ ...ON }, "worker")
    expect(options.enabled).toBe(false)
    expect(options.key).toBeUndefined()
  })

  test("whitespace-only key counts as absent", () => {
    expect(observabilityOptions({ ...ON, CLAXEDO_POSTHOG_KEY: "   " }, "server").enabled).toBe(false)
  })

  test("both opt-ins → enabled, tagged with unit and deployment mode", () => {
    const options = observabilityOptions(
      {
        ...ON,
        CLAXEDO_POSTHOG_KEY: "phc_abc",
        CLAXEDO_RELEASE: "abc123",
        CLAXEDO_DEPLOYMENT_MODE: "hosted",
      },
      "worker",
    )
    expect(options.enabled).toBe(true)
    expect(options.key).toBe("phc_abc")
    expect(options.release).toBe("abc123")
    expect(options.host).toBe("https://us.i.posthog.com")
    expect(options.tags).toEqual({
      unit: "worker",
      deployment_mode: "hosted",
      deployment_runtime: "workerd",
      release: "abc123",
    })
  })
})

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

/**
 * CLAXEDO_TELEMETRY_MODE at the chokepoint every server-side sink resolves
 * through. resolveTelemetryKey folds both opt-ins into one answer, so proving
 * the gate here proves it for posthog.ts, observability/node.ts,
 * authority/worker-telemetry.ts, and worker.ts's sink registration; each of
 * those still gets its own end-to-end assertion below or in its own file.
 */
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
    expect(
      observabilityOptions({ CLAXEDO_TELEMETRY_MODE: "off", CLAXEDO_POSTHOG_KEY: REAL_KEY }, "worker").enabled,
    ).toBe(false)
  })

  test("mode unset + a real-looking key → still off (opting in is deliberate)", () => {
    expect(resolveTelemetryKey({ CLAXEDO_POSTHOG_KEY: REAL_KEY })).toBeUndefined()
    expect(observabilityOptions({ CLAXEDO_POSTHOG_KEY: REAL_KEY }, "server").enabled).toBe(false)
  })

  test("mode on + no key → clean no-op; saying `on` cannot start sending by itself", () => {
    expect(resolveTelemetryKey({ ...ON })).toBeUndefined()
    expect(observabilityOptions({ ...ON }, "server").enabled).toBe(false)
  })

  test("mode on + key → the one combination that resolves", () => {
    expect(resolveTelemetryKey({ ...ON, CLAXEDO_POSTHOG_KEY: REAL_KEY })).toBe(REAL_KEY)
    expect(observabilityOptions({ ...ON, CLAXEDO_POSTHOG_KEY: REAL_KEY }, "server").enabled).toBe(true)
  })
})

describe("resolveRelease", () => {
  test("CLAXEDO_RELEASE wins over GIT_SHA", () => {
    expect(resolveRelease({ CLAXEDO_RELEASE: "a", GIT_SHA: "b" })).toBe("a")
  })

  test("falls back GIT_SHA → undefined; vendor-named release vars are not read", () => {
    expect(resolveRelease({ GIT_SHA: "b" })).toBe("b")
    expect(resolveRelease({ SENTRY_RELEASE: "c" })).toBeUndefined()
    expect(resolveRelease({})).toBeUndefined()
  })
})

describe("deploymentModeTag", () => {
  test("absent mode = local (D9 default); hosted passes through lowercased", () => {
    expect(deploymentModeTag({})).toBe("local")
    expect(deploymentModeTag({ CLAXEDO_DEPLOYMENT_MODE: "HOSTED" })).toBe("hosted")
  })

  test("never throws on unrecognized values (reports posture, does not enforce it)", () => {
    expect(deploymentModeTag({ CLAXEDO_DEPLOYMENT_MODE: "banana" })).toBe("banana")
  })

  test("its default agrees with the Trust enum, so a rename cannot silently skew telemetry", () => {
    // This tag pass-through is deliberate (it must never throw), which is
    // exactly what makes it dangerous during a rename: left behind, it would
    // keep emitting a retired value forever while the boot path failed loudly.
    // Pin the default to a value deploymentMode() actually accepts.
    const tagDefault = deploymentModeTag({})
    expect(deploymentMode({ CLAXEDO_DEPLOYMENT_MODE: tagDefault })).toBe(tagDefault)

    // And every Trust value must survive the round trip.
    for (const trust of ["local", "hosted"] as const) {
      expect(deploymentModeTag({ CLAXEDO_DEPLOYMENT_MODE: trust })).toBe(trust)
      expect(deploymentMode({ CLAXEDO_DEPLOYMENT_MODE: trust })).toBe(trust)
    }
  })
})

describe("report seam", () => {
  test("reportError without a sink is a silent no-op", () => {
    expect(() => reportError(new Error("nobody listening"))).not.toThrow()
  })

  test("sink receives error, tags, and extra", () => {
    const sink = vi.fn()
    setErrorReporterSink(sink)
    const err = new Error("boom")
    reportError(err, { tags: { source: "test" }, extra: { path: "/x" } })
    expect(sink).toHaveBeenCalledWith(err, {
      tags: { source: "test" },
      extra: { path: "/x" },
    })
  })

  test("reportPaymentError stamps the payment page class (ADR page class 1 of 2)", () => {
    const sink = vi.fn()
    setErrorReporterSink(sink)
    reportPaymentError(new Error("webhook signature failed"), { tags: { route: "polar_webhook" } })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]![1]).toEqual({
      tags: { route: "polar_webhook", page_class: "payment" },
      extra: {},
    })
  })

  test("a throwing sink never propagates into the request path", () => {
    setErrorReporterSink(() => {
      throw new Error("sink exploded")
    })
    expect(() => reportError(new Error("original"))).not.toThrow()
  })
})

describe("initNodeObservability", () => {
  test("opted in but key absent → { enabled: false }, no client is constructed (no network)", () => {
    expect(initNodeObservability({ ...ON })).toEqual({ enabled: false })
    expect(postHogMock.construct).not.toHaveBeenCalled()
    // And no sink got registered: reports stay no-ops.
    reportError(new Error("still nobody listening"))
    expect(postHogMock.captureException).not.toHaveBeenCalled()
  })

  test("both opt-ins → client built with host/flush options and the sink forwards reports", () => {
    const result = initNodeObservability({
      ...ON,
      CLAXEDO_POSTHOG_KEY: "phc_server",
      GIT_SHA: "deadbeef",
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
    })
    expect(result).toEqual({ enabled: true })
    expect(postHogMock.construct).toHaveBeenCalledTimes(1)
    const [key, options] = postHogMock.construct.mock.calls[0] as [string, { host: string }]
    expect(key).toBe("phc_server")
    expect(options.host).toBe("https://us.i.posthog.com")

    const err = new Error("route blew up")
    reportError(err, { tags: { source: "server_route" }, extra: { path: "/x" } })
    expect(postHogMock.captureException).toHaveBeenCalledWith(err, "system", {
      unit: "server",
      deployment_mode: "hosted",
      deployment_runtime: "node",
      release: "deadbeef",
      source: "server_route",
      path: "/x",
    })
  })

  test("I-5: the exception payload is exactly the explicit properties — nothing is auto-attached", () => {
    initNodeObservability({ ...ON, CLAXEDO_POSTHOG_KEY: "phc_server" })
    reportError(new Error("boom"), { tags: { source: "server_route" }, extra: { path: "/x" } })
    const properties = postHogMock.captureException.mock.calls[0]![2] as Record<string, unknown>
    // Exact key set: base tags + caller tags/extra. If an SDK upgrade or a
    // future integration ever starts attaching request context (headers,
    // cookies, bodies — where live credentials ride), this fails loudly.
    expect(Object.keys(properties).sort()).toEqual([
      "deployment_mode",
      "deployment_runtime",
      "path",
      "source",
      "unit",
    ])
    for (const forbidden of ["request", "headers", "cookies", "query_string", "data", "body"]) {
      expect(properties).not.toHaveProperty(forbidden)
    }
  })

  test("a call site that knows the user keys the exception to them, not to system", () => {
    initNodeObservability({ ...ON, CLAXEDO_POSTHOG_KEY: "phc_server" })
    const err = new Error("checkout failed")
    reportPaymentError(err, { tags: { user_id: "user_42" } })
    expect(postHogMock.captureException).toHaveBeenCalledWith(err, "user_42", {
      unit: "server",
      deployment_mode: "local",
      deployment_runtime: "node",
      user_id: "user_42",
      page_class: "payment",
    })
  })

  test("mode off + a real-looking key → no client, no sink, no capture", () => {
    expect(
      initNodeObservability({ CLAXEDO_TELEMETRY_MODE: "off", CLAXEDO_POSTHOG_KEY: REAL_KEY }),
    ).toEqual({ enabled: false })
    expect(postHogMock.construct).not.toHaveBeenCalled()
    reportError(new Error("silenced by the switch"))
    expect(postHogMock.captureException).not.toHaveBeenCalled()
  })

  test("mode unset + a real-looking key → no client, no sink, no capture", () => {
    expect(initNodeObservability({ CLAXEDO_POSTHOG_KEY: REAL_KEY })).toEqual({ enabled: false })
    expect(postHogMock.construct).not.toHaveBeenCalled()
    reportError(new Error("silenced by the absent opt-in"))
    expect(postHogMock.captureException).not.toHaveBeenCalled()
  })
})

/**
 * posthog.ts owns the client both planes share, so it carries the same gate
 * independently of the error-sink wrapper above — server.ts calls initPostHog()
 * directly for product events.
 */
describe("initPostHog", () => {
  test("mode off + a real-looking key → null, and no client is constructed", () => {
    expect(initPostHog({ CLAXEDO_TELEMETRY_MODE: "off", CLAXEDO_POSTHOG_KEY: REAL_KEY })).toBeNull()
    expect(postHogMock.construct).not.toHaveBeenCalled()
  })

  test("mode unset + a real-looking key → null, and no client is constructed", () => {
    expect(initPostHog({ CLAXEDO_POSTHOG_KEY: REAL_KEY })).toBeNull()
    expect(postHogMock.construct).not.toHaveBeenCalled()
  })

  test("mode on + no key → null, and no client is constructed", () => {
    expect(initPostHog({ ...ON })).toBeNull()
    expect(postHogMock.construct).not.toHaveBeenCalled()
  })

  test("mode on + key → exactly one client, built against the resolved host", () => {
    expect(initPostHog({ ...ON, CLAXEDO_POSTHOG_KEY: REAL_KEY })).not.toBeNull()
    expect(postHogMock.construct).toHaveBeenCalledTimes(1)
    const [key, options] = postHogMock.construct.mock.calls[0] as [string, { host: string }]
    expect(key).toBe(REAL_KEY)
    expect(options.host).toBe("https://us.i.posthog.com")
  })
})
