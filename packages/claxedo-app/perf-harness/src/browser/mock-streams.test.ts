import { afterEach, expect, test } from "bun:test"
import { MOCK_STREAM_FIXTURE_HEADER, mockStreamKind, startMockStreamServer } from "./mock-streams"

const servers: ReturnType<typeof startMockStreamServer>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop() })

function server() {
  const value = startMockStreamServer({ port: 0 })
  servers.push(value)
  return value
}

function fixture(target: ReturnType<typeof server>, id: string) {
  const lease = target.registerFixture({ origin: "http://127.0.0.1:47000", directories: [`/fixture/${id}`], sessionIds: [id] })
  return { ...lease, headers: { [MOCK_STREAM_FIXTURE_HEADER]: lease.id, origin: "http://127.0.0.1:47000" } }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Fixture stream did not release its connection")
}

function frame(bytes: Uint8Array | undefined) {
  const text = new TextDecoder().decode(bytes)
  const line = text.split("\n").find((line) => line.startsWith("data: "))
  return { text, payload: line ? JSON.parse(line.slice(6)) : undefined }
}

test("stream routing recognises the control-plane stream and the workspace stream only", () => {
  expect(mockStreamKind("/api/cp/events")).toBe("cp")
  expect(mockStreamKind("/api/wr/events")).toBe("wr")
  expect(mockStreamKind("/api/claxedo/events")).toBeUndefined()
  expect(mockStreamKind("/global/event")).toBeUndefined()
  expect(mockStreamKind("/event")).toBeUndefined()
  expect(mockStreamKind("/api/wr/events/unknown")).toBeUndefined()
})

test("real streams expose headers immediately and preserve each stream's heartbeat and cursor contract", async () => {
  const target = server()
  const lease = fixture(target, "session-a")
  const abort = new AbortController()
  const expiry = setTimeout(() => abort.abort(), 13_000)
  try {
    const paths = ["/api/cp/events", "/api/wr/events"]
    const responses = await Promise.race([
      Promise.all(paths.map((path) => fetch(`${target.origin}${path}`, { headers: lease.headers, signal: abort.signal }))),
      Bun.sleep(1_000).then(() => { throw new Error("SSE headers waited for the first heartbeat") }),
    ])
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(response.headers.get("cache-control")).toBe("no-cache")
      expect(response.headers.get("access-control-allow-origin")).toBe(lease.headers.origin)
    }
    const [cp, wr] = responses.map((response) => response.body!.getReader())
    for (const reader of [cp, wr]) {
      const bootstrap = frame((await reader.read()).value)
      expect(bootstrap.text).toContain("id: 0\n")
      expect(bootstrap.payload).toEqual({ type: "heartbeat" })
    }

    let wrYielded = false
    const wrRead = wr.read().then((result) => { wrYielded = true; return result })
    // The control plane beats at 5 s, the workspace runtime at 10 s.
    const cpHeartbeat = await cp.read()
    expect(wrYielded).toBe(false)
    const wrHeartbeat = await wrRead
    for (const result of [cpHeartbeat, wrHeartbeat]) {
      expect(result.done).toBe(false)
      expect(frame(result.value).text).not.toContain("id:")
      expect(frame(result.value).payload).toEqual({ type: "heartbeat" })
    }
    expect(target.activeConnections).toBe(2)
    abort.abort()
    await until(() => target.activeConnections === 0)
  } finally {
    clearTimeout(expiry)
    abort.abort()
  }
}, 15_000)

test("page leases isolate scopes, reject unknown clients, and release streams independently", async () => {
  const target = server()
  const first = fixture(target, "first")
  const second = fixture(target, "second")
  const url = `${target.origin}/api/wr/events`
  expect((await fetch(url)).status).toBe(403)
  expect((await fetch(url, { headers: { ...first.headers, origin: "http://other.test" } })).status).toBe(403)
  expect((await fetch(`${url}?sessionID=second`, { headers: first.headers })).status).toBe(404)
  expect((await fetch(`${url}?directory=/fixture/second`, { headers: first.headers })).status).toBe(404)
  expect((await fetch(url, { method: "POST", headers: first.headers })).status).toBe(405)
  expect((await fetch(`${target.origin}/unregistered`, { headers: first.headers })).status).toBe(404)
  const abort = new AbortController()
  const opened = await Promise.all([first, second].map((lease) => fetch(url, { headers: lease.headers, signal: abort.signal })))
  const readers = opened.map((response) => response.body!.getReader())
  await Promise.all(readers.map((reader) => reader.read()))
  expect(target.activeConnections).toBe(2)
  first.close()
  expect((await readers[0].read()).done).toBe(true)
  expect(target.activeConnections).toBe(1)
  expect((await fetch(url, { headers: first.headers })).status).toBe(403)
  abort.abort()
  await until(() => target.activeConnections === 0)
  await target.stop()
  await target.stop()
  expect(() => fixture(target, "late")).toThrow("stopped")
})

test("server stop closes active streams and releases its listening port", async () => {
  const target = server()
  const lease = fixture(target, "session-a")
  const response = await fetch(`${target.origin}/api/wr/events`, { headers: lease.headers })
  const reader = response.body!.getReader()
  await reader.read()
  expect(target.activeConnections).toBe(1)
  await target.stop()
  expect(target.activeConnections).toBe(0)
  await reader.read().catch(() => undefined)
  const replacement = startMockStreamServer({ port: target.port })
  servers.push(replacement)
  expect(replacement.port).toBe(target.port)
})
