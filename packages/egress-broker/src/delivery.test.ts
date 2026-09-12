import { expect, test, vi } from "vitest"
import { createGenericDeliveryAdapter, mintRuntimeToken, verifyRuntimeToken, type Binding } from "./index.js"
import { listenLoopbackBroker } from "./node.js"

const binding: Binding = {
  id: "b1", userId: "user", orgId: "org", workspaceId: "workspace", leaseId: "lease", leaseGeneration: 1, runtimeId: "runtime",
  credentialId: "credential", revision: 1, status: "active",
  destination: { origin: "https://api.vendor.test", methods: ["POST"], pathPrefixes: ["/v1/messages"] },
  injection: { header: "x-api-key" },
}

test("loopback delivery streams with rotated credentials and rejects withdrawn capabilities", async () => {
  const key = new Uint8Array(32).fill(9)
  const adapter = createGenericDeliveryAdapter({ signingKey: key, reportFailure: async () => {} })
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

test("loopback transport delivers incremental chunks and cancels upstream on client disconnect", async () => {
  const key = new Uint8Array(32).fill(11)
  const adapter = createGenericDeliveryAdapter({ signingKey: key, reportFailure: async () => {} })
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const encode = (text: string) => new TextEncoder().encode(text)
  const broker = await listenLoopbackBroker({
    authority: adapter.authority,
    verifyToken: (token) => verifyRuntimeToken(token, key),
    fetch: (async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { controller = stream; stream.enqueue(encode("data: first\n\n")) },
      cancel() { cancelled = true },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
  })
  try {
    adapter.activateRuntime(binding)
    adapter.apply(binding, "key-one")
    const projection = await adapter.project(binding.id, broker.origin, Date.now() + 60_000)
    const response = await fetch(`${projection.baseUrl}/v1/messages`, {
      method: "POST", headers: { "x-api-key": projection.placeholder }, body: "prompt",
    })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n")
    controller.enqueue(encode("data: second\n\n"))
    const second = await reader.read()
    expect(second.done).toBe(false)
    expect(new TextDecoder().decode(second.value)).toBe("data: second\n\n")
    await reader.cancel()
    await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 1000, interval: 25 })
  } finally {
    await broker.close()
    adapter.dispose()
  }
})

/**
 * `fetch` decodes the upstream body before the broker ever sees it, so a
 * forwarded `content-encoding` describes bytes that no longer exist. Anthropic
 * compresses its responses, and a real client reading this through the loopback
 * listener fails with `Z_DATA_ERROR: incorrect header check`.
 */
test("a decoded upstream body is not relabelled with the upstream's encoding", async () => {
  const key = new Uint8Array(32).fill(13)
  const adapter = createGenericDeliveryAdapter({ signingKey: key, reportFailure: async () => {} })
  const broker = await listenLoopbackBroker({
    authority: adapter.authority,
    verifyToken: (token) => verifyRuntimeToken(token, key),
    fetch: (async () => new Response('{"ok":true}', {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    })) as typeof fetch,
  })
  try {
    adapter.activateRuntime(binding)
    adapter.apply(binding, "key-one")
    const projection = await adapter.project(binding.id, broker.origin, Date.now() + 60_000)
    const response = await fetch(`${projection.baseUrl}/v1/messages`, {
      method: "POST", headers: { "x-api-key": projection.placeholder }, body: "prompt",
    })
    expect(response.headers.get("content-encoding")).toBeNull()
    await expect(response.json()).resolves.toEqual({ ok: true })
  } finally {
    await broker.close()
    adapter.dispose()
  }
})

test("a runtime token cannot outlive one hour", async () => {
  const key = new Uint8Array(32).fill(7)
  const now = 1_700_000_000_000
  await expect(mintRuntimeToken({ ...binding, bindingIds: ["b1"], expiresAt: now + 3_600_001 }, key, now))
    .rejects.toThrow("one hour")
  await expect(mintRuntimeToken({ ...binding, bindingIds: ["b1"], expiresAt: now + 3_600_000 }, key, now))
    .resolves.toBeTypeOf("string")

  // A shorter request is the caller's to make and is kept as asked.
  const short = await mintRuntimeToken({ ...binding, bindingIds: ["b1"], expiresAt: now + 30_000 }, key, now)
  expect((await verifyRuntimeToken(short, key, now))?.exp).toBe(Math.floor((now + 30_000) / 1000))

  const adapter = createGenericDeliveryAdapter({ signingKey: key, reportFailure: async () => {} })
  adapter.activateRuntime(binding)
  adapter.apply(binding, "key-one")
  await expect(adapter.project(binding.id, "https://broker.test", Date.now() + 7_200_000)).rejects.toThrow("one hour")
  adapter.dispose()
})

test("a superseded generation's bindings and values are evicted", async () => {
  const adapter = createGenericDeliveryAdapter({ signingKey: new Uint8Array(32).fill(3), reportFailure: async () => {} })
  try {
    adapter.activateRuntime(binding)
    adapter.apply(binding, "key-one")
    expect(await adapter.authority.resolve(binding.id)).toBeDefined()

    adapter.activateRuntime({ ...binding, leaseGeneration: 2, runtimeId: "runtime-2" })

    // `resolve` hands the broker the credential before `currentRuntime` is
    // consulted, so the replaced generation's value must not survive here.
    expect(await adapter.authority.resolve(binding.id)).toBeUndefined()
  } finally {
    adapter.dispose()
  }
})

test("a destination the broker could only refuse at request time is refused at apply", async () => {
  const adapter = createGenericDeliveryAdapter({ signingKey: new Uint8Array(32).fill(5), reportFailure: async () => {} })
  try {
    adapter.activateRuntime(binding)
    const destinations = [
      { ...binding.destination, origin: "http://api.vendor.test" },
      { ...binding.destination, origin: "https://user:pass@api.vendor.test" },
      { ...binding.destination, origin: "https://api.vendor.test/v1" },
      { ...binding.destination, origin: "not a url" },
      { ...binding.destination, pathPrefixes: [] },
      { ...binding.destination, pathPrefixes: ["v1/messages"] },
      { ...binding.destination, methods: [] },
      // The broker matches `Request.method`, which is upper-case, so a
      // lower-case method here denies every request instead of allowing one.
      { ...binding.destination, methods: ["post"] },
    ]
    for (const destination of destinations) {
      expect(() => adapter.apply({ ...binding, destination }, "key-one"), destination.origin)
        .toThrow("destination")
    }
    expect(() => adapter.apply(binding, "key-one")).not.toThrow()
  } finally {
    adapter.dispose()
  }
})
