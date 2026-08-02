import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1_000, updated_at: 1_000, ...row })

beforeEach(() => {
  vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "svc_secret")
})

afterEach(() => vi.unstubAllEnvs())

async function seedLease(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return t.run(async (ctx) => ctx.db.insert("runtime_leases", stamped({
    workspace_id: "ws_1",
    home_region: "us-east",
    driver: "fetch",
    epoch: 1,
    status: "ready",
    retry_count: 0,
    ...overrides,
  }) as never))
}

// D14 sandbox lease store policy: `serviceMutation`/`serviceQuery` wrap
// `requireControlPlaneService`, which is a shared-secret gate rather than an
// end-user identity — so every function here is called via `api.*` with an
// explicit `service_token` arg, not `t.withIdentity`.
//
// The previous version of this suite drove a hand-rolled `Map`-backed `db`
// double and reached past `serviceMutation`/`serviceQuery` into `_handler`,
// so it never exercised `requireControlPlaneService` itself or the real
// `by_workspace_id` index.
describe("Convex sandbox leases", () => {
  test("every sandbox lease function rejects a wrong service token", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t)
    const wrong = { service_token: "wrong" }

    await expect(t.mutation(api.sandboxLeases.acquire, {
      ...wrong,
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "fetch",
      stale_after_ms: 60_000,
    } as never)).rejects.toThrow("Unauthenticated")
    await expect(t.mutation(api.sandboxLeases.update, {
      ...wrong,
      workspace_id: "ws_1",
      expected_epoch: 1,
      patch: { url: "https://attacker.test", host_id: "host_evil" },
    } as never)).rejects.toThrow("Unauthenticated")
    await expect(t.mutation(api.sandboxLeases.recordFailure, {
      ...wrong,
      workspace_id: "ws_1",
      expected_epoch: 1,
      error: "spoofed",
    } as never)).rejects.toThrow("Unauthenticated")
    await expect(t.mutation(api.sandboxLeases.release, { ...wrong, workspace_id: "ws_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(t.query(api.sandboxLeases.get, { ...wrong, workspace_id: "ws_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(t.query(api.sandboxLeases.list, wrong as never)).rejects.toThrow("Unauthenticated")
  })

  test("fails closed when the service token env var is unset, even for a matching empty token", async () => {
    vi.unstubAllEnvs()
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    const t = convexTest(schema, modules)
    await seedLease(t)

    await expect(t.query(api.sandboxLeases.get, { service_token: "", workspace_id: "ws_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(t.query(api.sandboxLeases.get, { service_token: "svc_secret", workspace_id: "ws_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(t.mutation(api.sandboxLeases.release, { service_token: "", workspace_id: "ws_1" } as never))
      .rejects.toThrow("Unauthenticated")

    const remaining = await t.run(async (ctx) => ctx.db.query("runtime_leases").collect())
    expect(remaining).toHaveLength(1)
  })

  test("fresh acquiring leases are not stolen", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { epoch: 2, status: "acquiring" })

    await expect(t.mutation(api.sandboxLeases.acquire, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "fetch",
      stale_after_ms: 60_000,
      now: 2_000,
    } as never)).resolves.toMatchObject({
      acquired: false,
      retry_after_ms: 59_000,
      lease: { epoch: 2 },
    })
  })

  test("stale acquiring leases get a new epoch", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { epoch: 2, status: "acquiring", retry_count: 1 })

    await expect(t.mutation(api.sandboxLeases.acquire, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "fetch",
      stale_after_ms: 60_000,
      now: 70_000,
    } as never)).resolves.toMatchObject({
      acquired: true,
      lease: { epoch: 3, status: "acquiring" },
    })
  })

  test("fresh acquire writes canonical driver fields without provider-era aliases", async () => {
    const t = convexTest(schema, modules)

    await expect(t.mutation(api.sandboxLeases.acquire, {
      service_token: "svc_secret",
      workspace_id: "ws_fresh",
      home_region: "us-east",
      driver: "daytona",
      stale_after_ms: 60_000,
      now: 10_000,
    } as never)).resolves.toMatchObject({
      acquired: true,
      lease: { workspace_id: "ws_fresh", driver: "daytona", epoch: 1 },
    })

    const row = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_fresh")).first())
    expect(row).toMatchObject({
      workspace_id: "ws_fresh",
      driver: "daytona",
      status: "acquiring",
    })
    expect(row).not.toHaveProperty("provider")
    expect(row).not.toHaveProperty("provider_runtime_id")
  })

  test("active acquire ignores legacy provider fields", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, {
      driver: undefined,
      provider: "daytona",
      provider_runtime_id: "legacy-host-id",
      status: "stopped",
      sandbox_id: "legacy-sandbox-id",
      runtime_url: "https://legacy-host.test",
      host_id: "legacy-host-id",
      last_heartbeat_at: 3_000,
      last_activity_at: 4_000,
    })

    await expect(t.mutation(api.sandboxLeases.acquire, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "modal",
      stale_after_ms: 60_000,
      now: 70_000,
    } as never)).resolves.toMatchObject({
      acquired: true,
      lease: {
        driver: "modal",
        sandbox_id: "legacy-sandbox-id",
        url: "https://legacy-host.test",
        host_id: "legacy-host-id",
      },
    })

    const row = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).first())
    expect(row).toMatchObject({ driver: "modal" })
    expect(row).not.toHaveProperty("driver_resource_id")
    expect(row).not.toHaveProperty("provider")
    expect(row).not.toHaveProperty("provider_runtime_id")
  })

  test("normalizes idle legacy rows before removing provider-era schema fields", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, {
      driver: undefined,
      provider: "modal",
      provider_runtime_id: "legacy-modal-id",
    })
    await seedLease(t, {
      workspace_id: "ws_2",
      driver: "daytona",
      driver_resource_id: "driver-resource-id",
    })

    await expect(t.mutation(api.sandboxLeases.normalizeLegacyFields, {
      service_token: "svc_secret",
    } as never)).resolves.toEqual({ scanned: 2, updated: 1 })

    const row1 = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).first())
    expect(row1).toMatchObject({
      driver: "modal",
      driver_resource_id: "legacy-modal-id",
    })
    expect(row1).not.toHaveProperty("provider")
    expect(row1).not.toHaveProperty("provider_runtime_id")

    const row2 = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_2")).first())
    expect(row2).toMatchObject({
      driver: "daytona",
      driver_resource_id: "driver-resource-id",
    })
  })

  test("epoch-fenced update and failure writes reject stale owners", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, { epoch: 4, status: "acquiring" })

    await expect(t.mutation(api.sandboxLeases.update, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      expected_epoch: 3,
      patch: { status: "ready", host_id: "host_1" },
    } as never)).resolves.toBeNull()
    await expect(t.mutation(api.sandboxLeases.recordFailure, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      expected_epoch: 3,
      error: "late write",
    } as never)).resolves.toBeNull()
  })

  test("update clears next_retry_at and last_error on explicit null and keeps them when absent", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t, {
      status: "acquiring",
      next_retry_at: 5_000,
      last_error: "boom",
    })

    await expect(t.mutation(api.sandboxLeases.update, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      expected_epoch: 1,
      patch: { status: "acquiring" },
    } as never)).resolves.toMatchObject({ next_retry_at: 5_000, last_error: "boom" })
    let row = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).first())
    expect(row).toMatchObject({ next_retry_at: 5_000, last_error: "boom" })

    await expect(t.mutation(api.sandboxLeases.update, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      expected_epoch: 1,
      patch: { status: "ready", next_retry_at: null, last_error: null },
    } as never)).resolves.toMatchObject({ status: "ready" })
    row = await t.run(async (ctx) =>
      ctx.db.query("runtime_leases").withIndex("by_workspace_id", (q) => q.eq("workspace_id", "ws_1")).first())
    expect(row!.next_retry_at).toBeUndefined()
    expect(row!.last_error).toBeUndefined()
  })

  test("release deletes the lease and get observes the absence", async () => {
    const t = convexTest(schema, modules)
    await seedLease(t)

    await expect(t.mutation(api.sandboxLeases.release, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
    } as never)).resolves.toEqual({ released: true, usage: null })
    await expect(t.query(api.sandboxLeases.get, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
    } as never)).resolves.toBeNull()
  })
})
