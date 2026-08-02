import BetterSqlite3 from "better-sqlite3"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { createSqliteWorkGraphService } from "@claxedo/workgraph"
import type { ChangeCursor, OperationID, SnapshotResumeCursor, WorkGraphContext } from "@claxedo/workgraph/contracts"
import { percentile, round2 } from "../../workspace-relay/bench/lib/stats"
import { api } from "../../../convex/_generated/api"
import schema from "../../../convex/schema"
import { createHostedWorkGraph } from "../src/workgraph-host/hosted"
import type { ClaxedoEvent } from "../src/bus"
import type { WorkspaceAuthority } from "../src/control-plane/authority"
import type { LiveSyncRoomNamespace } from "../src/live-sync-room"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("../../../convex/**/*.ts")
const sqliteCommandCount = Number(process.env.CLAXEDO_STRESS_SQLITE_COMMANDS ?? 10_000)
const hostedCommandCount = Number(process.env.CLAXEDO_STRESS_HOSTED_COMMANDS ?? 256)
const dirtyTenantCount = Number(process.env.CLAXEDO_STRESS_DIRTY_TENANTS ?? 1_000)
const report: string[] = [
  "# WorkGraph stress report",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Lane | Shape | p50 | p95 | p99 | Integrity | Verdict |",
  "|---|---|---:|---:|---:|---|---|",
]

afterAll(async () => {
  const directory = path.resolve(import.meta.dirname, "../bench-reports")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "workgraph-latest.md"), `${report.join("\n")}\n`)
})

describe("WorkGraph stress gates", () => {
  test("SQLite memory and file lanes retain every change at 10k history", async () => {
    const memory = await runSqliteLane(":memory:", 50)
    const directory = await mkdtemp(path.join(tmpdir(), "claxedo-workgraph-stress-"))
    try {
      const file = await runSqliteLane(path.join(directory, "workgraph.sqlite"), 150)
      expect(memory.pass).toBe(true)
      expect(file.pass).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  test("hosted convex-test commits concurrent commands and emits one doorbell per command", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "stress-secret")
    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "issuer|stress-owner",
        clerk_subject: "stress-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Hosted stress",
        clerk_org_id: "clerk_org_stress",
        kind: "clerk",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      await ctx.db.insert("org_memberships", {
        org_id: organizationId,
        user_id: ownerUserId,
        role: "owner",
        created_at: 1,
        updated_at: 1,
      })
      return { organizationId, ownerUserId }
    })
    const nudges: ClaxedoEvent[] = []
    const liveSyncRoom: LiveSyncRoomNamespace = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          nudges.push((await request.json()) as ClaxedoEvent)
          return Response.json({ delivered: 1, held: 1 })
        },
      }),
    }
    const executor = convex as unknown as {
      mutation: (fn: unknown, args: unknown) => Promise<unknown>
      query: (fn: unknown, args: unknown) => Promise<unknown>
    }
    const workgraph = createHostedWorkGraph({
      env: {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "stress-secret",
      },
      authConfig: {
        enabled: true,
        issuer: "https://clerk.test",
        jwksUrl: "https://clerk.test/jwks",
      },
      verifier: async () => ({
        mode: "signed",
        user: {
          subject: "stress-owner",
          tokenIdentifier: "issuer|stress-owner",
          issuer: "https://clerk.test",
          orgId: "clerk_org_stress",
        },
      }),
      authority: {
        usersMe: async () => ({ user_id: String(tenant.ownerUserId) }),
        resolveOrgId: async () => String(tenant.organizationId),
      } as unknown as WorkspaceAuthority,
      requestId: () => crypto.randomUUID(),
      liveSyncRoom,
      executor: {
        mutation: (fn, args) => executor.mutation(fn, args),
        query: (fn, args) => executor.query(fn, args),
      },
    })
    const started = performance.now()
    const responses = await Promise.all(
      Array.from({ length: hostedCommandCount }, (_, index) =>
        workgraph.router.request("/commands", {
          method: "POST",
          headers: { authorization: "Bearer stress-owner", "content-type": "application/json" },
          body: JSON.stringify({
            operationId: `stress-hosted-${index}`,
            command: { version: 1, type: "create_stream", title: `Stress Stream ${index}` },
          }),
        }),
      ),
    )
    const elapsed = performance.now() - started
    await expect.poll(() => nudges.length, { timeout: 30_000 }).toBe(hostedCommandCount)
    const cursors = nudges.flatMap((event) => (event.type === "workgraph.changed" ? [event.cursor] : []))
    const pass = responses.every((response) => response.status === 200) && cursors.length === hostedCommandCount && new Set(cursors).size === hostedCommandCount
    report.push(
      `| convex-test | ${hostedCommandCount} concurrent commands | n/a | n/a | ${round2(elapsed)}ms batch | ${cursors.length}/${hostedCommandCount} unique doorbells | ${pass ? "PASS" : "FAIL"} |`,
    )
    expect(pass).toBe(true)
  }, 120_000)

  test("hosted dirty recovery reads only three dirty tenants out of one thousand", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "stress-secret")
    const convex = convexTest({ schema, modules })
    await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "dirty-stress-owner",
        clerk_subject: "dirty-stress-owner",
        created_at: 1,
        updated_at: 1,
      })
      for (let index = 0; index < dirtyTenantCount; index += 1) {
        const organizationId = await ctx.db.insert("orgs", {
          name: `Dirty tenant ${index}`,
          kind: "personal",
          owner_user_id: ownerUserId,
          created_at: 1,
          updated_at: 1,
        })
        await ctx.db.insert("workgraph_dirty_events", {
          organization_id: organizationId,
          owner_user_id: ownerUserId,
          dirty_at: index + 1,
          dirty_token: `dirty-${index}`,
          ...(index < 3 ? {} : { drained_at: 2_000 }),
        })
      }
    })
    const started = performance.now()
    const dirty = await convex.query(api.workgraphRuntime.listDirtyTenants, {
      service_token: "stress-secret",
      limit: 500,
      before: 2_000,
    })
    const elapsed = performance.now() - started
    const pass = dirty.length === Math.min(3, dirtyTenantCount)
    report.push(
      `| convex-test dirty index | ${dirtyTenantCount} tenants / ${Math.min(3, dirtyTenantCount)} dirty | n/a | n/a | ${round2(elapsed)}ms | ${dirty.length} indexed reads | ${pass ? "PASS" : "FAIL"} |`,
    )
    expect(pass).toBe(true)
  }, 120_000)

  test.skipIf(!process.env.CLAXEDO_REAL_CONVEX_STRESS)("real Convex lane is opt-in through CLAXEDO_REAL_CONVEX_STRESS", () => {
    throw new Error("Set CLAXEDO_REAL_CONVEX_STRESS only in the deployment-backed driver")
  })
})

async function runSqliteLane(databasePath: string, p99GateMs: number) {
  const database = new BetterSqlite3(databasePath)
  try {
    const service = createSqliteWorkGraphService({ database }).service
    const samples: number[] = []
    for (let index = 0; index < sqliteCommandCount; index += 1) {
      const started = performance.now()
      const result = await service.execute(owner, {
        operationId: `stress-sqlite-${databasePath}-${index}` as OperationID,
        command: { version: 1, type: "create_stream", title: `Stress Stream ${index}` },
      })
      samples.push(performance.now() - started)
      if (!result.ok) throw new Error(`SQLite command ${index} failed: ${result.error.code}`)
    }
    const snapshotStarted = performance.now()
    let after: SnapshotResumeCursor | undefined
    let records = 0
    for (;;) {
      const page = await service.query(owner, "snapshot", "page", {
        limit: 500,
        ...(after ? { after } : {}),
      })
      records += page.records.filter((record) => record.recordType === "stream").length
      if (!page.hasMore) break
      after = page.nextCursor
    }
    const snapshotMs = performance.now() - snapshotStarted
    const delivered = new Set<string>()
    let cursor: ChangeCursor | undefined
    for (;;) {
      const changes = await service.query(owner, "changes", "list", {
        limit: 500,
        ...(cursor ? { after: cursor, deliveredEventIds: [...delivered].slice(-500) } : {}),
      })
      if (changes.length === 0) break
      changes.forEach((change) => {
        if (delivered.has(change.event.id)) throw new Error(`Duplicate change ${change.event.id}`)
        delivered.add(change.event.id)
      })
      cursor = changes.at(-1)!.cursor
    }
    const metrics = {
      p50: round2(percentile(samples, 50)),
      p95: round2(percentile(samples, 95)),
      p99: round2(percentile(samples, 99)),
    }
    const pass = metrics.p99 < p99GateMs && records === sqliteCommandCount && delivered.size === sqliteCommandCount
    report.push(
      `| SQLite ${databasePath === ":memory:" ? "memory" : "file"} | ${sqliteCommandCount} commands | ${metrics.p50}ms | ${metrics.p95}ms | ${metrics.p99}ms | ${delivered.size}/${sqliteCommandCount} changes; ${records} snapshot records in ${round2(snapshotMs)}ms | ${pass ? "PASS" : "FAIL"} |`,
    )
    return { ...metrics, records, changes: delivered.size, snapshotMs, pass }
  } finally {
    database.close()
  }
}

const owner = {
  organizationId: "stress-organization",
  ownerUserId: "stress-owner",
  actor: { type: "user", id: "stress-owner" },
  requestId: "stress-request",
  access: { mode: "owner" },
} as WorkGraphContext
