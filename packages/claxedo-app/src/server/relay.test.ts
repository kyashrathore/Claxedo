/// <reference types="bun" />
import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { createRelay, type RelayLinkSiblings } from "./relay"
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

test("relay: a cloud workspace's requests and sockets tell the relay the region its machine runs in, so a first touch from anywhere places the room there", async () => {
  const server = control({ backing: "cloud-vm", homeRegion: "us-east", relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValue(Response.json([]))
  const opened: string[] = []
  const BrowserWebSocket = globalThis.WebSocket
  globalThis.WebSocket = function (url: string) {
    opened.push(url)
  } as unknown as typeof WebSocket
  try {
    const relay = createRelay(server.read)
    await relay.fetch("ws_1", "/api/wr/health")
    await relay.fetch("ws_1", "/api/wr/events?sessionID=ses_1")
    await relay.webSocket("ws_1", "/api/wr/pty/t_1/connect?cursor=0")
  } finally {
    globalThis.WebSocket = BrowserWebSocket
  }

  expect(runtimeFetch.mock.calls.map((call) => call[0])).toEqual([
    "https://relay.test/workspaces/ws_1/api/wr/health?region=us-east",
    "https://relay.test/workspaces/ws_1/api/wr/events?sessionID=ses_1&region=us-east",
  ])
  expect(opened).toEqual(["wss://relay.test/workspaces/ws_1/api/wr/pty/t_1/connect?cursor=0&region=us-east"])
})

test("relay: a workspace a person's machine serves declares no region, so its room stays near that machine", async () => {
  const server = control({ backing: "local-worktree", homeRegion: "us-east", relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValue(Response.json([]))

  await createRelay(server.read).fetch("ws_1", "/api/wr/health")

  expect(runtimeFetch.mock.calls[0]?.[0]).toBe("https://relay.test/workspaces/ws_1/api/wr/health")
})

test("relay: a kept cloud link keeps its region across a reload", async () => {
  const server = control({ backing: "cloud-vm", homeRegion: "us-east", relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockImplementation(Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }))
  const storage = tab()
  await createRelay(server.read, { scope: "usr_ada", storage }).fetch("ws_1", "/api/wr/health")
  await createRelay(server.read, { scope: "usr_ada", storage }).fetch("ws_1", "/api/wr/health")

  expect(server.calls).toHaveLength(1)
  expect(runtimeFetch.mock.calls.map((call) => call[0])).toEqual([
    "https://relay.test/workspaces/ws_1/api/wr/health?region=us-east",
    "https://relay.test/workspaces/ws_1/api/wr/health?region=us-east",
  ])
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

function siblings() {
  const members: RelayLinkSiblings[] = []
  return () => {
    const member: RelayLinkSiblings = {
      onmessage: null,
      postMessage: (message: unknown) => {
        for (const other of members) if (other !== member) other.onmessage?.call(other as BroadcastChannel, new MessageEvent("message", { data: structuredClone(message) }))
      },
    }
    members.push(member)
    return member
  }
}

test("relay: a new tab takes the links its signed-in siblings hold, so opening tabs mints nothing for a workspace or session another tab reached", async () => {
  const server = control({ relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockImplementation(Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }))
  const join = siblings()
  const first = createRelay(server.read, { scope: "usr_ada", storage: tab(), siblings: join() })
  await first.fetch("ws_1", "/api/wr/health")
  first.adopt({ ...link, workspaceId: "ws_2", runtimeAccessToken: "started" })
  const second = createRelay(server.read, { scope: "usr_ada", storage: tab(), siblings: join() })
  await second.fetch("ws_1", "/api/wr/health")
  await second.fetch("ws_2", "/api/wr/health")
  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection", method: undefined }])
  expect(new Headers(runtimeFetch.mock.calls.at(-1)?.[1]?.headers).get("authorization")).toBe("Bearer started")
})

test("relay: a link one tab mints reaches the tabs already open, and a sibling's offer never replaces a newer link", async () => {
  const minted: string[] = []
  const relayFor = (storage: ReturnType<typeof tab>, join: () => RelayLinkSiblings) =>
    createRelay(async (workspaceId, sessionId) => {
      minted.push(`${workspaceId}:${sessionId ?? "workspace"}`)
      return { kind: "ready", link: { ...link, workspaceId, sessionId, runtimeAccessToken: `mint-${minted.length}` } }
    }, { scope: "usr_ada", storage, siblings: join() })
  runtimeFetch.mockImplementation(Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }))
  const join = siblings()
  const [first, second] = [relayFor(tab(), join), relayFor(tab(), join)]
  await first.fetch("ws_1", "/session/ses_pi", undefined, "ses_pi")
  await second.fetch("ws_1", "/session/ses_pi", undefined, "ses_pi")
  expect(minted).toEqual(["ws_1:ses_pi"])
  second.adopt({ ...link, runtimeAccessToken: "newer", tokenExpiresAt: link.tokenExpiresAt + 60_000 })
  first.adopt({ ...link, runtimeAccessToken: "older", tokenExpiresAt: link.tokenExpiresAt })
  await second.fetch("ws_1", "/api/wr/health")
  expect(new Headers(runtimeFetch.mock.calls.at(-1)?.[1]?.headers).get("authorization")).toBe("Bearer newer")
  expect(minted).toEqual(["ws_1:ses_pi"])
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

test("relay: a hop's error page instead of the runtime's answer is a machine that didn't answer, and none of the page reaches the message", async () => {
  const server = control({ relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  const page = "<!DOCTYPE html><html><title>Worker threw exception | claxedo-sandbox-proxy</title><body>Error 1101</body></html>"
  runtimeFetch.mockResolvedValue(new Response(page, { status: 500, headers: { "content-type": "text/html; charset=UTF-8" } }))

  await expect(createRelay(server.read).fetch("ws_1", "/session/ses_1/outline")).rejects.toMatchObject({
    class: "runtime_unreachable",
    retryable: true,
    status: 500,
    message: expect.not.stringContaining("<"),
  })
})

test("relay: the runtime's own JSON failure passes back to its caller unchanged", async () => {
  const server = control({ relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValue(Response.json({ error: { code: "session_not_found", message: "Session not found" } }, { status: 500 }))

  expect((await createRelay(server.read).fetch("ws_1", "/session/ses_1")).status).toBe(500)
})

test("relay: a runtime the control plane couldn't reach for its settings fails the runtime call as runtime_unreachable", async () => {
  const request = async () => Response.json({ error: { code: "runtime_provision_failed", message: "error code: 1101" } }, { status: 409 })

  await expect(createRelay(createWorkspaceConnections(request).read).fetch("ws_1", "/api/wr/pty")).rejects.toMatchObject({ class: "runtime_unreachable", retryable: true })
  expect(runtimeFetch).not.toHaveBeenCalled()
})
