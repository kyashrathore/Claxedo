import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

import { createD1ConnectionStore, HostedConnectionExistsError, HostedConnectionPartitionError } from "./connection-store"

// 0002 owns `users` and `orgs`, which 0020's foreign keys reference; 0020 owns
// the table under test. The real migration files run — a hand-written schema in
// the test would prove the store works against a table that does not ship.
// 0021 is inert here (it adds only `mcp_oauth_clients`, which this store never
// reads) and runs so the applied order matches production.
const MIGRATIONS = ["0002_workspace_authority.sql", "0020_hosted_connections.sql", "0021_mcp_oauth_clients.sql"]

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

/**
 * The store never writes users or orgs; the authority does. These rows exist so
 * the migration's foreign keys describe real referents.
 */
async function seed(target: D1Database, orgs: readonly string[], users: readonly [string, ...string[]]) {
  for (const userId of users) {
    await target
      .prepare(`insert into users (user_id, state, created_at, updated_at) values (?, 'active', 1, 1)`)
      .bind(userId)
      .run()
  }
  for (const orgId of orgs) {
    await target
      .prepare(
        `insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values (?, ?, 'team', ?, 1, 1)`,
      )
      .bind(orgId, orgId, users[0])
      .run()
  }
}

const row = (input: {
  id: string
  integrationId: string
  owner?: string
  accountLabel?: string
  fields?: Record<string, string>
}) => ({
  id: input.id,
  integrationId: input.integrationId,
  ...(input.owner !== undefined ? { owner: input.owner } : {}),
  ...(input.accountLabel !== undefined ? { accountLabel: input.accountLabel } : {}),
  grantedCapabilities: ["mcp" as const],
  fields: input.fields ?? {},
  createdAt: 1_000,
  updatedAt: 1_000,
})

describe("D1 hosted connection store", () => {
  test("partitions rows by org and owner and never leaks across either boundary", async () => {
    const target = await database()
    await seed(target, ["org-a", "org-b"], ["user-1", "user-2"])
    const now = () => 2_000
    const aliceInA = createD1ConnectionStore({ database: target, orgId: "org-a", ownerUserId: "user-1", now })
    const bobInA = createD1ConnectionStore({ database: target, orgId: "org-a", ownerUserId: "user-2", now })
    const aliceInB = createD1ConnectionStore({ database: target, orgId: "org-b", ownerUserId: "user-1", now })

    await aliceInA.upsert(row({ id: "conn-personal", integrationId: "context7", owner: "user:user-1" }))
    await aliceInA.upsert(row({ id: "conn-org", integrationId: "composio", owner: "org:org-a" }))
    await aliceInB.upsert(row({ id: "conn-other-org", integrationId: "context7", owner: "user:user-1" }))

    // Alice sees her personal row plus the organization row, and nothing from org-b.
    expect((await aliceInA.list()).map((entry) => entry.id).toSorted()).toEqual(["conn-org", "conn-personal"])
    // Bob is in the same org: the organization row is his too, Alice's personal row is not.
    expect((await bobInA.list()).map((entry) => entry.id)).toEqual(["conn-org"])
    expect(await bobInA.getById("conn-personal")).toBeUndefined()
    // Cross-org reads are refused by the SQL scope, not by a caller-side filter.
    expect(await aliceInA.getById("conn-other-org")).toBeUndefined()
    expect((await aliceInB.list()).map((entry) => entry.id)).toEqual(["conn-other-org"])

    // Explicit partition filters.
    expect((await aliceInA.list({ owner: "user:user-1" })).map((entry) => entry.id)).toEqual(["conn-personal"])
    expect((await aliceInA.list({ owner: "org:org-a" })).map((entry) => entry.id)).toEqual(["conn-org"])
    // The kit's owner-absent partition does not exist on a refusing host, and a
    // foreign owner key belongs to neither of this caller's partitions.
    expect(await aliceInA.list({ owner: null })).toEqual([])
    expect(await aliceInA.list({ owner: "user:user-2" })).toEqual([])

    expect(await aliceInA.get("context7", "user:user-1")).toMatchObject({ id: "conn-personal", owner: "user:user-1" })
    expect(await aliceInA.get("composio", "org:org-a")).toMatchObject({ id: "conn-org", owner: "org:org-a" })
    expect(await aliceInA.get("context7", "org:org-a")).toBeUndefined()
    expect(await aliceInA.get("context7", "user:user-2")).toBeUndefined()
  })

  test("refuses a write outside the authenticated partitions", async () => {
    const target = await database()
    await seed(target, ["org-a"], ["user-1", "user-2"])
    const store = createD1ConnectionStore({ database: target, orgId: "org-a", ownerUserId: "user-1" })

    await expect(store.upsert(row({ id: "conn-x", integrationId: "context7", owner: "user:user-2" })))
      .rejects.toThrow(/outside the authenticated partitions/)
    // The kit's owner-absent partition is refused for the same reason.
    await expect(store.upsert(row({ id: "conn-y", integrationId: "context7" })))
      .rejects.toThrow(/outside the authenticated partitions/)
    expect(await store.list()).toEqual([])
  })

  test("upsert replaces the same row in place and delete is partition-scoped", async () => {
    const target = await database()
    await seed(target, ["org-a"], ["user-1", "user-2"])
    const alice = createD1ConnectionStore({ database: target, orgId: "org-a", ownerUserId: "user-1", now: () => 5_000 })
    const bob = createD1ConnectionStore({ database: target, orgId: "org-a", ownerUserId: "user-2" })

    await alice.upsert(row({ id: "conn-1", integrationId: "context7", owner: "user:user-1", accountLabel: "first" }))
    await alice.upsert(row({
      id: "conn-1",
      integrationId: "context7",
      owner: "user:user-1",
      accountLabel: "second",
      fields: { site: "https://example.test" },
    }))
    expect(await alice.list()).toMatchObject([
      { id: "conn-1", accountLabel: "second", fields: { site: "https://example.test" }, createdAt: 1_000, updatedAt: 5_000 },
    ])

    // Bob cannot delete Alice's personal row even holding its id.
    expect(await bob.delete("conn-1")).toBe(false)
    expect(await alice.delete("conn-1")).toBe(true)
    expect(await alice.delete("conn-1")).toBe(false)
    expect(await alice.list()).toEqual([])
  })

  test("normalizes atlassian to the stored jira id", async () => {
    const target = await database()
    await seed(target, ["org-a"], ["user-1"])
    const store = createD1ConnectionStore({ database: target, orgId: "org-a", ownerUserId: "user-1" })

    await store.upsert(row({ id: "conn-jira", integrationId: "atlassian", owner: "org:org-a" }))
    await store.upsert(row({ id: "conn-linear", integrationId: "linear", owner: "org:org-a" }))

    const stored = await target
      .prepare(`select integration_id from hosted_connections order by connection_id`)
      .all<{ integration_id: string }>()
    expect(stored.results).toEqual([{ integration_id: "jira" }, { integration_id: "linear" }])

    // Reads translate back to the kit's id, so nothing above the store sees `jira`.
    expect((await store.list()).map((entry) => entry.integrationId).toSorted()).toEqual(["atlassian", "linear"])
    expect(await store.get("atlassian", "org:org-a")).toMatchObject({ id: "conn-jira", integrationId: "atlassian" })
    expect(await store.getById("conn-jira")).toMatchObject({ integrationId: "atlassian" })
  })

  test("one row per integration per partition is a database invariant, not a convention", async () => {
    const target = await database()
    await seed(target, ["org-a"], ["user-1"])
    const store = createD1ConnectionStore({ database: target, orgId: "org-a", ownerUserId: "user-1" })

    await store.upsert(row({ id: "conn-1", integrationId: "context7", owner: "user:user-1" }))
    // The service reuses the existing row's id when replacing, so a SECOND id
    // for the same (org, owner, integration) is unreachable through it — and
    // would strand a credential no route could ever resolve.
    await expect(store.upsert(row({ id: "conn-2", integrationId: "context7", owner: "user:user-1" })))
      .rejects.toThrow(HostedConnectionExistsError)
    // The organization partition is a distinct partition, not a duplicate.
    await store.upsert(row({ id: "conn-3", integrationId: "context7", owner: "org:org-a" }))
    expect((await store.list()).map((entry) => entry.id).toSorted()).toEqual(["conn-1", "conn-3"])
  })

  test("an upsert onto an id owned by another partition is refused and leaves the victim untouched", async () => {
    // `connection_id` is the PRIMARY KEY, so an `on conflict (connection_id)`
    // with no predicate reaches EVERY row in the table. Scoping reads alone is
    // not enough: the write has to be scoped too, or naming a foreign id
    // overwrites its owner's row from inside another tenant's request.
    const target = await database()
    await seed(target, ["org-a", "org-b"], ["user-1", "user-2"])
    const victim = createD1ConnectionStore({ database: target, orgId: "org-b", ownerUserId: "user-2", now: () => 1_000 })
    await victim.upsert(row({
      id: "conn-victim",
      integrationId: "context7",
      owner: "user:user-2",
      accountLabel: "victim",
      fields: { site: "https://victim.test" },
    }))
    const before = await victim.getById("conn-victim")

    const attackerInOtherOrg = createD1ConnectionStore({ database: target, orgId: "org-a", ownerUserId: "user-1" })
    await expect(attackerInOtherOrg.upsert(row({
      id: "conn-victim",
      integrationId: "linear",
      owner: "user:user-1",
      accountLabel: "stolen",
    }))).rejects.toThrow(HostedConnectionPartitionError)

    // Same org, different owner: the personal partition is a boundary too.
    const attackerInSameOrg = createD1ConnectionStore({ database: target, orgId: "org-b", ownerUserId: "user-1" })
    await expect(attackerInSameOrg.upsert(row({
      id: "conn-victim",
      integrationId: "linear",
      owner: "user:user-1",
      accountLabel: "stolen",
    }))).rejects.toThrow(HostedConnectionPartitionError)

    // ...and the organization partition of the victim's own org.
    await expect(attackerInSameOrg.upsert(row({
      id: "conn-victim",
      integrationId: "linear",
      owner: "org:org-b",
      accountLabel: "stolen",
    }))).rejects.toThrow(HostedConnectionPartitionError)

    expect(await victim.getById("conn-victim")).toEqual(before)
    // Nothing was written for the attacker either — a refused upsert is not a
    // partial one.
    expect(await attackerInOtherOrg.list()).toEqual([])
    expect(await attackerInSameOrg.list()).toEqual([])
  })
})
