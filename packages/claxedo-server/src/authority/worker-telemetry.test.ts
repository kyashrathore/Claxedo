import { afterEach, describe, expect, test, vi } from "vitest"
import { exceptionIdentity, parseStackFrames, workerErrorCapture, workerTelemetry } from "./worker-telemetry"

/**
 * The Worker cannot use `posthog-node` (forbidden import), so its `$exception`
 * payload is assembled by hand. These gates hold that hand-rolled shape and the
 * no-network contract both sinks share: sending takes CLAXEDO_TELEMETRY_MODE=on
 * AND a key, and `fetch` is the whole transport, so a fetch spy sees everything
 * either sink could possibly send.
 */

/** Both opt-ins, spread into the env a test wants to reach the network. */
const ON = { CLAXEDO_TELEMETRY_MODE: "on" } as const

/** Shaped like a genuine PostHog project key, so the mode gate is provably
 *  what silences these envs rather than an obviously-invalid key. */
const REAL_KEY = "phc_0123456789abcdefghijklmnopqrstuvwxyzABCD"

afterEach(() => {
  vi.unstubAllGlobals()
})

function fetchSpy() {
  const spy = vi.fn(async () => new Response("ok"))
  vi.stubGlobal("fetch", spy)
  return spy
}

describe("parseStackFrames", () => {
  test("parses named, anonymous, async, and constructor frames", () => {
    const frames = parseStackFrames(
      [
        "Error: boom",
        "    at handleRequest (/app/src/routes/x.ts:12:7)",
        "    at /app/src/hosted-app.ts:44:19",
        "    at async Object.fetch (file:///app/src/worker.ts:250:5)",
        "    at new HostedPlane (/app/src/plane.ts:8:11)",
      ].join("\n"),
    )
    // Innermost-last ordering: the throwing frame ends the list, which is the
    // order $exception_list stacktraces are read in. V8 emits the reverse.
    expect(frames).toEqual([
      { platform: "web:javascript", filename: "/app/src/plane.ts", function: "HostedPlane", in_app: true, lineno: 8, colno: 11 },
      { platform: "web:javascript", filename: "file:///app/src/worker.ts", function: "Object.fetch", in_app: true, lineno: 250, colno: 5 },
      { platform: "web:javascript", filename: "/app/src/hosted-app.ts", function: "<anonymous>", in_app: true, lineno: 44, colno: 19 },
      { platform: "web:javascript", filename: "/app/src/routes/x.ts", function: "handleRequest", in_app: true, lineno: 12, colno: 7 },
    ])
  })

  test("non-Error inputs and unparseable frames yield no frames rather than guesses", () => {
    expect(parseStackFrames(undefined)).toEqual([])
    expect(parseStackFrames(null)).toEqual([])
    expect(parseStackFrames(42)).toEqual([])
    expect(parseStackFrames("")).toEqual([])
    expect(parseStackFrames("Error: boom\n    at <anonymous>\n    at native")).toEqual([])
  })

  test("frame count is bounded so a runaway recursion cannot produce a huge payload", () => {
    const stack = ["Error: deep", ...Array.from({ length: 500 }, (_, i) => `    at f${i} (/a.ts:${i + 1}:1)`)].join("\n")
    expect(parseStackFrames(stack)).toHaveLength(50)
  })
})

describe("exceptionIdentity", () => {
  test("Errors keep name and message; thrown non-Errors still group", () => {
    expect(exceptionIdentity(new TypeError("bad type"))).toEqual({ type: "TypeError", value: "bad type" })
    expect(exceptionIdentity("string throw")).toEqual({ type: "Error", value: "string throw" })
    expect(exceptionIdentity({ name: "HTTPError", message: "503" })).toEqual({ type: "HTTPError", value: "503" })
    expect(exceptionIdentity(undefined)).toEqual({ type: "Error", value: "undefined" })
  })
})

describe("workerTelemetry", () => {
  test("opted in but key absent → zero network", () => {
    const spy = fetchSpy()
    workerTelemetry({ ...ON }).capture("user_1", "thing.happened", { a: 1 })
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode off + a real-looking key → zero network", () => {
    const spy = fetchSpy()
    workerTelemetry({ CLAXEDO_TELEMETRY_MODE: "off", CLAXEDO_POSTHOG_KEY: REAL_KEY })
      .capture("user_1", "thing.happened", { a: 1 })
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode unset + a real-looking key → zero network", () => {
    const spy = fetchSpy()
    workerTelemetry({ CLAXEDO_POSTHOG_KEY: REAL_KEY }).capture("user_1", "thing.happened", { a: 1 })
    expect(spy).not.toHaveBeenCalled()
  })

  test("both opt-ins → one POST to /capture/ with the event payload", () => {
    const spy = fetchSpy()
    workerTelemetry({ ...ON, CLAXEDO_POSTHOG_KEY: "phc_w" }).capture("user_1", "thing.happened", { a: 1 })
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://us.i.posthog.com/capture/")
    expect(JSON.parse(init.body as string)).toEqual({
      api_key: "phc_w",
      event: "thing.happened",
      distinct_id: "user_1",
      properties: { a: 1 },
    })
  })
})

describe("workerErrorCapture", () => {
  test("opted in but key absent → zero network, and the promise still resolves", async () => {
    const spy = fetchSpy()
    await workerErrorCapture({ ...ON }).captureException(new Error("boom"), "system", { unit: "worker" })
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode off + a real-looking key → zero network, and the promise still resolves", async () => {
    const spy = fetchSpy()
    await workerErrorCapture({ CLAXEDO_TELEMETRY_MODE: "off", CLAXEDO_POSTHOG_KEY: REAL_KEY })
      .captureException(new Error("boom"), "system", { unit: "worker" })
    expect(spy).not.toHaveBeenCalled()
  })

  test("mode unset + a real-looking key → zero network, and the promise still resolves", async () => {
    const spy = fetchSpy()
    await workerErrorCapture({ CLAXEDO_POSTHOG_KEY: REAL_KEY })
      .captureException(new Error("boom"), "system", { unit: "worker" })
    expect(spy).not.toHaveBeenCalled()
  })

  test("both opt-ins → exactly one $exception POST carrying the exception list and tags", async () => {
    const spy = fetchSpy()
    const error = new Error("route blew up")
    error.stack = "Error: route blew up\n    at handleRequest (/app/src/routes/x.ts:12:7)"

    await workerErrorCapture({ ...ON, CLAXEDO_POSTHOG_KEY: "phc_w", CLAXEDO_POSTHOG_HOST: "https://eu.i.posthog.com" })
      .captureException(error, "user_7", { unit: "worker", page_class: "payment" })

    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://eu.i.posthog.com/capture/")
    const body = JSON.parse(init.body as string)
    expect(body.api_key).toBe("phc_w")
    expect(body.event).toBe("$exception")
    expect(body.distinct_id).toBe("user_7")
    // Tags ride as top-level properties so an alert rule can match page_class.
    expect(body.properties.unit).toBe("worker")
    expect(body.properties.page_class).toBe("payment")
    expect(body.properties.$exception_list).toEqual([
      {
        type: "Error",
        value: "route blew up",
        mechanism: { handled: false, synthetic: false },
        stacktrace: {
          type: "raw",
          frames: [
            { platform: "web:javascript", filename: "/app/src/routes/x.ts", function: "handleRequest", in_app: true, lineno: 12, colno: 7 },
          ],
        },
      },
    ])
  })

  test("a failing capture never propagates into the caller", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down")
    }))
    await expect(
      workerErrorCapture({ ...ON, CLAXEDO_POSTHOG_KEY: "phc_w" }).captureException(new Error("boom"), "system"),
    ).resolves.toBeUndefined()
  })
})
