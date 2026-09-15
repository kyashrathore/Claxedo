import { afterEach, describe, expect, test } from "vitest"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { createD1SandboxPassRegister } from "./d1-sandbox-pass-register"
import { memorySandboxPassRegister, type SandboxPassRecord, type SandboxPassRegister } from "./sandbox-pass-register"

const active: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

const START = 1_700_000_000_000

function pass(overrides: Partial<SandboxPassRecord> & { jti: string }): SandboxPassRecord {
  return {
    audience: "claxedo-tasks-capability",
    scope: { userId: "user-1", orgId: "org-1", workspaceId: "ws_root", projectId: "project-a", sessionId: "ses_1" },
    issuedAt: START,
    expiresAt: START + 30 * 60_000,
    ...overrides,
  }
}

type Clock = { now: number }

const registers: Record<string, (clock: Clock) => Promise<SandboxPassRegister>> = {
  memory: async (clock) => memorySandboxPassRegister({ now: () => clock.now }),
  d1: async (clock) => {
    const instance = await miniflareControlPlaneDatabase(["0027_sandbox_pass_revocations.sql"])
    active.push(instance)
    return createD1SandboxPassRegister({ database: instance.database, now: () => clock.now })
  },
}

describe.each(Object.entries(registers))("the %s sandbox pass register", (_name, open) => {
  test("a recorded pass is not revoked until its workspace's passes are", async () => {
    const register = await open({ now: START })
    await register.record(pass({ jti: "one" }))
    expect(await register.revoked("one")).toBe(false)
    expect(await register.revoked("never-minted")).toBe(false)

    expect(await register.revoke({ workspaceId: "ws_root", reason: "tasks_group_disabled" })).toBe(1)
    expect(await register.revoked("one")).toBe(true)
    expect(await register.revoke({ workspaceId: "ws_root", reason: "again" })).toBe(0)
  })

  test("revokes one audience of a workspace and leaves the other audience and other workspaces alone", async () => {
    const register = await open({ now: START })
    await register.record(pass({ jti: "tasks" }))
    await register.record(pass({ jti: "gateway", audience: "agent-plugins-mcp-gateway" }))
    await register.record(pass({ jti: "elsewhere", scope: { userId: "user-1", orgId: "org-1", workspaceId: "ws_other" } }))

    expect(await register.revoke({ workspaceId: "ws_root", audience: "claxedo-tasks-capability", reason: "off" })).toBe(1)
    expect(await register.revoked("tasks")).toBe(true)
    expect(await register.revoked("gateway")).toBe(false)
    expect(await register.revoked("elsewhere")).toBe(false)

    expect(await register.revoke({ workspaceId: "ws_root", reason: "workspace_deleted" })).toBe(1)
    expect(await register.revoked("gateway")).toBe(true)
  })

  test("lists the outstanding passes of one organization and audience, expired and revoked ones excluded", async () => {
    const clock = { now: START }
    const register = await open(clock)
    await register.record(pass({ jti: "live" }))
    await register.record(pass({ jti: "short", expiresAt: START + 60_000 }))
    await register.record(pass({ jti: "taken", scope: { userId: "user-2", orgId: "org-1", workspaceId: "ws_two", projectId: "project-a" } }))
    await register.record(pass({ jti: "other-org", scope: { userId: "user-3", orgId: "org-2", workspaceId: "ws_three" } }))
    await register.record(pass({ jti: "other-audience", audience: "agent-plugins-mcp-gateway" }))
    await register.revoke({ workspaceId: "ws_two", reason: "off" })
    clock.now = START + 120_000

    const outstanding = await register.outstanding({ orgId: "org-1", audience: "claxedo-tasks-capability" })
    expect(outstanding.map((entry) => entry.jti)).toEqual(["live"])
    expect(outstanding[0]).toEqual(pass({ jti: "live" }))
  })

  test("a mint prunes the passes that have already expired", async () => {
    const clock = { now: START }
    const register = await open(clock)
    await register.record(pass({ jti: "old", expiresAt: START + 1_000 }))
    clock.now = START + 2_000
    await register.record(pass({ jti: "new", expiresAt: START + 60_000 }))
    await register.revoke({ workspaceId: "ws_root", reason: "off" })
    expect(await register.revoked("new")).toBe(true)
    expect(await register.revoked("old")).toBe(false)
  })
})
