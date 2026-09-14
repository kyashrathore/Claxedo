import { expect, test } from "vitest"
import { CREDENTIAL_BROKER_ERRORS } from "@claxedo/agent-runtime-contract"
import { BROKER_ROUTE_PATTERN, isBrokerPath, loopbackBrokerRoutes } from "./index.js"

const request = new Request("http://127.0.0.1:2595/bindings/binding/v1/messages", { method: "POST" })

test("a remote caller is refused in the broker's own vocabulary and never reaches it", async () => {
  const reached: Request[] = []
  const handle = loopbackBrokerRoutes({
    broker: async (incoming) => { reached.push(incoming); return new Response("ok") },
    isLoopback: () => false,
  })
  const response = await handle(request)
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    error: { code: "loopback_required", message: CREDENTIAL_BROKER_ERRORS.loopback_required.message },
  })
  expect(reached).toHaveLength(0)
})

test("a loopback caller reaches the broker with the request untouched", async () => {
  const handle = loopbackBrokerRoutes({ broker: async (incoming) => Response.json({ url: incoming.url }), isLoopback: () => true })
  expect(await (await handle(request)).json()).toEqual({ url: request.url })
})

test("the mount pattern and the CORS carve-out cover the same paths", () => {
  expect(BROKER_ROUTE_PATTERN).toBe("/bindings/*")
  expect(isBrokerPath("/bindings/binding/v1/messages")).toBe(true)
  expect(isBrokerPath("/bindings/")).toBe(true)
  expect(isBrokerPath("/api/claxedo/credentials")).toBe(false)
})
