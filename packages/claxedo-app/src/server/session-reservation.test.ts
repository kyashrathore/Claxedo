import { afterAll, expect, spyOn, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createHostedAccount } from "./account"
import { placementId } from "./ids"
import { createSessionProjection } from "./session-projection"
import { RESERVATION_HEADER } from "./session-reservation"
import { createSessionsApi } from "./sessions"
import { createStatusOwner } from "./status"
import { createTransport } from "./transport"
import { createWorkspaceWakes } from "./workspace-wakes"
import { createWorkspaces } from "./workspaces"
import { resolveHostedOperation } from "@claxedo/account-contract"

const fetcher = spyOn(globalThis, "fetch")
afterAll(() => fetcher.mockRestore())

test("signed desktop creates a cloud session with the account's canonical reservation, never a daemon reservation", async () => {
  const operations: { operation: string; input: Readonly<Record<string, unknown>> | undefined }[] = []
  const reservations: unknown[] = []
  const run = async (operation: string, input?: Readonly<Record<string, unknown>>) => {
    operations.push({ operation, input })
    if (operation === "workspace.list.provisioner") return { workspaces: [{ workspace_id: "ws_cloud", project_id: "prj_cloud", backing: "cloud-vm", reachable: true }] }
    if (operation === "workspace.list.machine") return { workspaces: [] }
    if (operation === "session.reserve") {
      const request = resolveHostedOperation(operation, input)
      reservations.push(request)
      return { ...request.body, state: "reserved" }
    }
    if (operation === "workspace.connection.read") return { relayUrl: "https://relay.test", runtimeAccessToken: "workspace-rat", tokenExpiresAt: Date.now() + 3_600_000 }
    if (operation === "session.projection.register") return {}
    throw new Error(`Unexpected operation ${operation}`)
  }
  fetcher.mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url).endsWith("/api/claxedo/bootstrap")) return Response.json({ deployment: { serverKind: "daemon", issuesSessions: false }, project: [] })
    if (String(url) === "https://relay.test/workspaces/ws_cloud/session") {
      const body = JSON.parse(String(init?.body))
      const reservation = operations.find(({ operation }) => operation === "session.reserve")?.input
      expect(reservation).toBeDefined()
      expect(body.id).toBe(reservation?.sessionId)
      const operationId = reservation?.operationId
      if (typeof operationId !== "string") throw new Error("No canonical reservation operation id")
      expect(new Headers(init?.headers).get(RESERVATION_HEADER)).toBe(operationId)
      return Response.json({ id: body.id, title: "Created in cloud", time: { created: 10, updated: 10 } })
    }
    throw new Error(`Unexpected fetch ${url}`)
  }, { preconnect: () => undefined }))
  const transport = createTransport({ serverUrl: "http://127.0.0.1:4444", account: run })
  const account = createHostedAccount(run)
  const queryClient = new QueryClient()
  const workspaces = createWorkspaces(transport, queryClient, account)
  const sessions = createSessionsApi(transport, workspaces, createStatusOwner(transport), createWorkspaceWakes(transport, workspaces), createSessionProjection(transport, workspaces, account), account)
  try {
    const row = await sessions.create({ placementId: placementId("ws_cloud"), title: "Created in cloud" })
    expect(row.ref.sessionId).toEqual(expect.stringMatching(/^ses_/))
    expect(reservations).toEqual([{ method: "POST", path: "/api/control/session-registrations/reserve", body: expect.objectContaining({ workspaceId: "ws_cloud", kind: "create", title: "Created in cloud" }) }])
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["http://127.0.0.1:4444/api/claxedo/bootstrap", "https://relay.test/workspaces/ws_cloud/session"])
    for (let tick = 0; tick < 40; tick++) await Promise.resolve()
    expect(operations.some(({ operation }) => operation === "session.projection.register")).toBe(true)
  } finally {
    workspaces.dispose()
    queryClient.clear()
  }
})
