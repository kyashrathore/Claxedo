import { expect, test, vi } from "vitest"
import { createRelayRuntimeClient, type RelayRuntimeCapability } from "./relay-runtime-client"

const capability: RelayRuntimeCapability = {
  workspaceId: "workspace/one", hostId: "host", routingId: "routing", homeRegion: "eu-west",
  orgId: "org", principalKind: "user", actorKind: "human", actorId: "actor", userId: "user",
  auth: { mode: "signed", token: "user-token", user: { subject: "subject", tokenIdentifier: "issuer|subject", issuer: "issuer" } },
  role: "viewer", ttlMs: 60_000,
}

function client(response = Response.json({ ok: true })) {
  const mintRuntimeAccessToken = vi.fn(async () => ({ token: "runtime-token", jti: "jti", expiresAt: 100 }))
  const getRelayEndpoint = vi.fn(async () => "https://relay.test///")
  const request = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(async () => response)
  const error = vi.fn((status: number, code: string, message: string) => Object.assign(new Error(message), { status, code }))
  return { mintRuntimeAccessToken, getRelayEndpoint, request, error,
    runtime: createRelayRuntimeClient({ provider: { mintRuntimeAccessToken, getRelayEndpoint }, request, error }) }
}

test.each(["viewer", "editor", "owner"] as const)("the relay client mints exactly the supplied %s capability", async (role) => {
  const f = client()
  const { homeRegion, ...claims } = { ...capability, role }
  await expect(f.runtime.json({ ...capability, role }, "/session/s/message?snapshot=1")).resolves.toEqual({ ok: true })
  expect(f.mintRuntimeAccessToken.mock.calls).toEqual([[claims]])
  expect(f.getRelayEndpoint.mock.calls).toEqual([[claims.workspaceId, homeRegion]])
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(f.request.mock.calls[0]?.[0]).toBe("https://relay.test/workspaces/workspace%2Fone/session/s/message?snapshot=1")
})

test("fetch preserves request options and replaces authority headers with the minted capability", async () => {
  const f = client(new Response("stream"))
  const controller = new AbortController()
  const response = await f.runtime.fetch(capability, "/apply", {
    method: "POST", body: "payload", signal: controller.signal,
    headers: new Headers({ authorization: "foreign", "x-claxedo-directory": "foreign", "content-type": "application/json", accept: "text/event-stream" }),
  })
  expect(await response.text()).toBe("stream")
  const init = f.request.mock.calls[0]?.[1]
  expect(init).toMatchObject({ method: "POST", body: "payload", signal: controller.signal })
  expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
    authorization: "Bearer runtime-token", "x-claxedo-directory": "workspace:workspace/one",
    "content-type": "application/json", accept: "text/event-stream",
  })
})

test("json requests JSON and retains the caller's error factory and runtime status", async () => {
  const f = client(new Response("runtime denied", { status: 403 }))
  await expect(f.runtime.json(capability, "/session/s")).rejects.toMatchObject({
    status: 403, code: "workspace_runtime_pull_failed", message: "runtime denied",
  })
  expect(new Headers(f.request.mock.calls[0]?.[1]?.headers).get("accept")).toBe("application/json")
  expect(f.error).toHaveBeenCalledWith(403, "workspace_runtime_pull_failed", "runtime denied")
})

test("a refused token never reaches the relay endpoint or request", async () => {
  const f = client()
  f.mintRuntimeAccessToken.mockRejectedValueOnce(new Error("authority denied"))
  await expect(f.runtime.fetch(capability, "/session/s")).rejects.toThrow("authority denied")
  expect(f.getRelayEndpoint).not.toHaveBeenCalled()
  expect(f.request).not.toHaveBeenCalled()
})
