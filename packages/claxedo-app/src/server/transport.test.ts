import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { createTransport } from "./transport"
import { placementId } from "./ids"
import type { Workspaces } from "./workspaces"
import { createWorkspaceWakes } from "./workspace-wakes"

const fetcher = spyOn(globalThis, "fetch")
const link = { relayUrl: "https://relay.test", runtimeAccessToken: "session-rat", tokenExpiresAt: Date.now() + 3_600_000 }
const cloud = { kind: "cloud" as const, directory: "workspace:ws_cloud", workspaceId: "ws_cloud", remote: true }

afterEach(() => fetcher.mockReset())
afterAll(() => fetcher.mockRestore())

function signed(...answers: unknown[]) {
  const calls: { operation: string; input: unknown }[] = []
  const transport = createTransport({ serverUrl: "http://127.0.0.1:4444", account: async (operation, input) => {
    calls.push({ operation, input })
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return answer
  } })
  return { transport, calls }
}

test("the public workspace wake owner sends a signed desktop cloud wake to the account until it is ready, then adopts its link", async () => {
  const { transport, calls } = signed({ status: "provisioning", retryAfterMs: 500 }, link)
  fetcher.mockResolvedValue(Response.json(link))
  let running = false
  const workspaces = {
    locate: async () => cloud,
    refresh: async () => { running = true },
    byId: () => ({ kind: "cloud", reachable: running }),
  } as unknown as Workspaces
  const wakes = createWorkspaceWakes(transport, workspaces)
  const id = placementId("ws_cloud")
  await wakes.start(id)
  await transport.runtime(cloud, "/api/wr/health")
  expect(calls).toEqual(Array(2).fill({ operation: "workspace.connection.mint", input: { id: "ws_cloud" } }))
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://relay.test/workspaces/ws_cloud/api/wr/health"])
  expect(wakes.runtime(id)).toEqual({ kind: "live" })
})

test("signed desktop cloud and remote machine runtime reads use the account's workspace connection and only its relay token", async () => {
  const machine = { kind: "worktree" as const, directory: "workspace:ws_machine", workspaceId: "ws_machine", remote: true }
  for (const route of [machine, cloud]) {
    fetcher.mockReset().mockResolvedValue(Response.json({ id: "ses_a" }))
    const { transport, calls } = signed(link)
    await transport.runtime(route, "/session/ses_a?view=open")
    await transport.runtime(route, "/api/wr/events?sessionID=ses_b")
    expect(calls).toEqual([{ operation: "workspace.connection.read", input: { id: route.workspaceId } }])
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://relay.test/workspaces/${route.workspaceId}/session/ses_a?view=open`)
    const init = fetcher.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-rat")
    expect(init?.credentials).toBe("omit")
  }
})

test("signed desktop stopped connection fails without daemon reads, relay reads or wake", async () => {
  const { transport, calls } = signed({ status: "stopped" })
  await expect(transport.runtime(cloud, "/api/wr/health")).rejects.toMatchObject({ code: "workspace_stopped" })
  expect(calls).toEqual([{ operation: "workspace.connection.read", input: { id: "ws_cloud" } }])
  expect(fetcher).not.toHaveBeenCalled()
})

test("signed desktop local placements keep using the daemon with no account call", async () => {
  const { transport, calls } = signed()
  fetcher.mockResolvedValue(Response.json({}))
  await transport.runtime({ kind: "folder", directory: "/repo", workspaceId: "ws_local", remote: false }, "/session/ses_local")
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4444/session/ses_local?directory=%2Frepo")
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull()
  expect(calls).toEqual([])
})

test("web runtime routing uses the same read-only workspace connection", async () => {
  const transport = createTransport({ serverUrl: "https://account.test", cookies: true })
  fetcher.mockResolvedValueOnce(Response.json(link)).mockResolvedValueOnce(Response.json({}))
  await transport.runtime(cloud, "/session/ses_a")
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://account.test/api/workspace/ws_cloud/connection")
  expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined()
  expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer session-rat")
})

test("renewing a rejected runtime token cannot wake compute", async () => {
  const { transport, calls } = signed(link, { ...link, runtimeAccessToken: "fresh-rat" })
  fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 })).mockResolvedValueOnce(Response.json({}))
  await transport.runtime(cloud, "/session/ses_a")
  expect(calls).toEqual(Array(2).fill({ operation: "workspace.connection.read", input: { id: "ws_cloud" } }))
})
