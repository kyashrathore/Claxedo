/// <reference types="bun" />
import { afterEach, expect, spyOn, test } from "bun:test"
import { createBrowserHostedAccount } from "./account"
import { createProductTelemetry, productHarness, productToolKind, productWhere } from "./telemetry"
import { createTransport } from "./transport"

const running: Array<{ stop: (force: boolean) => unknown }> = []
afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

function trackServer(status: number) {
  const received: Array<{ body: unknown; contentType: string | null; credentials: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/api/claxedo/track") return new Response("unexpected", { status: 500 })
      received.push({ body: await request.json(), contentType: request.headers.get("content-type"), credentials: request.headers.get("cookie") })
      return status === 200 ? Response.json({ ok: true }) : Response.json({ error: { code: "telemetry_event_refused", message: "no" } }, { status })
    },
  })
  running.push(server)
  return { received, transport: createTransport({ serverUrl: `http://127.0.0.1:${server.port}`, cookies: true }) }
}

test("a signed account sends the event to the control plane's track route as JSON", async () => {
  const { received, transport } = trackServer(200)
  const telemetry = createProductTelemetry(createBrowserHostedAccount(transport))

  telemetry.record({ event: "feature_used", properties: { feature: "review" } })

  for (let waited = 0; waited < 50 && received.length === 0; waited += 1) await Bun.sleep(10)
  expect(received).toEqual([{ body: { event: "feature_used", properties: { feature: "review" } }, contentType: expect.stringContaining("application/json"), credentials: null }])
})

test("a refused event is logged with its name, never thrown into the caller", async () => {
  const { received, transport } = trackServer(400)
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const telemetry = createProductTelemetry(createBrowserHostedAccount(transport))

  expect(() => telemetry.record({ event: "feature_used", properties: { feature: "file_open" } })).not.toThrow()

  for (let waited = 0; waited < 50 && warn.mock.calls.length === 0; waited += 1) await Bun.sleep(10)
  expect(received).toHaveLength(1)
  expect(warn).toHaveBeenCalledWith("A product event could not be recorded", expect.objectContaining({ event: "feature_used" }))
  warn.mockRestore()
})

test("without an account nothing is sent", () => {
  expect(() => createProductTelemetry(undefined).record({ event: "feature_used", properties: { feature: "terminal" } })).not.toThrow()
})

test("harness, placement and tool names map onto the allowlisted values", () => {
  expect([productHarness(undefined), productHarness("pi"), productHarness("conn_acme")]).toEqual(["default", "pi", "connection"])
  expect([productWhere("cloud"), productWhere("worktree"), productWhere(undefined)]).toEqual(["cloud", "machine", "machine"])
  expect([productToolKind("Bash"), productToolKind("edit_file"), productToolKind("mcp__github__search"), productToolKind("doom")])
    .toEqual(["bash", "edit", "mcp", "other"])
})
