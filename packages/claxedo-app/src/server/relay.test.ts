/// <reference types="bun" />
import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { createRelay } from "./relay"
import { createWorkspaceConnections } from "./transport"
import { WORKSPACE_STOPPED } from "./wire/connection"

const runtimeFetch = spyOn(globalThis, "fetch")

afterEach(() => {
  runtimeFetch.mockReset()
})

afterAll(() => {
  runtimeFetch.mockRestore()
})

function control(body: unknown) {
  const calls: { path: string; method: string | undefined }[] = []
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method })
    return Response.json(body)
  }
  return { read: createWorkspaceConnections(request).read, calls }
}

const link = { workspaceId: "ws_1", relayUrl: "https://relay.test", runtimeAccessToken: "rat", tokenExpiresAt: Date.now() + 3_600_000 }

test("relay: a read takes its connection from the read-only GET and never from the connect that starts compute", async () => {
  const server = control({ relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValue(Response.json([]))

  await createRelay(server.read).fetch("ws_1", "/api/wr/health")

  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection", method: undefined }])
  expect(runtimeFetch.mock.calls[0]?.[0]).toBe("https://relay.test/workspaces/ws_1/api/wr/health")
})

test("relay: a stopped workspace answers the read with workspace_stopped and nothing reaches the relay", async () => {
  const server = control({ status: "stopped", workspaceId: "ws_1" })

  await expect(createRelay(server.read).fetch("ws_1", "/api/wr/health")).rejects.toMatchObject({ class: "conflict", code: WORKSPACE_STOPPED })
  expect(runtimeFetch).not.toHaveBeenCalled()
})

test("relay: a started workspace's link is adopted, so the next read asks the control plane nothing", async () => {
  const server = control({ status: "stopped", workspaceId: "ws_1" })
  runtimeFetch.mockResolvedValue(Response.json([]))
  const relay = createRelay(server.read)

  relay.adopt(link)
  await relay.fetch("ws_1", "/api/wr/health")

  expect(server.calls).toEqual([])
  expect(runtimeFetch).toHaveBeenCalledTimes(1)
})

test("relay: a fenced token renews once through a read-only connection and adopts the result", async () => {
  const server = control({ relayUrl: link.relayUrl, runtimeAccessToken: "fresh", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValueOnce(Response.json({ code: "runtime_access_token_invalid" }, { status: 401 }))
  runtimeFetch.mockResolvedValueOnce(Response.json({ code: "runtime_access_token_invalid" }, { status: 401 }))
  const relay = createRelay(server.read)
  relay.adopt(link)
  expect((await relay.fetch("ws_1", "/api/wr/health")).status).toBe(401)
  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection", method: undefined }])
  expect(runtimeFetch).toHaveBeenCalledTimes(2)
  expect(new Headers(runtimeFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer fresh")
})

test("relay: upstream failures do not renew or resend", async () => {
  const server = control({})
  runtimeFetch.mockResolvedValue(Response.json({}, { status: 502 }))
  const relay = createRelay(server.read)
  relay.adopt(link)
  expect((await relay.fetch("ws_1", "/api/wr/health")).status).toBe(502)
  expect(server.calls).toEqual([])
  expect(runtimeFetch).toHaveBeenCalledTimes(1)
})

test("relay: expiry refresh remains a read and cannot wake a stopped workspace", async () => {
  const server = control({ status: "stopped", workspaceId: "ws_1" })
  const relay = createRelay(server.read)
  relay.adopt({ ...link, tokenExpiresAt: Date.now() })
  await expect(relay.fetch("ws_1", "/api/wr/health")).rejects.toMatchObject({ code: WORKSPACE_STOPPED })
  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection", method: undefined }])
  expect(runtimeFetch).not.toHaveBeenCalled()
})

test("relay: session links are isolated from siblings and owned links, including expiry and 401 renewal", async () => {
  const reads: Array<[string, string | undefined]> = []
  const relay = createRelay(async (workspaceId, sessionId) => {
    reads.push([workspaceId, sessionId])
    return { kind: "ready", link: { ...link, workspaceId, sessionId, runtimeAccessToken: `${sessionId ?? "workspace"}:${reads.length}` } }
  })
  runtimeFetch.mockResolvedValue(Response.json({}))
  await relay.fetch("ws_1", "/session/ses_a", undefined, "ses_a")
  await relay.fetch("ws_1", "/session/ses_b", undefined, "ses_b")
  await relay.fetch("ws_1", "/api/wr/health")
  relay.adopt({ ...link, sessionId: "ses_a", tokenExpiresAt: Date.now() })
  await relay.fetch("ws_1", "/session/ses_a", undefined, "ses_a")
  runtimeFetch.mockResolvedValueOnce(Response.json({}, { status: 401 })).mockResolvedValueOnce(Response.json({}))
  await relay.fetch("ws_1", "/session/ses_b", undefined, "ses_b")
  expect(reads).toEqual([["ws_1", "ses_a"], ["ws_1", "ses_b"], ["ws_1", undefined], ["ws_1", "ses_a"], ["ws_1", "ses_b"]])
  expect(new Headers(runtimeFetch.mock.calls.at(-1)?.[1]?.headers).get("authorization")).toBe("Bearer ses_b:5")
})

function tab() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), items }
}

test("relay: a signed-in person's link outlives a reload of the page, so reloads within its life mint nothing more", async () => {
  const server = control({ sessionId: "ses_pi", relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockImplementation(Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }))
  const storage = tab()
  for (let reload = 0; reload < 5; reload++) {
    const relay = createRelay(server.read, { scope: "usr_ada", storage })
    await relay.fetch("ws_1", "/session/ses_pi", undefined, "ses_pi")
    await relay.fetch("ws_1", "/api/wr/events?sessionID=ses_pi", undefined, "ses_pi")
  }
  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection?sessionId=ses_pi", method: undefined }])
  expect(runtimeFetch).toHaveBeenCalledTimes(10)
  const other = createRelay(server.read, { scope: "usr_bob", storage })
  await other.fetch("ws_1", "/session/ses_pi", undefined, "ses_pi")
  expect(server.calls, "another person's reload never reuses Ada's link").toHaveLength(2)
})

test("relay: a kept link near its expiry is minted again on the next reload and kept in its place", async () => {
  const server = control({ relayUrl: link.relayUrl, runtimeAccessToken: "renewed", tokenExpiresAt: Date.now() + 3_600_000 })
  runtimeFetch.mockImplementation(Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }))
  const storage = tab()
  storage.setItem(`claxedo:relay-link:usr_ada:${JSON.stringify(["ws_1", null])}`, JSON.stringify({ ...link, runtimeAccessToken: "expiring", tokenExpiresAt: Date.now() + 30_000 }))
  await createRelay(server.read, { scope: "usr_ada", storage }).fetch("ws_1", "/api/wr/health")
  expect(server.calls).toHaveLength(1)
  expect(new Headers(runtimeFetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer renewed")
  await createRelay(server.read, { scope: "usr_ada", storage }).fetch("ws_1", "/api/wr/health")
  expect(server.calls, "the renewed link serves the next reload").toHaveLength(1)
})
