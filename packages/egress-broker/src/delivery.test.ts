import { expect, test } from "vitest"
import { createGenericDeliveryAdapter, verifyRuntimeToken, type Binding } from "./index.js"
import { listenLoopbackBroker } from "./node.js"

test("loopback delivery streams with rotated credentials and rejects withdrawn capabilities", async () => {
  const key = new Uint8Array(32).fill(9)
  const adapter = createGenericDeliveryAdapter({ signingKey: key, reportFailure: async () => {} })
  const binding: Binding = {
    id: "b1", userId: "user", orgId: "org", workspaceId: "workspace", leaseId: "lease", leaseGeneration: 1, runtimeId: "runtime",
    credentialId: "credential", revision: 1, status: "active",
    destination: { origin: "https://api.vendor.test", methods: ["POST"], pathPrefixes: ["/v1/messages"] },
    injection: { header: "x-api-key" },
  }
  const received: string[] = []
  const broker = await listenLoopbackBroker({
    authority: adapter.authority,
    verifyToken: (token) => verifyRuntimeToken(token, key),
    fetch: (async (_url, init) => {
      received.push(new Headers(init?.headers).get("x-api-key")!)
      return new Response("data: hello\n\n", { headers: { "content-type": "text/event-stream" } })
    }) as typeof fetch,
  })
  try {
    adapter.activateRuntime(binding)
    adapter.apply(binding, "key-one")
    const projection = await adapter.project(binding.id, broker.origin, Date.now() + 60_000)
    expect(JSON.stringify(projection)).not.toContain("key-one")
    const send = () => fetch(`${projection.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": projection.placeholder }, body: "prompt" })
    expect(await (await send()).text()).toBe("data: hello\n\n")
    adapter.rotate({ ...binding, revision: 2 }, "key-two")
    expect((await send()).status).toBe(200)
    expect(received).toEqual(["key-one", "key-two"])
    expect(() => adapter.rotate(binding, "stale-key")).toThrow("revision")
    adapter.withdraw(binding.id, 3)
    expect((await send()).status).toBe(403)
    expect(() => adapter.apply({ ...binding, revision: 4 }, "revived-key")).toThrow("Withdrawn")
    adapter.withdrawRuntime(binding.leaseId)
    expect(() => adapter.activateRuntime(binding)).toThrow("generation")
  } finally {
    await broker.close()
    adapter.dispose()
  }
})
