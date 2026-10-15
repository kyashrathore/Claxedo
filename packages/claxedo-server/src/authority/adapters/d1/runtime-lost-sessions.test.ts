import { afterEach, describe, expect, test } from "vitest"
import { d1Authority } from "../../../test-support/d1-authority"
import { publishD1HostSessionRows } from "./host-session-rows"
import { D1SessionAuthority } from "./session-authority"
import { interruptD1RuntimeSessions } from "./runtime-lost-sessions"

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const step of cleanup.splice(0)) await step()
})

async function workspaceWithSessions() {
  const fixture = await d1Authority()
  cleanup.push(fixture.dispose)
  const owner = await fixture.signIn("owner")
  await fixture.authority.usersMe(owner)
  await fixture.authority.createCloudWorkspace(owner, { workspaceId: "ws_cloud", displayName: "Cloud" })
  await fixture.authority.createCloudWorkspace(owner, { workspaceId: "ws_other", displayName: "Other" })
  const row = (workspaceId: string, sessionId: string, kind: "busy" | "retry" | "idle") =>
    ({ workspaceId, sessionId, createdAt: 1, updatedAt: 2, status: { kind, awaitingInput: kind === "busy", at: 3 } })
  const registry = new D1SessionAuthority(fixture.database, { deploymentId: "test" })
  await registry.reserveSession(owner, { operationId: "op_own_host", sessionId: "ses_own_host", workspaceId: "ws_cloud", kind: "create", harnessId: "pi" })
  await registry.registerRuntimeSession({
    principalKind: "user", actorId: owner.principal!.actorId, actorKind: "human", operationId: "op_own_host", sessionId: "ses_own_host", workspaceId: "ws_cloud", sessionHostRoot: "ses_own_host", createdAt: 1, updatedAt: 1,
  })
  await publishD1HostSessionRows(fixture.database, 10, {
    hostId: "host-cloud", ownerUserId: owner.principal!.userId, workspaceIds: ["ws_cloud", "ws_other"], servedBy: "sandbox",
  }, {
    rows: [
      row("ws_cloud", "ses_busy", "busy"),
      row("ws_cloud", "ses_retry", "retry"),
      row("ws_cloud", "ses_idle", "idle"),
      row("ws_cloud", "ses_own_host", "busy"),
      row("ws_other", "ses_elsewhere", "busy"),
    ],
    removed: [],
  })
  const status = async (sessionId: string) => await fixture.database
    .prepare("select status, status_at, awaiting_input from sessions where session_id = ?")
    .bind(sessionId)
    .first<{ status: string; status_at: number; awaiting_input: number }>()
  return { fixture, owner, status }
}

describe("a workspace whose runtime is lost", () => {
  test("its runtime's running sessions read interrupted from that moment, each reader is told once, and nothing else changes", async () => {
    const { fixture, owner, status } = await workspaceWithSessions()

    const notices = await interruptD1RuntimeSessions(fixture.database, "ws_cloud", 50)

    expect(await status("ses_busy")).toEqual({ status: "interrupted", status_at: 50, awaiting_input: 0 })
    expect(await status("ses_retry")).toEqual({ status: "interrupted", status_at: 50, awaiting_input: 0 })
    expect(await status("ses_idle")).toMatchObject({ status: "idle", status_at: 3 })
    expect(await status("ses_own_host")).toMatchObject({ status: "busy", status_at: 3 })
    expect(await status("ses_elsewhere")).toMatchObject({ status: "busy", status_at: 3 })
    expect(notices.map((notice) => [notice.sessionId, notice.status, notice.ownerUserId, notice.ts]).sort()).toEqual([
      ["ses_busy", "interrupted", owner.principal!.userId, 50],
      ["ses_retry", "interrupted", owner.principal!.userId, 50],
    ])
    expect(await interruptD1RuntimeSessions(fixture.database, "ws_cloud", 60)).toEqual([])
  })

  test("a status the runtime reported after the loss was learned is left as the runtime said", async () => {
    const { fixture, status } = await workspaceWithSessions()

    expect(await interruptD1RuntimeSessions(fixture.database, "ws_cloud", 2)).toEqual([])
    expect(await status("ses_busy")).toMatchObject({ status: "busy", status_at: 3 })
  })
})
