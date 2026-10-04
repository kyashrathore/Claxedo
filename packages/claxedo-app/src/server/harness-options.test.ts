import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { harnessQueries, readHarnessOptions } from "./harness-options"
import { fakeServer } from "./test-session-server"
import { placementId } from "./ids"
import type { RuntimeRoute, Transport } from "./transport"
import type { Workspaces } from "./workspaces"

const answer = { options: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "m1", options: [{ value: "m1", name: "Model one" }, { value: "m2", name: "Model two" }] }] }

function reads(route: RuntimeRoute) {
  const seen: string[] = []
  const transport = {
    request: async (path: string) => (seen.push(`server ${path}`), Response.json(answer)),
    runtimeJson: async (_route: RuntimeRoute, path: string) => (seen.push(`runtime ${path}`), answer),
  } as unknown as Transport
  const workspaces = { route: async () => route } as unknown as Workspaces
  return { seen, read: (sessionId?: string) => readHarnessOptions(transport, workspaces, { placementId: placementId(route.workspaceId), harness: "scripted-acp", ...(sessionId ? { sessionId } : {}) }) }
}

test("a remote placement's model options come from its runtime, which a signed desktop's daemon cannot serve", async () => {
  const { seen, read } = reads({ directory: "workspace:ws_cloud", workspaceId: "ws_cloud", remote: true })
  expect((await read("ses_1")).offersOptions).toBe(true)
  await read()
  expect(seen).toEqual(["runtime /session/ses_1/config-options?connectionId=scripted-acp", "runtime /api/wr/harness-config-options?connectionId=scripted-acp"])
})

test("a local placement's model options come from the daemon, which falls back to its catalog", async () => {
  const { seen, read } = reads({ directory: "/repo", workspaceId: "ws_local", remote: false })
  await read()
  expect(seen).toEqual(["server /api/claxedo/agent-config/harness/options?workspaceId=ws_local&connectionId=scripted-acp"])
})

test("a draft's model options on an asleep cloud workspace refuse without starting it, because only a send wakes", async () => {
  const server = fakeServer({ reachable: () => false })
  const starts: string[] = []
  const transport = { ...server.context.transport, startRuntime: async (workspaceId: string) => void starts.push(workspaceId) }
  const options = harnessQueries(transport, server.context.workspaces).options(placementId("ws_cloud"), "codex")
  await expect(new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(options)).rejects.toMatchObject({ code: "workspace_stopped" })
  expect(starts).toEqual([])
  expect(server.runtimeCalls).toEqual([])
  expect(server.requests.filter((path) => path.includes("/connection"))).toEqual([])
})

test("a session's model options come from the host that serves it, its own session host included", async () => {
  const server = fakeServer({ reachable: () => true, sessionHosts: { ses_1: "ses_1" }, runtime: () => Response.json(answer) })
  await readHarnessOptions(server.context.transport, server.context.workspaces, { placementId: placementId("ws_cloud"), harness: "pi", sessionId: "ses_1" })
  expect(server.hostedCalls).toEqual(["/session/ses_1/config-options?nativeHarness=pi"])
})
