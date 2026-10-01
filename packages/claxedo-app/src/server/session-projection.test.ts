/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "./ids"
import { createSessionProjection } from "./session-projection"
import type { Transport } from "./transport"
import type { Placement } from "./types"
import type { Workspaces } from "./workspaces"
import { createHostedAccount, type HostedAccount } from "./account"

function fixture(input: { issuesSessions: boolean; kind: Placement["kind"] }, account?: HostedAccount) {
  const posted: { path: string; body: unknown }[] = []
  const transport = {
    json: async (path: string, init?: RequestInit) => {
      posted.push({ path, body: JSON.parse(String(init?.body)) })
      return {}
    },
  } as Pick<Transport, "json"> as Transport
  const placement = { id: placementId("ws_1"), projectId: projectId("proj"), kind: input.kind, label: "main", reachable: true }
  const workspaces = {
    catalog: () => ({ declaration: { hostAggregate: false, issuesSessions: input.issuesSessions, documents: false, connections: false }, placements: [] }),
    byId: () => placement,
    locate: async () => ({ kind: input.kind, directory: "workspace:ws_1", workspaceId: "ws_1", remote: true }),
  } as Pick<Workspaces, "catalog" | "byId" | "locate"> as Workspaces
  return { posted, projection: createSessionProjection(transport, workspaces, account) }
}

const ref = { projectId: projectId("proj"), placementId: placementId("ws_1"), sessionId: sessionId("ses_1") }

async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
}

test("session projection: a cloud session on a server that issues sessions is registered, and each turn end asks for a checkpoint", async () => {
  const { posted, projection } = fixture({ issuesSessions: true, kind: "cloud" })

  await projection.created(ref)
  projection.observe({ type: "statusChanged", ref, status: { kind: "working" } })
  projection.observe({ type: "statusChanged", ref, status: { kind: "idle" } })
  await settle()

  expect(posted.map((call) => call.path)).toEqual([
    "/api/control/workspaces/ws_1/sessions/ses_1/register",
    "/api/control/workspaces/ws_1/sessions/ses_1/checkpoint",
  ])
  expect(posted[1]?.body).toMatchObject({ reason: "message-checkpoint" })
})

test("session projection: a folder's session, or a server that issues no sessions, is never pulled", async () => {
  for (const setup of [{ issuesSessions: true, kind: "folder" as const }, { issuesSessions: false, kind: "cloud" as const }]) {
    const { posted, projection } = fixture(setup)
    await projection.created(ref)
    projection.observe({ type: "statusChanged", ref, status: { kind: "idle" } })
    await settle()
    expect(posted).toEqual([])
  }
})

test("signed desktop cloud session registration and checkpoints use the account even when the daemon issues no sessions", async () => {
  const operations: { operation: string; input: unknown }[] = []
  const account = createHostedAccount(async (operation, input) => { operations.push({ operation, input }); return {} })
  const { projection, posted } = fixture({ issuesSessions: false, kind: "cloud" }, account)
  await projection.created(ref)
  projection.observe({ type: "statusChanged", ref, status: { kind: "idle" } })
  await settle()
  expect(operations.map(({ operation }) => operation)).toEqual(["session.projection.register", "session.projection.checkpoint"])
  expect(operations[1]?.input).toMatchObject({ workspaceId: "ws_1", sessionId: "ses_1", reason: "message-checkpoint" })
  expect(posted).toEqual([])
  const local = fixture({ issuesSessions: false, kind: "folder" }, account)
  await local.projection.created(ref)
  expect(operations).toHaveLength(2)
})
