import { afterEach, describe, expect, test } from "vitest"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../../test-support/control-plane-migrations"
import { machineSessionCleanupScope, resolveDesktopCleanupOwner, resolveMachineCleanupOwner } from "./session-cleanup-machine"

const active: ControlPlaneDatabase[] = []
const host = { hostId: "host-1", enrollmentId: "enrollment-1", generation: 2 }
const now = { now: () => 100 }
const owner = { userId: "user-1", actorId: "actor-1", orgId: "org-1", projectId: "all-projects" as const }

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(ownerKind: "human" | "agent" = "human") {
  const instance = await miniflareControlPlaneDatabase()
  active.push(instance)
  const db = instance.database
  await db.batch([
    db.prepare("INSERT INTO users VALUES ('user-1', 'active', 1, 1, NULL, NULL)"),
    db.prepare("INSERT INTO actors VALUES ('actor-1', 'user-1', ?, 'active', 1, 1, NULL)").bind(ownerKind),
    db.prepare("INSERT INTO orgs VALUES ('org-1', 'Account', 'deployment', 'user-1', 'deployment-1', 1, 1, NULL)"),
    db.prepare(`INSERT INTO host_enrollments (
      enrollment_id, owner_user_id, owner_actor_id, host_id, public_key_json,
      display_name, last_seen_at, expires_at, created_at, updated_at, serving_generation
    ) VALUES ('enrollment-1', 'user-1', 'actor-1', 'host-1', '{}', 'Laptop', 90, 200, 1, 1, 2)`),
  ])
  return db
}

describe("machine session cleanup consent identity", () => {
  test("resolves an authenticated desktop without host enrollment or a registered workspace or session", async () => {
    const db = await database()
    await db.prepare("DELETE FROM host_enrollments").run()
    await expect(resolveDesktopCleanupOwner(db, owner)).resolves.toEqual(owner)
    for (const mismatch of [
      { ...owner, userId: "user-other" },
      { ...owner, actorId: "actor-other" },
      { ...owner, orgId: "org-other" },
    ]) await expect(resolveDesktopCleanupOwner(db, mismatch)).resolves.toBeUndefined()
    await db.batch([
      db.prepare("INSERT INTO users VALUES ('user-2', 'active', 1, 1, NULL, NULL)"),
      db.prepare("INSERT INTO actors VALUES ('actor-2', 'user-2', 'human', 'active', 1, 1, NULL)"),
    ])
    await expect(resolveDesktopCleanupOwner(db, { ...owner, actorId: "actor-2" })).resolves.toBeUndefined()
    await db.prepare("UPDATE users SET state = 'suspended', suspended_at = 100 WHERE user_id = 'user-1'").run()
    await expect(resolveDesktopCleanupOwner(db, owner)).resolves.toBeUndefined()
    await db.prepare("UPDATE users SET state = 'active', suspended_at = NULL WHERE user_id = 'user-1'").run()
    await db.prepare("UPDATE actors SET state = 'suspended' WHERE actor_id = 'actor-1'").run()
    await expect(resolveDesktopCleanupOwner(db, owner)).resolves.toBeUndefined()
    await expect(resolveDesktopCleanupOwner(await database("agent"), owner)).resolves.toBeUndefined()
  })

  test("withdraws desktop access when organization membership is revoked or its organization is deleted", async () => {
    const db = await database()
    await db.batch([
      db.prepare("INSERT INTO users VALUES ('user-2', 'active', 1, 1, NULL, NULL)"),
      db.prepare("INSERT INTO orgs VALUES ('org-2', 'Team', 'shared', 'user-2', NULL, 1, 1, NULL)"),
      db.prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at, updated_at) VALUES ('org-2', 'user-1', 'member', 1, 1)"),
    ])
    const member = { ...owner, orgId: "org-2" }
    await expect(resolveDesktopCleanupOwner(db, member)).resolves.toEqual(member)
    await db.prepare("UPDATE org_memberships SET revoked_at = 100 WHERE org_id = 'org-2'").run()
    await expect(resolveDesktopCleanupOwner(db, member)).resolves.toBeUndefined()
    await db.prepare("UPDATE org_memberships SET revoked_at = NULL WHERE org_id = 'org-2'").run()
    await db.prepare("UPDATE orgs SET deleted_at = 100 WHERE org_id = 'org-2'").run()
    await expect(resolveDesktopCleanupOwner(db, member)).resolves.toBeUndefined()
  })

  test("resolves a signed machine owner without any workspace, project, or session registration", async () => {
    const db = await database()
    await expect(resolveMachineCleanupOwner(db, host, "user-1", undefined, now)).resolves.toEqual(owner)
    await expect(resolveMachineCleanupOwner(db, host, "user-1", "org-1", now)).resolves.toEqual(owner)
    expect(machineSessionCleanupScope(owner, host)).toEqual({ ...owner, workspaceId: "desktop", host })
    expect(machineSessionCleanupScope(owner, host)).not.toHaveProperty("sessionId")
    const sessionOwner = { ...owner, sessionId: "unregistered-local-session", workspaceId: "local-folder" }
    expect(machineSessionCleanupScope(sessionOwner, host)).toEqual({ ...owner, workspaceId: "desktop", host })
  })

  test("rejects mismatched machine identity and every withdrawn enrollment state", async () => {
    const db = await database()
    for (const mismatch of [
      { ...host, hostId: "host-other" },
      { ...host, enrollmentId: "enrollment-other" },
      { ...host, generation: 3 },
      { ...host, generation: -1 },
    ]) await expect(resolveMachineCleanupOwner(db, mismatch, "user-1", undefined, now)).resolves.toBeUndefined()
    await expect(resolveMachineCleanupOwner(db, host, "user-other", undefined, now)).resolves.toBeUndefined()
    for (const field of ["paused_at", "revoked_at"] as const) {
      await db.prepare(`UPDATE host_enrollments SET ${field} = 100`).run()
      await expect(resolveMachineCleanupOwner(db, host, "user-1", undefined, now)).resolves.toBeUndefined()
      await db.prepare(`UPDATE host_enrollments SET ${field} = NULL`).run()
    }
    await db.prepare("UPDATE host_enrollments SET expires_at = 100").run()
    await expect(resolveMachineCleanupOwner(db, host, "user-1", undefined, now)).resolves.toBeUndefined()
  })

  test("requires an active canonical human owner", async () => {
    const db = await database()
    await db.prepare("UPDATE users SET state = 'suspended', suspended_at = 100").run()
    await expect(resolveMachineCleanupOwner(db, host, "user-1", undefined, now)).resolves.toBeUndefined()
    await db.prepare("UPDATE users SET state = 'active', suspended_at = NULL").run()
    await db.prepare("UPDATE actors SET state = 'suspended'").run()
    await expect(resolveMachineCleanupOwner(db, host, "user-1", undefined, now)).resolves.toBeUndefined()
    const agentOwned = await database("agent")
    await expect(resolveMachineCleanupOwner(agentOwned, host, "user-1", undefined, now)).resolves.toBeUndefined()
  })

  test("does not guess an organization; an explicit live organization disambiguates", async () => {
    const db = await database()
    await db.batch([
      db.prepare("INSERT INTO users VALUES ('user-2', 'active', 1, 1, NULL, NULL)"),
      db.prepare("INSERT INTO orgs VALUES ('org-2', 'Other', 'shared', 'user-2', NULL, 1, 1, NULL)"),
      db.prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at, updated_at) VALUES ('org-2', 'user-1', 'member', 1, 1)"),
    ])
    await expect(resolveMachineCleanupOwner(db, host, "user-1", undefined, now)).resolves.toBeUndefined()
    await expect(resolveMachineCleanupOwner(db, host, "user-1", "org-2", now)).resolves.toEqual({ ...owner, orgId: "org-2" })
    await db.prepare("UPDATE org_memberships SET revoked_at = 100 WHERE org_id = 'org-2'").run()
    await expect(resolveMachineCleanupOwner(db, host, "user-1", "org-2", now)).resolves.toBeUndefined()
    await expect(resolveMachineCleanupOwner(db, host, "user-1", undefined, now)).resolves.toEqual(owner)
    await db.prepare("UPDATE orgs SET deleted_at = 100 WHERE org_id = 'org-1'").run()
    await expect(resolveMachineCleanupOwner(db, host, "user-1", "org-1", now)).resolves.toBeUndefined()
  })
})
