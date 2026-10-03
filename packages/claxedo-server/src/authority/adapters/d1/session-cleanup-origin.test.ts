import type { D1Database } from "@cloudflare/workers-types"
import { afterEach, describe, expect, test } from "vitest"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../../test-support/control-plane-migrations"
import { cleanupOrigin, cleanupOriginParentMatches } from "./session-cleanup-origin"

const active: ControlPlaneDatabase[] = []
const alice = { userId: "alice", actorId: "actor-alice" }
const bob = { userId: "bob", actorId: "actor-bob" }
const workspaceId = "workspace-main"

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function setup() {
  const instance = await miniflareControlPlaneDatabase()
  active.push(instance)
  const database = instance.database
  await database.batch([
    database.prepare("INSERT INTO users VALUES ('alice', 'active', 1, 1, NULL, NULL)"),
    database.prepare("INSERT INTO users VALUES ('bob', 'active', 1, 1, NULL, NULL)"),
    database.prepare("INSERT INTO actors VALUES ('actor-alice', 'alice', 'human', 'active', 1, 1, NULL)"),
    database.prepare("INSERT INTO actors VALUES ('actor-bob', 'bob', 'human', 'active', 1, 1, NULL)"),
    database.prepare("INSERT INTO actors VALUES ('actor-agent', NULL, 'agent', 'active', 1, 1, NULL)"),
    database.prepare("INSERT INTO orgs VALUES ('org-main', 'Team', 'shared', 'alice', NULL, 1, 1, NULL)"),
    database.prepare("INSERT INTO projects VALUES ('project-main', 'org-main', 'repository-main', 'alice', 1, 1, NULL)"),
    ...[workspaceId, "workspace-other"].map((id) => database.prepare(`
      INSERT INTO workspaces (workspace_id, org_id, project_id, owner_user_id, backing, display_name, created_at, updated_at)
      VALUES (?, 'org-main', 'project-main', 'alice', 'cloud-vm', ?, 1, 1)
    `).bind(id, id)),
  ])
  return database
}

async function session(database: D1Database, id: string, input: {
  creator?: string
  parent?: string
  workspace?: string
  deletedAt?: number
  forkSource?: string
} = {}) {
  const creator = input.creator ?? alice.actorId
  const workspace = input.workspace ?? workspaceId
  await database.batch([
    database.prepare(`
      INSERT INTO session_registration_operations (
        operation_id, session_id, workspace_id, org_id, project_id, creator_actor_id,
        operation_kind, parent_session_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'org-main', 'project-main', ?, ?, ?, 'registered', 1, 1)
    `).bind(`operation-${id}`, id, workspace, creator, input.forkSource ? "fork" : "create", input.forkSource ?? null),
    database.prepare(`
      INSERT INTO sessions (
        session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id,
        lifecycle_generation, created_at, updated_at, parent_session_id, deleted_at
      ) VALUES (?, ?, ?, 'org-main', 'project-main', ?, 1, 1, 1, ?, ?)
    `).bind(id, `operation-${id}`, workspace, creator, input.parent ?? null, input.deletedAt ?? null),
  ])
}

async function producer(database: D1Database, sessionId: string, actorId: string) {
  await database.prepare(`
    INSERT INTO session_turn_producers (
      session_id, workspace_id, org_id, project_id, turn_id, fencing_token, actor_id, admitted_at
    ) VALUES (?, ?, 'org-main', 'project-main', ?, 1, ?, 1)
  `).bind(sessionId, workspaceId, `turn-${sessionId}`, actorId).run()
}

function allowed(database: D1Database, sessionId: string, identity = alice, workspace = workspaceId) {
  return cleanupOrigin(database, identity.userId, identity.actorId, workspace, sessionId)
}

describe("session cleanup originating human", () => {
  test("permits an owner's root and descendants with owner and agent activity", async () => {
    const database = await setup()
    await session(database, "root")
    await session(database, "child", { parent: "root" })
    await session(database, "grandchild", { parent: "child" })
    await producer(database, "root", alice.actorId)
    await producer(database, "child", "actor-agent")
    await producer(database, "grandchild", "actor-agent")
    for (const id of ["root", "child", "grandchild"]) await expect(allowed(database, id)).resolves.toBe(true)
    expect(await database.prepare("SELECT parent_session_id FROM session_registration_operations WHERE session_id = 'child'")
      .first()).toEqual({ parent_session_id: null })
  })

  test.each(["root", "child"])("refuses a descendant after a different human produced work in %s", async (ancestor) => {
    const database = await setup()
    await session(database, "root")
    await session(database, "child", { parent: "root" })
    await session(database, "grandchild", { parent: "child" })
    await expect(allowed(database, "grandchild")).resolves.toBe(true)
    await producer(database, ancestor, bob.actorId)
    await expect(allowed(database, "grandchild")).resolves.toBe(false)
    await expect(allowed(database, ancestor)).resolves.toBe(false)
  })

  test("refuses an Alice-created child beneath a Bob-created ancestor", async () => {
    const database = await setup()
    await session(database, "root", { creator: bob.actorId })
    await session(database, "child", { parent: "root" })
    await session(database, "grandchild", { parent: "child" })
    await expect(allowed(database, "root", bob)).resolves.toBe(true)
    await expect(allowed(database, "child")).resolves.toBe(false)
    await expect(allowed(database, "grandchild")).resolves.toBe(false)
  })

  test.each(["deleted", "missing", "cycle", "self-cycle", "cross-workspace"] as const)("refuses %s runtime ancestry", async (kind) => {
    const database = await setup()
    if (kind !== "missing") await session(database, "root", {
      ...(kind === "deleted" ? { deletedAt: 2 } : {}),
      ...(kind === "cycle" ? { parent: "child" } : {}),
      ...(kind === "cross-workspace" ? { workspace: "workspace-other" } : {}),
    })
    await session(database, "child", { parent: kind === "self-cycle" ? "child" : "root" })
    await expect(allowed(database, "child")).resolves.toBe(false)
  })

  test("uses runtime ancestry separately from the registration fork source", async () => {
    const database = await setup()
    await session(database, "bob-source", { creator: bob.actorId })
    await producer(database, "bob-source", bob.actorId)
    await session(database, "alice-fork", { forkSource: "bob-source" })
    await expect(allowed(database, "alice-fork")).resolves.toBe(true)
    await expect(cleanupOriginParentMatches(database, workspaceId, "alice-fork", undefined)).resolves.toBe(true)
    await expect(cleanupOriginParentMatches(database, workspaceId, "alice-fork", "bob-source")).resolves.toBe(false)
  })

  test("requires the live canonical human identity and a live session in the specified workspace", async () => {
    const database = await setup()
    await session(database, "root")
    await expect(allowed(database, "root", { userId: bob.userId, actorId: alice.actorId })).resolves.toBe(false)
    await expect(allowed(database, "root", { userId: alice.userId, actorId: bob.actorId })).resolves.toBe(false)
    await expect(allowed(database, "root", bob)).resolves.toBe(false)
    await expect(allowed(database, "root", alice, "workspace-other")).resolves.toBe(false)
    await expect(allowed(database, "absent")).resolves.toBe(false)
    await database.prepare("UPDATE actors SET state = 'suspended' WHERE actor_id = 'actor-alice'").run()
    await expect(allowed(database, "root")).resolves.toBe(false)
    await database.prepare("UPDATE actors SET state = 'active' WHERE actor_id = 'actor-alice'").run()
    await database.prepare("UPDATE users SET state = 'suspended', suspended_at = 2 WHERE user_id = 'alice'").run()
    await expect(allowed(database, "root")).resolves.toBe(false)
    await database.prepare("UPDATE users SET state = 'active', suspended_at = NULL WHERE user_id = 'alice'").run()
    await database.prepare("UPDATE sessions SET deleted_at = 2 WHERE session_id = 'root'").run()
    await expect(allowed(database, "root")).resolves.toBe(false)
  })

  test("requires the published runtime parent to match the active authoritative row", async () => {
    const database = await setup()
    await session(database, "root")
    await session(database, "child", { parent: "root" })
    await expect(cleanupOriginParentMatches(database, workspaceId, "root", undefined)).resolves.toBe(true)
    await expect(cleanupOriginParentMatches(database, workspaceId, "child", "root")).resolves.toBe(true)
    await expect(cleanupOriginParentMatches(database, workspaceId, "child", undefined)).resolves.toBe(false)
    await expect(cleanupOriginParentMatches(database, workspaceId, "child", "other-parent")).resolves.toBe(false)
    await expect(cleanupOriginParentMatches(database, workspaceId, "root", "child")).resolves.toBe(false)
    await expect(cleanupOriginParentMatches(database, "workspace-other", "child", "root")).resolves.toBe(false)
    await expect(cleanupOriginParentMatches(database, workspaceId, "absent", undefined)).resolves.toBe(false)
    await database.prepare("UPDATE sessions SET deleted_at = 2 WHERE session_id = 'child'").run()
    await expect(cleanupOriginParentMatches(database, workspaceId, "child", "root")).resolves.toBe(false)
  })
})
