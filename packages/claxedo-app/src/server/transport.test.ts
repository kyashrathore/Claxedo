import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { createTransport } from "./transport"
import { placementId } from "./ids"
import type { Workspaces } from "./workspaces"
import { createWorkspaceWakes } from "./workspace-wakes"

const fetcher = spyOn(globalThis, "fetch")
const link = { relayUrl: "https://relay.test", runtimeAccessToken: "session-rat", tokenExpiresAt: Date.now() + 3_600_000 }
const cloud = { directory: "workspace:ws_cloud", workspaceId: "ws_cloud", remote: true }

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
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://relay.test/workspaces/ws_cloud/api/wr/health"])
  expect(wakes.runtime(id)).toEqual({ kind: "live" })
})

test("signed desktop cloud and remote machine runtime reads use the account's workspace connection and only its relay token", async () => {
  const machine = { directory: "workspace:ws_machine", workspaceId: "ws_machine", remote: true }
  for (const route of [machine, cloud]) {
    fetcher.mockReset().mockResolvedValue(Response.json({ id: "ses_a" }))
    const { transport, calls } = signed(link)
    await transport.runtime(route, "/session/ses_a?view=open")
    await transport.runtime(route, "/api/wr/events?sessionID=ses_b")
    expect(calls).toEqual([{ operation: "workspace.connection.read", input: { id: route.workspaceId } }])
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://relay.test/workspaces/${route.workspaceId}/session/ses_a?view=open`)
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
  await transport.runtime({ directory: "/repo", workspaceId: "ws_local", remote: false }, "/session/ses_local")
  expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4444/session/ses_local?directory=%2Frepo")
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull()
  expect(calls).toEqual([])
})

const href = (url: string | URL | Request) => typeof url === "string" ? url : url instanceof URL ? url.href : url.url
const hostLink = { backing: "durable-object", sessionId: "ses_pi", relayUrl: "https://relay.test", runtimeAccessToken: "host-rat", tokenExpiresAt: Date.now() + 3_600_000 }

test("a session reserved in its own Durable Object is connected through the account, and its routes use that session's link alone", async () => {
  const { transport, calls } = signed(hostLink, link)
  fetcher.mockResolvedValue(Response.json({}))
  const learned: unknown[] = []
  transport.onSessionHost((...host) => learned.push(host))
  await transport.connectSession("ws_cloud", "ses_pi")
  await transport.runtime({ ...cloud, sessionHost: { sessionId: "ses_pi" } }, "/session/ses_pi?directory=workspace%3Aws_cloud")
  await transport.runtime(cloud, "/api/wr/health")
  expect(learned).toEqual([["ws_cloud", "ses_pi", "ses_pi"]])
  expect(calls).toEqual([
    { operation: "session.connection.mint", input: { id: "ws_cloud", sessionId: "ses_pi" } },
    { operation: "workspace.connection.read", input: { id: "ws_cloud" } },
  ])
  expect(fetcher.mock.calls.map(([url, init]) => [href(url), new Headers(init?.headers).get("authorization")])).toEqual([
    ["https://relay.test/workspaces/ws_cloud/session/ses_pi", "Bearer host-rat"],
    ["https://relay.test/workspaces/ws_cloud/api/wr/health", "Bearer session-rat"],
  ])
})

test("a session's own connection read that answers its Durable Object teaches its host", async () => {
  const { transport } = signed(hostLink)
  fetcher.mockResolvedValue(Response.json({}))
  const learned: unknown[] = []
  transport.onSessionHost((...host) => learned.push(host))
  await transport.runtime({ ...cloud, sharedSession: { sessionId: "ses_pi", level: "send" } }, "/session/ses_pi")
  expect(learned).toEqual([["ws_cloud", "ses_pi", "ses_pi"]])
})

test("a reservation's host that answers no connection fails the create loudly", async () => {
  const { transport } = signed(new Error("operation \"session.connection.mint\" failed: 409 (session_host_unavailable)"))
  await expect(transport.connectSession("ws_cloud", "ses_codex")).rejects.toThrow(/session_host_unavailable/)
})

test("a signed desktop finds a cold session's host in the session's own control-plane row, read once through the account", async () => {
  const { transport, calls } = signed({ items: [{ sessionId: "ses_pi", workspaceId: "ws_cloud", sessionHostRoot: "ses_pi" }] }, { items: [{ sessionId: "ses_codex", workspaceId: "ws_cloud" }] })
  expect(await transport.findSessionHost("ws_cloud", "ses_pi")).toBe("ses_pi")
  expect(await transport.findSessionHost("ws_cloud", "ses_codex")).toBeUndefined()
  expect(calls).toEqual([
    { operation: "session.activity.page", input: { sessionId: "ses_pi", limit: 1, settled: "all", sort: "human_turn_desc" } },
    { operation: "session.activity.page", input: { sessionId: "ses_codex", limit: 1, settled: "all", sort: "human_turn_desc" } },
  ])
  expect(fetcher).not.toHaveBeenCalled()
})

test("a browser finds a cold session's host in its control-plane row and mints nothing for it", async () => {
  const transport = createTransport({ serverUrl: "https://cp.test", cookies: true })
  fetcher.mockImplementation(Object.assign(async () => Response.json({ items: [{ sessionId: "ses_pi", workspaceId: "ws_cloud", sessionHostRoot: "ses_pi" }] }), { preconnect: fetch.preconnect }))
  expect(await transport.findSessionHost("ws_cloud", "ses_pi")).toBe("ses_pi")
  expect(await transport.findSessionHost("ws_other", "ses_pi"), "a row of another workspace names no host here").toBeUndefined()
  expect(fetcher.mock.calls.map(([url]) => href(url))).toEqual(Array(2).fill("https://cp.test/api/control/session-list?scope=all&sessionId=ses_pi&limit=1&settled=all&sort=human_turn_desc"))
})
