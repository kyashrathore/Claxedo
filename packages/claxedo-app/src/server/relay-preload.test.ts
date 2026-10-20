/// <reference types="bun" />
import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { createRelay } from "./relay"
import { connectionReads, link, tab } from "./test-relay-links"

const runtimeFetch = spyOn(globalThis, "fetch")

afterEach(() => {
  runtimeFetch.mockReset()
})

afterAll(() => {
  runtimeFetch.mockRestore()
})

test("relay: a preload on a kept link sends the read at once, and the reader's own fetch takes that response instead of sending again", async () => {
  const server = connectionReads({ relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockImplementation(Object.assign(async () => Response.json({ outline: [] }), { preconnect: fetch.preconnect }))
  const storage = tab()
  await createRelay(server.read, { scope: "usr_ada", storage }).fetch("ws_1", "/api/wr/health")
  const reloaded = createRelay(server.read, { scope: "usr_ada", storage })

  expect(reloaded.preload("ws_1", "/session/ses_1/outline?rows=41", "ses_1")).toBe(true)
  expect(runtimeFetch).toHaveBeenCalledTimes(2)
  expect(runtimeFetch.mock.calls[1]?.[0]).toBe("https://relay.test/workspaces/ws_1/session/ses_1/outline?rows=41")
  expect(await (await reloaded.fetch("ws_1", "/session/ses_1/outline?rows=41")).json()).toEqual({ outline: [] })
  expect(runtimeFetch, "the reader took the preloaded response").toHaveBeenCalledTimes(2)
  await reloaded.fetch("ws_1", "/session/ses_1/outline?rows=41")
  expect(runtimeFetch, "a response is handed over once; the next identical read is sent").toHaveBeenCalledTimes(3)
  expect(server.calls, "a preload mints nothing").toHaveLength(1)
})

test("relay: a preload without a kept link sends nothing and mints nothing, and a mutation never takes a preloaded answer", async () => {
  const server = connectionReads({ relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValue(Response.json({}))
  const relay = createRelay(server.read, { scope: "usr_ada", storage: tab() })
  expect(relay.preload("ws_1", "/session/ses_1/outline", "ses_1")).toBe(false)
  expect(runtimeFetch).not.toHaveBeenCalled()
  expect(server.calls).toEqual([])

  relay.adopt(link)
  expect(relay.preload("ws_1", "/session/ses_1/queue", "ses_1")).toBe(true)
  await relay.fetch("ws_1", "/session/ses_1/queue", { method: "POST", body: "{}" })
  expect(runtimeFetch).toHaveBeenCalledTimes(2)
  expect(runtimeFetch.mock.calls[1]?.[1]?.method).toBe("POST")
})

test("relay: a preload is scoped to the session's own link when the tab keeps one, else to the workspace's, and a read under another scope does not take it", async () => {
  const relay = createRelay(async (workspaceId, sessionId) => ({ kind: "ready", link: { ...link, workspaceId, ...(sessionId ? { sessionId } : {}), runtimeAccessToken: sessionId ?? "workspace" } }))
  runtimeFetch.mockResolvedValue(Response.json({}))
  relay.adopt({ ...link, sessionId: "ses_a", runtimeAccessToken: "ses_a" })
  relay.adopt({ ...link, runtimeAccessToken: "workspace" })

  expect(relay.preload("ws_1", "/session/ses_a", "ses_a")).toBe(true)
  expect(relay.preload("ws_1", "/session/ses_b", "ses_b")).toBe(true)
  expect(runtimeFetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("authorization"))).toEqual(["Bearer ses_a", "Bearer workspace"])
  await relay.fetch("ws_1", "/session/ses_a")
  expect(runtimeFetch, "the workspace-scoped read of ses_a sends its own, since the preload went under the session's link").toHaveBeenCalledTimes(3)
  await relay.fetch("ws_1", "/session/ses_a", undefined, "ses_a")
  await relay.fetch("ws_1", "/session/ses_b")
  expect(runtimeFetch, "the session-scoped and the workspace-scoped readers took theirs").toHaveBeenCalledTimes(3)
})

test("relay: a preload that failed before its reader asked is dropped with a warning, so the reader sends its own; one the reader holds fails the reader", async () => {
  const warned = spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    const relay = createRelay(async () => ({ kind: "ready", link }))
    relay.adopt(link)
    runtimeFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    expect(relay.preload("ws_1", "/session/ses_1/outline")).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(warned).toHaveBeenCalledTimes(1)
    runtimeFetch.mockResolvedValueOnce(Response.json({ sent: "again" }))
    expect(await (await relay.fetch("ws_1", "/session/ses_1/outline")).json()).toEqual({ sent: "again" })

    const pending = Promise.withResolvers<Response>()
    runtimeFetch.mockReturnValueOnce(pending.promise)
    relay.preload("ws_1", "/session/ses_1?view=open")
    const reading = relay.fetch("ws_1", "/session/ses_1?view=open")
    pending.reject(new TypeError("Failed to fetch"))
    await expect(reading).rejects.toMatchObject({ class: "network" })
    expect(warned, "a failure the reader holds is the reader's to show").toHaveBeenCalledTimes(1)
  } finally {
    warned.mockRestore()
  }
})

test("relay: a preloaded answer of 401 renews the link once and resends, as the reader's own read would", async () => {
  const server = connectionReads({ relayUrl: link.relayUrl, runtimeAccessToken: "fresh", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValueOnce(Response.json({ code: "runtime_access_token_invalid" }, { status: 401 })).mockResolvedValueOnce(Response.json({ renewed: true }))
  const relay = createRelay(server.read)
  relay.adopt(link)
  relay.preload("ws_1", "/session/ses_1/outline")
  expect(await (await relay.fetch("ws_1", "/session/ses_1/outline")).json()).toEqual({ renewed: true })
  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection", method: undefined }])
  expect(new Headers(runtimeFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer fresh")
})
