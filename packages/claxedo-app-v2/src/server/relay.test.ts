/// <reference types="bun" />
import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { createRelay } from "./relay"
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
  return { request, calls }
}

const link = { workspaceId: "ws_1", relayUrl: "https://relay.test", runtimeAccessToken: "rat", tokenExpiresAt: Date.now() + 3_600_000 }

test("relay: a read takes its connection from the read-only GET and never from the connect that starts compute", async () => {
  const server = control({ relayUrl: link.relayUrl, runtimeAccessToken: "rat", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValue(Response.json([]))

  await createRelay(server.request).fetch("ws_1", "/session/status")

  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection", method: undefined }])
  expect(String(runtimeFetch.mock.calls[0]?.[0])).toBe("https://relay.test/workspaces/ws_1/session/status")
})

test("relay: a stopped workspace answers the read with workspace_stopped and nothing reaches the relay", async () => {
  const server = control({ status: "stopped", workspaceId: "ws_1" })

  await expect(createRelay(server.request).fetch("ws_1", "/session/status")).rejects.toMatchObject({ class: "conflict", code: WORKSPACE_STOPPED })
  expect(runtimeFetch).not.toHaveBeenCalled()
})

test("relay: a started workspace's link is adopted, so the next read asks the control plane nothing", async () => {
  const server = control({ status: "stopped", workspaceId: "ws_1" })
  runtimeFetch.mockResolvedValue(Response.json([]))
  const relay = createRelay(server.request)

  relay.adopt(link)
  await relay.fetch("ws_1", "/session/status")

  expect(server.calls).toEqual([])
  expect(runtimeFetch).toHaveBeenCalledTimes(1)
})

test("relay: a fenced token renews once through connection POST and adopts the result", async () => {
  const server = control({ relayUrl: link.relayUrl, runtimeAccessToken: "fresh", tokenExpiresAt: link.tokenExpiresAt })
  runtimeFetch.mockResolvedValueOnce(Response.json({ code: "runtime_access_token_invalid" }, { status: 401 }))
  runtimeFetch.mockResolvedValueOnce(Response.json({ code: "runtime_access_token_invalid" }, { status: 401 }))
  const relay = createRelay(server.request)
  relay.adopt(link)
  expect((await relay.fetch("ws_1", "/session/status")).status).toBe(401)
  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection", method: "POST" }])
  expect(runtimeFetch).toHaveBeenCalledTimes(2)
  expect(new Headers(runtimeFetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer fresh")
})

test("relay: upstream failures do not renew or resend", async () => {
  const server = control({})
  runtimeFetch.mockResolvedValue(Response.json({}, { status: 502 }))
  const relay = createRelay(server.request)
  relay.adopt(link)
  expect((await relay.fetch("ws_1", "/session/status")).status).toBe(502)
  expect(server.calls).toEqual([])
  expect(runtimeFetch).toHaveBeenCalledTimes(1)
})

test("relay: expiry refresh remains a read and cannot wake a stopped workspace", async () => {
  const server = control({ status: "stopped", workspaceId: "ws_1" })
  const relay = createRelay(server.request)
  relay.adopt({ ...link, tokenExpiresAt: Date.now() })
  await expect(relay.fetch("ws_1", "/session/status")).rejects.toMatchObject({ code: WORKSPACE_STOPPED })
  expect(server.calls).toEqual([{ path: "/api/workspace/ws_1/connection", method: undefined }])
  expect(runtimeFetch).not.toHaveBeenCalled()
})
