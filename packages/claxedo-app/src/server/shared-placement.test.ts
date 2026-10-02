import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createHostedAccount } from "./account"
import { placementId, projectId, sessionId } from "./ids"
import { createTransport } from "./transport"
import { createWorkspaces } from "./workspaces"
import { queryKeys } from "./query-keys"

const shared = { session_id: "ses_shared", workspace_id: "ws_owner", project_id: "prj_owner", title: "Design", owner_name: "Ada", level: "follow" }
const ref = { placementId: placementId("ws_owner"), projectId: projectId("prj_owner"), sessionId: sessionId("ses_shared") }
const fetcher = spyOn(globalThis, "fetch")
afterEach(() => fetcher.mockReset())
afterAll(() => fetcher.mockRestore())

test("a shared session routes without admitting its owner's workspace and disappears on the next read", async () => {
  await createRoot(async (dispose) => {
    let rows = [shared]
    const account = createHostedAccount(async (operation) => operation === "session.shared.list" ? { sessions: rows } : { workspaces: [] })
    const transport = { serverUrl: "https://account.test", json: async () => ({ deployment: { serverKind: "hosted", issuesSessions: true }, project: [] }) }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const workspaces = createWorkspaces(transport as never, queryClient, account)
    try {
      await workspaces.load()
      expect(await workspaces.route(ref)).toMatchObject({ workspaceId: "ws_owner", remote: true, sharedSession: { sessionId: "ses_shared", level: "follow" } })
      expect(workspaces.list()).toEqual([])
      expect(workspaces.address.placementFor("workspace:ws_owner", "ws_owner", "ses_shared")).toMatchObject({ placementId: ref.placementId, projectId: ref.projectId })
      expect(workspaces.address.placementFor("workspace:ws_owner", "ws_owner", "ses_private")).toBeUndefined()
      await expect(workspaces.route(ref.placementId)).rejects.toMatchObject({ class: "not_found" })
      await expect(workspaces.route({ ...ref, sessionId: sessionId("ses_other") })).rejects.toMatchObject({ class: "not_found" })
      rows = [{ ...shared, level: "send" }]
      await queryClient.invalidateQueries({ queryKey: queryKeys.sharedSessions(transport.serverUrl) })
      expect(workspaces.shared.find(ref)?.level).toBe("send")
      rows = []
      await workspaces.refresh()
      await expect(workspaces.route(ref)).rejects.toMatchObject({ class: "not_found" })
    } finally { workspaces.dispose(); dispose() }
  })
})

test("shared transport asks main for one session connection; owned transport asks for workspace scope", async () => {
  const operations: unknown[] = []
  const transport = createTransport({ serverUrl: "https://account.test", account: async (operation: string, input: unknown) => {
    operations.push([operation, input])
    return { workspaceId: "ws_owner", ...(operation === "session.connection.read" ? { sessionId: "ses_shared" } : {}), relayUrl: "https://relay.test", runtimeAccessToken: "token", tokenExpiresAt: Date.now() + 3_600_000 }
  } } as never)
  fetcher.mockResolvedValue(Response.json({}))
  const route = { directory: "workspace:ws_owner", workspaceId: "ws_owner", remote: true, sharedSession: { sessionId: "ses_shared", level: "follow" as const } }
  await transport.runtime(route, "/session/ses_shared")
  await transport.runtime(route, "/session/ses_shared/outline")
  await transport.runtime({ ...route, sharedSession: undefined }, "/api/wr/health")
  expect(operations).toEqual([
    ["session.connection.read", { id: "ws_owner", sessionId: "ses_shared" }],
    ["workspace.connection.read", { id: "ws_owner" }],
  ])
})
