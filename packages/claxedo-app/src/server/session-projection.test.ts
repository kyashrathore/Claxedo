/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createHostedAccount } from "./account"
import { placementId, projectId, sessionId } from "./ids"
import { createSessionProjection } from "./session-projection"
import type { Placement } from "./types"
import type { Workspaces } from "./workspaces"

function fixture(kind: Placement["kind"], signed: boolean, sessionHost?: { sessionId: string }) {
  const runs: { operation: string; input: unknown }[] = []
  const account = createHostedAccount(async (operation, input) => (runs.push({ operation, input }), {}))
  const placement = { id: placementId("ws_1"), projectId: projectId("proj"), kind, label: "main", reachable: true }
  const route = { directory: "workspace:ws_1", workspaceId: "ws_1", remote: true, ...(sessionHost ? { sessionHost } : {}) }
  const workspaces = {
    byId: () => placement,
    locate: async () => route,
    home: async () => ({ route, central: !sessionHost, live: true }),
  } as Pick<Workspaces, "byId" | "locate" | "home"> as Workspaces
  return { runs, projection: createSessionProjection(workspaces, signed ? account : undefined) }
}

const ref = { projectId: projectId("proj"), placementId: placementId("ws_1"), sessionId: sessionId("ses_1") }

async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
}

test("session projection: a signed cloud session is registered through the account, and each turn end asks it for a checkpoint", async () => {
  const { runs, projection } = fixture("cloud", true)

  await projection.created(ref)
  projection.observe({ type: "statusChanged", ref, status: { kind: "working" } })
  projection.observe({ type: "statusChanged", ref, status: { kind: "idle" } })
  await settle()

  expect(runs.map((run) => run.operation)).toEqual(["session.projection.register", "session.projection.checkpoint"])
  expect(runs[1]?.input).toMatchObject({ workspaceId: "ws_1", sessionId: "ses_1", reason: "message-checkpoint" })
})

test("session projection: a folder's session, or one with no account, is never pulled", async () => {
  for (const { runs, projection } of [fixture("folder", true), fixture("cloud", false)]) {
    await projection.created(ref)
    projection.observe({ type: "statusChanged", ref, status: { kind: "idle" } })
    await settle()
    expect(runs).toEqual([])
  }
})

test("session projection: a session served by its own host keeps its transcript there, so each turn end pulls its row again, never a checkpoint", async () => {
  const { runs, projection } = fixture("cloud", true, { sessionId: "ses_1" })

  await projection.created(ref)
  projection.observe({ type: "statusChanged", ref, status: { kind: "idle" } })
  await settle()

  expect(runs.map((run) => run.operation)).toEqual(["session.projection.register", "session.projection.register"])
  expect(runs[1]?.input).toMatchObject({ workspaceId: "ws_1", sessionId: "ses_1", reason: "message-checkpoint" })
})
