import { afterAll, expect, mock, spyOn, test } from "bun:test"
import { hostedApi } from "./hosted-flow"
import type { startHostedStack } from "./hosted-stack"

const auth = { ...await import("./hosted-auth") }
afterAll(() => mock.module("./hosted-auth", () => auth))
mock.module("./hosted-auth", () => ({ ...auth, hostedFetch: (stack: { workerUrl: string }, route: string, init: RequestInit, person: { cookie: string }) => {
  const headers = new Headers(init.headers)
  headers.set("cookie", person.cookie)
  return fetch(new URL(route, stack.workerUrl), { ...init, headers })
} }))

test("hosted session creation reserves on D1 before sending the canonical id and runtime token to the relay", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.includes("session-registrations/reserve")) return Response.json({}, { status: 201 })
    return Response.json({ id: JSON.parse(String(init?.body)).id }, { status: 201 })
  }, { preconnect: globalThis.fetch.preconnect }))
  try {
    const stack = { workerUrl: "https://127.0.0.1:41001", relayUrl: "http://127.0.0.1:41002", certificate: "/dev/null" } as Awaited<ReturnType<typeof startHostedStack>>
    const workspace = { id: "ws_owned", directory: "workspace:ws_owned", runtimeAccessToken: "runtime-token" }
    const api = hostedApi(stack, workspace, { id: "owner", cookie: "owner-cookie" })
    const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" } })
    expect(requests).toHaveLength(2)
    expect(requests[0].url).toBe(`${stack.workerUrl}/api/control/session-registrations/reserve`)
    const reserved = JSON.parse(String(requests[0].init?.body))
    expect(reserved.workspaceId).toBe(workspace.id)
    expect(new Headers(requests[0].init?.headers).get("cookie")).toBe("owner-cookie")
    expect(requests[1].url).toContain(`${stack.relayUrl}/workspaces/ws_owned/session?`)
    expect(new Headers(requests[1].init?.headers).get("authorization")).toBe("Bearer runtime-token")
    expect(new Headers(requests[1].init?.headers).get("cookie")).toBeNull()
    expect(new Headers(requests[1].init?.headers).get("x-claxedo-session-registration-operation")).toBe(reserved.operationId)
    expect(session.id).toBe(reserved.sessionId)
  } finally { fetch.mockRestore() }
})
