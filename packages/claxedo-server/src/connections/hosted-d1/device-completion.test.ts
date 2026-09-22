import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

import {
  createConnectionsService,
  createIntegrationRegistry,
  createMemoryCredentialStore,
  workSourcePort,
  type IntegrationDeclaration,
  type IntegrationImpl,
} from "@claxedo/connections"

import { createD1ConnectionAttempts } from "./attempts"
import { createD1ConnectionStore } from "./connection-store"

/**
 * Two hosted requests completing ONE device grant.
 *
 * The kit's service serializes overlapping polls in a `Map` it owns, and the
 * hosted control plane builds a fresh service per request — so that map holds
 * nothing across the two isolates that race here. What actually keeps the
 * grant single-use is the attempt store's claim: one statement moves a row
 * from unclaimed to `completing`, and the poll that does not change a row
 * never reaches `storeConnection`. This test runs the interleaving the
 * in-process queue cannot see.
 */
const MIGRATIONS = ["0002_workspace_authority.sql", "0020_hosted_connections.sql", "0021_mcp_oauth_clients.sql"]

const ORG_ID = "org-1"
const USER_ID = "user-1"

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
  await target
    .prepare(`insert into users (user_id, state, created_at, updated_at) values (?, 'active', 1, 1)`)
    .bind(USER_ID)
    .run()
  await target
    .prepare(`insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values (?, ?, 'team', ?, 1, 1)`)
    .bind(ORG_ID, ORG_ID, USER_ID)
    .run()
  return target
}

const DECL: IntegrationDeclaration = {
  id: "github",
  name: "GitHub",
  methods: ["oauth"],
  prompts: [],
}

test("two concurrent completions of one device attempt yield exactly one connection", async () => {
  const target = await database()
  // One credential store for the org, as the hosted composition builds it —
  // the two requests share the secret namespace they would share in
  // production.
  const credentials = createMemoryCredentialStore()
  const puts: string[] = []
  const countingCredentials = {
    ...credentials,
    put: async (input: Parameters<typeof credentials.put>[0]) => {
      puts.push(input.providerId)
      return credentials.put(input)
    },
  }

  // Both polls reach the provider before either claims the attempt: the
  // barrier holds the first inside `poll` until the second is there too, so
  // the claim is the only thing that can separate them.
  let waiting = 0
  let release: (() => void) | undefined
  const bothPolling = new Promise<void>((resolve) => {
    release = resolve
  })
  const impl: IntegrationImpl = {
    actions: { "work-source": workSourcePort },
    auth: {
      verify: async () => ({ ok: true, accountLabel: "acme" }),
      device: {
        start: async () => ({
          deviceCode: "device-abc",
          userCode: "WDJB-MJHT",
          verificationUri: "https://github.com/login/device",
          intervalMs: 10,
          expiresAt: Date.now() + 900_000,
        }),
        poll: async () => {
          waiting++
          if (waiting >= 2) release?.()
          await bothPolling
          return { status: "complete", tokens: { accessToken: "ghu_access" } }
        },
      },
    },
  }

  /** One request's service, exactly as `hostedConnectionsService` composes it. */
  const request = () => {
    const registry = createIntegrationRegistry()
    registry.register(DECL, impl)
    return createConnectionsService({
      registry,
      credentials: countingCredentials,
      connections: createD1ConnectionStore({ database: target, orgId: ORG_ID, ownerUserId: USER_ID }),
      attempts: createD1ConnectionAttempts({ database: target }),
      newId: () => crypto.randomUUID(),
    })
  }

  const started = await request().connectOAuth({
    integrationId: "github",
    owner: `user:${USER_ID}`,
    teamOwner: `org:${ORG_ID}`,
  })
  expect(started.ok).toBe(true)
  if (!started.ok) return

  const [first, second] = await Promise.all([
    request().pollAttempt(started.attemptId),
    request().pollAttempt(started.attemptId),
  ])

  expect(waiting).toBe(2)
  const rows = await target
    .prepare(`select connection_id from hosted_connections where org_id = ?`)
    .bind(ORG_ID)
    .all<{ connection_id: string }>()
  expect(rows.results).toHaveLength(1)
  expect(puts).toEqual([`integration:${rows.results[0]?.connection_id}`])
  // The loser re-reads the attempt instead of completing one of its own. It
  // sees `pending` when it reads between the winner's claim and the winner's
  // settle — the mid-consume row both stores report as still running — so the
  // client polls once more; what it can never see is a second grant.
  const statuses = [first?.status, second?.status]
  expect(statuses.filter((status) => status === "complete")).not.toHaveLength(0)
  expect(statuses.every((status) => status === "complete" || status === "pending")).toBe(true)
})
