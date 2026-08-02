import { afterEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { readChangeCursor } from "@claxedo/workgraph/contracts"
import { api } from "../../../../../convex/_generated/api"
import schema from "../../../../../convex/schema"
import { applyWorkGraphCommand } from "../../../../../convex/workgraphCommands"
import { readWorkGraphProjection } from "../../../../../convex/workgraphChanges"
import {
  deleteStreamGraphPage,
  WORKGRAPH_STREAM_DELETION_PAGE_SIZE,
} from "../../../../../convex/workgraphRuntime"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("../../../../../convex/**/*.ts")

afterEach(() => vi.unstubAllEnvs())

describe("Convex WorkGraph motion layer", () => {
  test("parallel stream mutations append independent dirty events without a shared OCC row", async () => {
    expect("workgraph_change_cursors" in schema.tables).toBe(false)

    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "motion-owner",
        clerk_subject: "motion-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Motion",
        kind: "personal",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      return { organizationId, ownerUserId }
    })
    const execute = (operationId: string, command: Record<string, unknown>) =>
      convex.run((ctx) => applyWorkGraphCommand(ctx, {
        organizationId: tenant.organizationId,
        ownerUserId: tenant.ownerUserId,
        ownerSubject: "motion-owner",
        actor: { type: "user", id: tenant.ownerUserId },
        requestId: operationId,
        operationId,
        command,
      }))
    const streams = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        execute(`create-${index}`, {
          version: 1,
          type: "create_stream",
          title: `Stream ${index}`,
        })),
    )
    await expect(Promise.all(streams.map((result, index) =>
      execute(`update-${index}`, {
        version: 1,
        type: "update_stream",
        streamId: result.value.streamId,
        expectedVersion: 1,
        title: `Updated ${index}`,
      }),
    ))).resolves.toEqual(expect.arrayContaining(
      Array.from({ length: 4 }, () => expect.objectContaining({ ok: true })),
    ))

    await expect(convex.run((ctx) =>
      ctx.db.query("workgraph_changes").collect(),
    )).resolves.toHaveLength(8)
    await expect(convex.run((ctx) =>
      ctx.db.query("workgraph_dirty_events").collect(),
    )).resolves.toHaveLength(8)
  })

  test("advances through 200 dense changes and delivers every event exactly once", async () => {
    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "dense-owner",
        clerk_subject: "dense-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Dense feed",
        kind: "personal",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      await ctx.db.insert("workgraphs", {
        organization_id: organizationId,
        owner_user_id: ownerUserId,
        id: "workgraph_default",
        defaults: {},
        provenance: { actor: { type: "system", id: "test" }, operationId: "setup" },
        row_version: 1,
        schema_version: 1,
        created_at: 1,
        updated_at: 1,
      })
      return { organizationId, ownerUserId }
    })
    await Promise.all(Array.from({ length: 200 }, (_, index) =>
      convex.run(async (ctx) => {
        await ctx.db.insert("workgraph_events", {
          organization_id: tenant.organizationId,
          owner_user_id: tenant.ownerUserId,
          id: `event-dense-${index}`,
          sequence: index + 1,
          operation_id: `dense-${index}`,
          request_id: `dense-${index}`,
          event_type: "stream_updated",
          actor_type: "system",
          actor_id: "test",
          payload: { index },
          occurred_at: Date.now(),
          schema_version: 1,
        })
        await ctx.db.insert("workgraph_changes", {
          organization_id: tenant.organizationId,
          owner_user_id: tenant.ownerUserId,
          id: `change-dense-${index}`,
          cursor: index + 1,
          operation_id: `dense-${index}`,
          event_id: `event-dense-${index}`,
          resource_type: "stream",
          resource_id: `stream-dense-${index}`,
          change_type: "stream_updated",
          payload: { index },
          snapshot_relevant: true,
          schema_version: 1,
          created_at: Date.now(),
        })
      }),
    ))

    const delivered = new Set<string>()
    let after: string | undefined
    for (;;) {
      const page = await convex.run((ctx) => readWorkGraphProjection(
        ctx,
        String(tenant.organizationId),
        String(tenant.ownerUserId),
        "changes",
        { limit: 17, ...(after ? { after, deliveredEventIds: [...delivered] } : {}) },
      )) as Array<{ cursor: string; event: { id: string } }>
      if (page.length === 0) break
      const previous = after
        ? readChangeCursor(after, String(tenant.organizationId), String(tenant.ownerUserId))
        : 0
      after = page.at(-1)!.cursor
      expect(readChangeCursor(after, String(tenant.organizationId), String(tenant.ownerUserId)))
        .toBeGreaterThan(previous)
      page.forEach((change) => {
        expect(delivered.has(change.event.id)).toBe(false)
        delivered.add(change.event.id)
      })
    }
    expect(delivered).toEqual(new Set(Array.from({ length: 200 }, (_, index) => `event-dense-${index}`)))
  })

  test("the recovery sweep reads only the dirty subset", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "dirty-secret")
    const convex = convexTest({ schema, modules })
    await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "dirty-owner",
        clerk_subject: "dirty-owner",
        created_at: 1,
        updated_at: 1,
      })
      await Promise.all(Array.from({ length: 1_000 }, async (_, index) => {
        const organizationId = await ctx.db.insert("orgs", {
          name: `Tenant ${index}`,
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
      }))
    })

    await expect(convex.query(api.workgraphRuntime.listDirtyTenants, {
      service_token: "dirty-secret",
      limit: 500,
      before: 2_000,
    })).resolves.toHaveLength(3)
  })

  test("acknowledging one dirty event leaves a later same-millisecond event pending", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "dirty-secret")
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
    const convex = convexTest({ schema, modules })
    try {
      const tenant = await convex.run(async (ctx) => {
        const ownerUserId = await ctx.db.insert("users", {
          token_identifier: "same-ms-owner",
          clerk_subject: "same-ms-owner",
          created_at: 1,
          updated_at: 1,
        })
        const organizationId = await ctx.db.insert("orgs", {
          name: "Same millisecond",
          kind: "personal",
          owner_user_id: ownerUserId,
          created_at: 1,
          updated_at: 1,
        })
        return { organizationId, ownerUserId }
      })
      const execute = (operationId: string, command: Record<string, unknown>) =>
        convex.run((ctx) => applyWorkGraphCommand(ctx, {
          organizationId: tenant.organizationId,
          ownerUserId: tenant.ownerUserId,
          ownerSubject: "same-ms-owner",
          actor: { type: "user", id: tenant.ownerUserId },
          requestId: operationId,
          operationId,
          command,
        }))
      const created = await execute("same-ms-create", {
        version: 1,
        type: "create_stream",
        title: "Before sweep",
      })
      const listed = await convex.query(api.workgraphRuntime.listDirtyTenants, {
        service_token: "dirty-secret",
        limit: 1,
        before: 1_000,
      })
      await execute("same-ms-update", {
        version: 1,
        type: "update_stream",
        streamId: created.value.streamId,
        expectedVersion: 1,
        title: "After sweep",
      })

      await expect(convex.mutation(api.workgraphRuntime.markTenantDrained, {
        service_token: "dirty-secret",
        organization_id: tenant.organizationId,
        owner_user_id: tenant.ownerUserId,
        dirty_token: listed[0]!.dirtyToken,
        drained_at: 1_001,
      })).resolves.toBe(true)
      const dirty = await convex.run((ctx) =>
        ctx.db.query("workgraph_dirty_events").collect())
      expect(dirty.find((event) => event.dirty_token === "same-ms-update")).toMatchObject({
        dirty_at: 1_000,
        dirty_token: "same-ms-update",
      })
      expect(dirty.find((event) => event.dirty_token === "same-ms-update")?.drained_at).toBeUndefined()
    } finally {
      clock.mockRestore()
    }
  })

  test("acknowledging a duplicate dirty token drains every matching event", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "dirty-secret")
    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "duplicate-token-owner",
        clerk_subject: "duplicate-token-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Duplicate token",
        kind: "personal",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      await Promise.all([1, 2].map((dirtyAt) => ctx.db.insert("workgraph_dirty_events", {
        organization_id: organizationId,
        owner_user_id: ownerUserId,
        dirty_at: dirtyAt,
        dirty_token: "duplicate-operation",
      })))
      return { organizationId, ownerUserId }
    })

    await expect(convex.mutation(api.workgraphRuntime.markTenantDrained, {
      service_token: "dirty-secret",
      organization_id: tenant.organizationId,
      owner_user_id: tenant.ownerUserId,
      dirty_token: "duplicate-operation",
      drained_at: 10,
    })).resolves.toBe(true)
    await expect(convex.run((ctx) => ctx.db.query("workgraph_dirty_events").collect()))
      .resolves.toEqual([
        expect.objectContaining({ dirty_token: "duplicate-operation", drained_at: 10 }),
        expect.objectContaining({ dirty_token: "duplicate-operation", drained_at: 10 }),
      ])
  })

  test("the recovery sweep compacts only drained dirty events past retention", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "dirty-secret")
    const convex = convexTest({ schema, modules })
    await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "prune-owner",
        clerk_subject: "prune-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Prune",
        kind: "personal",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      await Promise.all([
        ctx.db.insert("workgraph_dirty_events", {
          organization_id: organizationId,
          owner_user_id: ownerUserId,
          dirty_at: 1,
          dirty_token: "expired",
          drained_at: 2,
        }),
        ctx.db.insert("workgraph_dirty_events", {
          organization_id: organizationId,
          owner_user_id: ownerUserId,
          dirty_at: 1,
          dirty_token: "recent",
          drained_at: 20,
        }),
        ctx.db.insert("workgraph_dirty_events", {
          organization_id: organizationId,
          owner_user_id: ownerUserId,
          dirty_at: 1,
          dirty_token: "pending",
        }),
      ])
    })

    const target = await convex.run(async (ctx) => {
      const rows = await ctx.db.query("workgraph_dirty_events").collect()
      return rows.find((row) => row.dirty_token === "pending")!
    })
    await expect(convex.mutation(api.workgraphRuntime.markTenantDrained, {
      service_token: "dirty-secret",
      organization_id: target.organization_id,
      owner_user_id: target.owner_user_id,
      dirty_token: "pending",
      drained_at: 30,
      prune_before: 10,
      prune_limit: 500,
    })).resolves.toBe(true)
    await expect(convex.run((ctx) =>
      ctx.db.query("workgraph_dirty_events").collect().then((rows) => rows.map((row) => row.dirty_token).sort())))
      .resolves.toEqual(["pending", "recent"])
  })

  test("large Stream deletion drains bounded pages across repeated jobs", async () => {
    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const ownerUserId = await ctx.db.insert("users", {
        token_identifier: "delete-owner",
        clerk_subject: "delete-owner",
        created_at: 1,
        updated_at: 1,
      })
      const organizationId = await ctx.db.insert("orgs", {
        name: "Deletion",
        kind: "personal",
        owner_user_id: ownerUserId,
        created_at: 1,
        updated_at: 1,
      })
      await Promise.all(Array.from(
        { length: WORKGRAPH_STREAM_DELETION_PAGE_SIZE * 2 + 5 },
        (_, index) => ctx.db.insert("workgraph_leases", {
          organization_id: organizationId,
          owner_user_id: ownerUserId,
          id: `lease-${index}`,
          resource_type: "stream",
          resource_id: "stream-large",
          stream_id: "stream-large",
          holder_id: `holder-${index}`,
          epoch: 1,
          expires_at: 10,
          row_version: 1,
          schema_version: 1,
          created_at: 1,
          updated_at: 1,
        }),
      ))
      return { organizationId, ownerUserId }
    })

    const drain = () => convex.run((ctx) =>
      deleteStreamGraphPage(ctx, tenant.organizationId, tenant.ownerUserId, "stream-large"))
    expect([await drain(), await drain(), await drain(), await drain()])
      .toEqual([false, false, false, true])
    await expect(convex.run((ctx) => ctx.db.query("workgraph_leases").collect()))
      .resolves.toHaveLength(0)
  })
})
