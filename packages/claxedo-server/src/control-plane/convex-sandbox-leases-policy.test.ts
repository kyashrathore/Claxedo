import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { acquire, get, list, normalizeLegacyFields, recordFailure, release, update } from "../../../../convex/sandboxLeases"

type Row = Record<string, unknown> & { _id: string; workspace_id: string; epoch: number; status: string; updated_at: number; retry_count: number }

const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
})

afterEach(() => {
  if (prevServiceToken === undefined) {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    return
  }
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
})

function fakeDb(seed: Row[] = []) {
  const rows = new Map(seed.map((row) => [row._id, { ...row }]))
  const byWorkspaceId = (workspaceId: string) => [...rows.values()].find((row) => row.workspace_id === workspaceId) ?? null
  return {
    rows,
    db: {
      query: vi.fn(() => ({
        withIndex: vi.fn((_name, build) => {
          const query = { eq: vi.fn((_field, value) => ({ value })) }
          const result = build(query)
          return {
            first: vi.fn(async () => byWorkspaceId(result.value)),
          }
        }),
        collect: vi.fn(async () => [...rows.values()]),
      })),
      insert: vi.fn(async (_table, value) => {
        const id = `lease_${rows.size + 1}`
        rows.set(id, { _id: id, ...value } as Row)
        return id
      }),
      patch: vi.fn(async (id, value) => {
        rows.set(id, { ...rows.get(id), ...value } as Row)
      }),
      replace: vi.fn(async (id, value) => {
        rows.set(id, { _id: id, ...value } as Row)
      }),
      delete: vi.fn(async (id) => {
        rows.delete(id)
      }),
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

function leaseRow(input: Partial<Row> = {}): Row {
  return {
    _id: "lease_1",
    workspace_id: "ws_1",
    home_region: "us-east",
    driver: "fetch",
    epoch: 1,
    status: "ready",
    retry_count: 0,
    created_at: 1_000,
    updated_at: 1_000,
    ...input,
  }
}

describe("Convex sandbox leases", () => {
  test("every sandbox lease function rejects a wrong service token", async () => {
    const { db } = fakeDb([leaseRow()])
    const wrong = { service_token: "wrong" }

    await expect(handler(acquire)({ db } as never, {
      ...wrong,
      workspace_id: "ws_1",
      home_region: "us-east",
      driver: "fetch",
      stale_after_ms: 60_000,
    } as never)).rejects.toThrow("Unauthenticated")
    await expect(handler(update)({ db } as never, {
      ...wrong,
      workspace_id: "ws_1",
      expected_epoch: 1,
      patch: { url: "https://attacker.test", host_id: "host_evil" },
    } as never)).rejects.toThrow("Unauthenticated")
    await expect(handler(recordFailure)({ db } as never, {
      ...wrong,
      workspace_id: "ws_1",
      expected_epoch: 1,
      error: "spoofed",
    } as never)).rejects.toThrow("Unauthenticated")
    await expect(handler(release)({ db } as never, { ...wrong, workspace_id: "ws_1" } as never)).rejects.toThrow("Unauthenticated")
    await expect(handler(get)({ db } as never, { ...wrong, workspace_id: "ws_1" } as never)).rejects.toThrow("Unauthenticated")
    await expect(handler(list)({ db } as never, wrong as never)).rejects.toThrow("Unauthenticated")
  })

  test("fails closed when the service token env var is unset, even for a matching empty token", async () => {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    const { db, rows } = fakeDb([leaseRow()])

    await expect(handler(get)({ db } as never, { service_token: "", workspace_id: "ws_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(handler(get)({ db } as never, { service_token: "svc_secret", workspace_id: "ws_1" } as never))
      .rejects.toThrow("Unauthenticated")
    await expect(handler(release)({ db } as never, { service_token: "", workspace_id: "ws_1" } as never))
      .rejects.toThrow("Unauthenticated")
    expect(rows.size).toBe(1)
  })

  test("fresh acquiring leases are not stolen", async () => {
    const { db } = fakeDb([leaseRow({ epoch: 2, status: "acquiring" })])

    await expect(handler(acquire)({ db } as never, {
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
    const { db } = fakeDb([leaseRow({ epoch: 2, status: "acquiring", retry_count: 1 })])

    await expect(handler(acquire)({ db } as never, {
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
    const { db, rows } = fakeDb()

    await expect(handler(acquire)({ db } as never, {
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

    expect(rows.get("lease_1")).toMatchObject({
      workspace_id: "ws_fresh",
      driver: "daytona",
      status: "acquiring",
    })
    expect(rows.get("lease_1")).not.toHaveProperty("provider")
    expect(rows.get("lease_1")).not.toHaveProperty("provider_runtime_id")
  })

  test("active acquire ignores legacy provider fields", async () => {
    const { db, rows } = fakeDb([leaseRow({
      driver: undefined,
      provider: "daytona",
      provider_runtime_id: "legacy-host-id",
      status: "stopped",
      sandbox_id: "legacy-sandbox-id",
      runtime_url: "https://legacy-host.test",
      host_id: "legacy-host-id",
      last_heartbeat_at: 3_000,
      last_activity_at: 4_000,
    })])

    await expect(handler(acquire)({ db } as never, {
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

    expect(rows.get("lease_1")).toMatchObject({
      driver: "modal",
    })
    expect(rows.get("lease_1")).not.toHaveProperty("driver_resource_id")
    expect(rows.get("lease_1")).not.toHaveProperty("provider")
    expect(rows.get("lease_1")).not.toHaveProperty("provider_runtime_id")
  })

  test("normalizes idle legacy rows before removing provider-era schema fields", async () => {
    const { db, rows } = fakeDb([
      leaseRow({
        driver: undefined,
        provider: "modal",
        provider_runtime_id: "legacy-modal-id",
      }),
      leaseRow({
        _id: "lease_2",
        workspace_id: "ws_2",
        driver: "daytona",
        driver_resource_id: "driver-resource-id",
      }),
    ])

    await expect(handler(normalizeLegacyFields)({ db } as never, {
      service_token: "svc_secret",
    } as never)).resolves.toEqual({ scanned: 2, updated: 1 })

    expect(rows.get("lease_1")).toMatchObject({
      driver: "modal",
      driver_resource_id: "legacy-modal-id",
    })
    expect(rows.get("lease_1")).not.toHaveProperty("provider")
    expect(rows.get("lease_1")).not.toHaveProperty("provider_runtime_id")
    expect(rows.get("lease_2")).toMatchObject({
      driver: "daytona",
      driver_resource_id: "driver-resource-id",
    })
  })

  test("epoch-fenced update and failure writes reject stale owners", async () => {
    const { db } = fakeDb([leaseRow({ epoch: 4, status: "acquiring" })])

    await expect(handler(update)({ db } as never, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      expected_epoch: 3,
      patch: { status: "ready", host_id: "host_1" },
    } as never)).resolves.toBeNull()
    await expect(handler(recordFailure)({ db } as never, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      expected_epoch: 3,
      error: "late write",
    } as never)).resolves.toBeNull()
  })

  test("update clears next_retry_at and last_error on explicit null and keeps them when absent", async () => {
    const { db, rows } = fakeDb([leaseRow({
      status: "acquiring",
      next_retry_at: 5_000,
      last_error: "boom",
    })])

    await expect(handler(update)({ db } as never, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      expected_epoch: 1,
      patch: { status: "acquiring" },
    } as never)).resolves.toMatchObject({ next_retry_at: 5_000, last_error: "boom" })
    expect(rows.get("lease_1")).toMatchObject({ next_retry_at: 5_000, last_error: "boom" })

    await expect(handler(update)({ db } as never, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
      expected_epoch: 1,
      patch: { status: "ready", next_retry_at: null, last_error: null },
    } as never)).resolves.toMatchObject({ status: "ready" })
    expect(rows.get("lease_1")!.next_retry_at).toBeUndefined()
    expect(rows.get("lease_1")!.last_error).toBeUndefined()
  })

  test("release deletes the lease and get observes the absence", async () => {
    const { db } = fakeDb([leaseRow()])

    await expect(handler(release)({ db } as never, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
    } as never)).resolves.toEqual({ released: true })
    await expect(handler(get)({ db } as never, {
      service_token: "svc_secret",
      workspace_id: "ws_1",
    } as never)).resolves.toBeNull()
  })
})
