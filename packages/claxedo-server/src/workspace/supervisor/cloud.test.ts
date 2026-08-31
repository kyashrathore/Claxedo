/**
 * Tests for workspace-supervisor lifecycle management.
 *
 * Covers:
 * - State transitions (stopped → starting → ready → stopped)
 * - Sandbox start/stop
 * - Sandbox reuse on wake (cached sandbox reference survives stop)
 * - Idle shutdown scheduling
 * - Hold/release ref counting
 * - Concurrent start deduplication
 * - Error handling and backoff
 * - Expected wake behavior: sandbox.start() for stopped Daytona sandboxes
 */

import { describe, expect, test, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { SandboxHoldRow, SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"
import { claxedoBus, type ClaxedoEvent } from "@claxedo/server-core/platform/runtime/lib/bus"

let driverId = "daytona"
const previousRelayHostPublicKey = process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK
const previousRuntimePrivateKey = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM
const previousRuntimePublicKey = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
let runtimePrivateKeyPem = ""
let runtimePublicKeyPem = ""

// ── Helpers ──────────────────────────────────────────────────────────────

function captureProvisionEvents() {
  const events: ClaxedoEvent[] = []
  const unsub = claxedoBus.subscribe((e) => {
    if (e.type === "provision") events.push(e)
  })
  return { events, cleanup: unsub }
}

// ── Shared mock state ────────────────────────────────────────────────────

const snapshots: any[] = []
const store = new Map<string, any>()

function workspace(id: string) {
  return {
    id,
    project_id: "proj-1",
    directory: "/workspace",
    kind: "cloud" as const,
    driver: driverId as any,
    repo_url: "https://github.com/test/repo.git",
    remote_directory: "/workspace",
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

const mockGetWorkspace = vi.fn((id: string) => Promise.resolve(store.get(id) ?? workspace(id)))
const mockUpdateWorkspace = vi.fn((id: string, patch: Record<string, unknown>) => {
  const next = {
    ...(store.get(id) ?? workspace(id)),
    ...patch,
    updated_at: Date.now(),
  }
  store.set(id, next)
  return Promise.resolve(next)
})

const mockSandboxDriverAuthAsync: any = vi.fn(async (..._args: unknown[]) => undefined)
const sandboxBootEnvCalls: Array<{ driver: string; hostId: string; env: Record<string, string> }> = []
const mockDaytonaLaunch = vi.fn(async (input: any) => ({
  workspaceId: input.workspaceId,
  sandboxId: "daytona-sdk-sb",
  url: "https://daytona-sdk.example.com",
  hostId: input.hostId ?? "daytona-sdk-host",
  driverResourceId: "daytona-sdk-sb",
  driver: { id: "daytona", resourceId: "daytona-sdk-sb" },
  labels: input.labels,
}))
const mockCloudflareLaunch = vi.fn(async (input: any) => ({
  workspaceId: input.workspaceId,
  sandboxId: "claxedo-cloudflare-sb",
  url: "https://cloudflare-sdk.example.com",
  hostId: input.hostId ?? "claxedo-cloudflare-sb",
  driverResourceId: "claxedo-cloudflare-sb",
  driver: { id: "cloudflare", resourceId: "claxedo-cloudflare-sb" },
  labels: input.labels,
}))
const mockModalLaunch = vi.fn(async (input: any) => ({
  workspaceId: input.workspaceId,
  sandboxId: "modal-sdk-sb",
  url: "https://modal-sdk.example.com",
  hostId: input.hostId ?? "modal-sdk-host",
  driverResourceId: "modal-sdk-sb",
  driver: { id: "modal", resourceId: "modal-sdk-sb" },
  labels: input.labels,
}))
const mockVercelLaunch = vi.fn(async (input: any) => ({
  workspaceId: input.workspaceId,
  sandboxId: "vercel-sdk-sb",
  url: "https://vercel-sdk.example.com",
  hostId: input.hostId ?? "vercel-sdk-host",
  driverResourceId: "vercel-sdk-sb",
  driver: { id: "vercel", resourceId: "vercel-sdk-sb" },
  labels: input.labels,
}))
const mockDockerLaunch = vi.fn(async (input: any) => ({
  workspaceId: input.workspaceId,
  sandboxId: "docker-sdk-sb",
  url: "http://127.0.0.1:5330",
  hostId: input.hostId ?? "docker-sdk-host",
  driverResourceId: "docker-sdk-sb",
  driver: { id: "docker", resourceId: "docker-sdk-sb" },
  labels: input.labels,
}))
const mockBoxLaunch = vi.fn(async (input: any) => ({
  workspaceId: input.workspaceId,
  sandboxId: "bx_test01",
  url: "https://sub-2593.on.ascii.dev?_token=t",
  hostId: input.hostId ?? "box-sdk-host",
  driverResourceId: "bx_test01",
  driver: { id: "box", resourceId: "bx_test01" },
  labels: input.labels,
}))
const mockVercelSnapshot = vi.fn(async () => ({ snapshotId: "snap-stop-1" }))

async function captureRuntimeEnv(driver: string, options: any, input: any, hostId: string) {
  const env = await options.env?.(input, { id: hostId })
  sandboxBootEnvCalls.push({ driver, hostId, env: env ?? {} })
}

function latestSandboxBootEnv(driverId?: string) {
  const calls = driverId ? sandboxBootEnvCalls.filter((item) => item.driver === driverId) : sandboxBootEnvCalls
  return calls.at(-1)?.env ?? {}
}

const mockNoCapturePersistence = {
  resume: "same-sandbox",
  capture: "none",
  clone: false,
  captureSource: "not-applicable",
  retention: "provider-managed",
  restoreMount: "same-resource",
} as const

const mockCreateDaytonaSandboxDriver = vi.fn((options: any) => ({
  id: "daytona",
  metadata: {
    driverRunsIn: ["worker", "node"],
    hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
    targetAccess: "relay",
    persistence: mockNoCapturePersistence,
  },
  ensureHost: async (input: any) => {
    await captureRuntimeEnv("daytona", options, input, "daytona-sdk-sb")
    return mockDaytonaLaunch(input)
  },
  resumeHost: async (input: any) => mockDaytonaLaunch(input.ensure),
  stop: vi.fn(async () => {}),
  suspend: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}))
const mockCreateCloudflareSandboxDriver = vi.fn((options: any) => ({
  id: "cloudflare",
  metadata: {
    driverRunsIn: ["worker"],
    hostStopBehavior: "not-supported", hostResumeBehavior: "same-host",
    targetAccess: "relay",
    persistence: mockNoCapturePersistence,
  },
  ensureHost: async (input: any) => {
    await captureRuntimeEnv("cloudflare", options, input, "claxedo-cloudflare-sb")
    return mockCloudflareLaunch(input)
  },
  resumeHost: async (input: any) => mockCloudflareLaunch(input.ensure),
  touch: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}))
const mockCreateModalSandboxDriver = vi.fn((options: any) => ({
  id: "modal",
  metadata: {
    driverRunsIn: ["node"],
    hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
    targetAccess: "relay",
    persistence: mockNoCapturePersistence,
  },
  ensureHost: async (input: any) => {
    await captureRuntimeEnv("modal", options, input, "modal-sdk-host")
    return mockModalLaunch(input)
  },
  resumeHost: async (input: any) => mockModalLaunch(input.ensure),
  stop: vi.fn(async () => {}),
  suspend: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}))
const mockCreateVercelSandboxDriver = vi.fn((options: any) => ({
  id: "vercel",
  metadata: {
    driverRunsIn: ["node"],
    hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
    targetAccess: "relay",
    persistence: {
      resume: "replacement-restore",
      capture: "filesystem",
      clone: false,
      captureSource: "stopped",
      retention: "explicit",
      restoreMount: "new-resource",
    },
  },
  ensureHost: async (input: any) => {
    await captureRuntimeEnv("vercel", options, input, "vercel-sdk-host")
    return mockVercelLaunch(input)
  },
  resumeHost: async (input: any) => mockVercelLaunch(input.ensure),
  stop: vi.fn(async () => {}),
  suspend: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  snapshot: mockVercelSnapshot,
}))
const mockCreateBoxSandboxDriver = vi.fn((options: any) => ({
  id: "box",
  metadata: {
    driverRunsIn: ["node"],
    hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
    targetAccess: "relay",
    persistence: mockNoCapturePersistence,
  },
  ensureHost: async (input: any) => {
    await captureRuntimeEnv("box", options, input, "box-sdk-host")
    return mockBoxLaunch(input)
  },
  resumeHost: async (input: any) => mockBoxLaunch(input.ensure),
  touch: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  suspend: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}))
const mockCreateDockerSandboxDriver = vi.fn((options: any) => ({
  id: "docker",
  metadata: {
    driverRunsIn: ["local"],
    hostStopBehavior: "terminates-host", hostResumeBehavior: "same-host",
    targetAccess: "loopback",
    persistence: mockNoCapturePersistence,
  },
  ensureHost: async (input: any) => {
    await captureRuntimeEnv("docker", options, input, "docker-sdk-sb")
    return mockDockerLaunch(input)
  },
  resumeHost: async (input: any) => mockDockerLaunch(input.ensure),
  stop: vi.fn(async () => {}),
  suspend: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
}))

const mockLoadUserConfig = vi.fn(() => Promise.resolve({ mcp: {}, auth: {} }))
const mockGetRuntimeConfigSnapshot = vi.fn(
  async (): Promise<any> => ({
    version: 2,
    mcp: {},
    auth: {},
    runners: [{ type: "opencode" }],
    commands: [],
  }),
)

const leases = new Map<string, SandboxLeaseRow>()
const holds = new Map<string, SandboxHoldRow>()

function workspaceHolds(workspaceId: string) {
  return [...holds.values()].filter((hold) => hold.workspace_id === workspaceId)
}

function lease(workspaceId: string, driverId = "daytona"): SandboxLeaseRow {
  const ts = Date.now()
  return {
    workspace_id: workspaceId,
    lease_id: `lease-${workspaceId}`,
    epoch: 1,
    status: "pending",
    driver: driverId as SandboxLeaseRow["driver"],
    driver_resource_id: null,
    driver_snapshot_id: null,
    sandbox_id: null,
    url: null,
    retry_count: 0,
    next_retry_at: null,
    last_heartbeat_at: null,
    last_activity_at: null,
    last_health_failure_at: null,
    last_error: null,
    compute_class: null,
    accel_base_image_id: null,
    accel_prepared_image_id: null,
    accel_snapshot_id: null,
    checkpoint: null,
    persistence: null,
    restore: null,
    created_at: ts,
    updated_at: ts,
  }
}

// ── Module mocks (must be before import) ─────────────────────────────────

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  getWorkspace: (...args: unknown[]) => (mockGetWorkspace as any)(...args),
  updateWorkspace: (...args: unknown[]) => (mockUpdateWorkspace as any)(...args),
  // The supervisor composition teaches the store to read sandbox leases.
  configureWorkspaceStore: vi.fn(),
}))

vi.mock("@claxedo/server-core/sandbox/network/policy", () => ({
  listPolicies: vi.fn(() => []),
}))

vi.mock("../../sandbox/network/resolve", () => ({
  resolveSandboxNetworkPolicy: vi.fn(() => Promise.resolve(undefined)),
}))

vi.mock("../../sandbox/stores/sqlite-supervisor-state", () => {
  const status = (input: SandboxLeaseRow["status"]) => {
    if (input === "ready" || input === "stopped") return input
    if (input === "backoff" || input === "failed" || input === "unhealthy") return "unavailable"
    return "acquiring"
  }
  const toSandboxLease = (input: SandboxLeaseRow) => ({
    workspaceId: input.workspace_id,
    homeRegion: input.home_region ?? "us-east",
    driver: input.driver,
    epoch: input.epoch,
    status: status(input.status),
    retryCount: input.retry_count,
    createdAt: input.created_at,
    updatedAt: input.updated_at,
    sandboxId: input.sandbox_id ?? undefined,
    url: input.url ?? undefined,
    hostId: input.lease_id,
    driverResourceId: input.driver_resource_id ?? undefined,
    nextRetryAt: input.next_retry_at ?? undefined,
    lastError: input.last_error ?? undefined,
    lastHeartbeatAt: input.last_heartbeat_at ?? undefined,
    lastActivityAt: input.last_activity_at ?? undefined,
    labels: input.labels ?? undefined,
    checkpoint: input.checkpoint ?? undefined,
    persistence: input.persistence ?? undefined,
    restore: input.restore ?? undefined,
  })
  const updateSupervisorSandboxLease = (workspaceId: string, patch: Partial<SandboxLeaseRow>) => {
    const prev = leases.get(workspaceId)
    if (!prev) return
    const next = { ...prev, ...patch, updated_at: Date.now() }
    leases.set(workspaceId, next)
    return next
  }
  const recordSupervisorSandboxLeaseFailure = (workspaceId: string, error: string, nextRetryAt: number | null) => {
    const prev = leases.get(workspaceId)
    if (!prev) return
    return updateSupervisorSandboxLease(workspaceId, {
      status: nextRetryAt ? ("backoff" as const) : ("failed" as const),
      retry_count: prev.retry_count + 1,
      next_retry_at: nextRetryAt,
      last_error: error,
      last_health_failure_at: Date.now(),
    })
  }
  return {
    getSupervisorSandboxLease: (workspaceId: string) => leases.get(workspaceId),
    listSupervisorSandboxLeases: () => [...leases.values()],
    sandboxLeaseUrl: (input: SandboxLeaseRow | undefined) => input?.url ?? undefined,
    sandboxLeaseStatus: status,
    sandboxLeaseFromRow: toSandboxLease,
    sandboxTargetFromLease: (input: SandboxLeaseRow | undefined) => {
      const sandboxId = input?.sandbox_id ?? input?.driver_resource_id
      const hostId = input?.lease_id || sandboxId
      if (!input?.url || !sandboxId || !hostId) return
      return {
        workspaceId: input.workspace_id,
        sandboxId,
        url: input.url,
        hostId,
        driverResourceId: input.driver_resource_id ?? sandboxId,
        driver: {
          id: input.driver,
          resourceId: input.driver_resource_id ?? sandboxId,
        },
      }
    },
    pendingSandboxLease: (workspaceId: string, driver: SandboxLeaseRow["driver"], timestamp = Date.now()) => ({
      ...lease(workspaceId, driver),
      created_at: timestamp,
      updated_at: timestamp,
    }),
    updateSupervisorSandboxLease,
    releaseSupervisorSandboxLease: (workspaceId: string) => {
      const had = leases.has(workspaceId)
      leases.delete(workspaceId)
      for (const hold of [...holds.values()]) {
        if (hold.workspace_id !== workspaceId) continue
        holds.delete(hold.hold_id)
      }
      return had
    },
    acquireSupervisorSandboxHold: (
      workspaceId: string,
      ownerType: SandboxHoldRow["owner_type"],
      ownerId: string,
      reason: string,
      expiresAt?: number,
    ) => {
      const hold = {
        hold_id: `hold-${workspaceId}-${holds.size + 1}`,
        workspace_id: workspaceId,
        owner_type: ownerType,
        owner_id: ownerId,
        reason,
        expires_at: expiresAt ?? null,
        updated_at: Date.now(),
      } satisfies SandboxHoldRow
      holds.set(hold.hold_id, hold)
      return hold
    },
    releaseSupervisorSandboxHold: (holdId: string) => {
      holds.delete(holdId)
    },
    cleanExpiredSupervisorSandboxHolds: (workspaceId: string) => {
      let count = 0
      for (const hold of holds.values()) {
        if (hold.workspace_id !== workspaceId) continue
        if (!hold.expires_at || hold.expires_at > Date.now()) continue
        holds.delete(hold.hold_id)
        count += 1
      }
      return count
    },
    markSupervisorSandboxLeaseFailed: (workspaceId: string, error: string) => {
      const lease = updateSupervisorSandboxLease(workspaceId, {
        status: "failed",
        last_error: error,
        next_retry_at: null,
      })
      return lease ? { ok: true, lease } : { ok: false, error: "workspace not found" }
    },
    recordSupervisorSandboxStartFailure: (workspaceId: string, error: string) => {
      const lease = recordSupervisorSandboxLeaseFailure(workspaceId, error, Date.now() + 1_000)
      return lease ? { ok: true, lease } : { ok: false, error: "workspace not found" }
    },
    recordSupervisorSandboxLeaseReady: (input: {
      workspaceId: string
      driver: SandboxLeaseRow["driver"]
      sandboxId?: string | null
      url: string
      driverResourceId?: string | null
    }) => {
      const ts = Date.now()
      const prev = leases.get(input.workspaceId) ?? lease(input.workspaceId, input.driver)
      const next = {
        ...prev,
        status: "ready" as const,
        sandbox_id: input.sandboxId ?? prev.sandbox_id,
        driver_resource_id: input.driverResourceId ?? prev.driver_resource_id,
        url: input.url,
        retry_count: 0,
        next_retry_at: null,
        last_error: null,
        last_heartbeat_at: ts,
        last_activity_at: ts,
        updated_at: ts,
      }
      leases.set(input.workspaceId, next)
      return next
    },
    createSupervisorSandboxLeaseStore: () => ({
      async acquire(workspaceId: string, input: any) {
        const current = leases.get(workspaceId)
        const currentLease = current ? toSandboxLease(current) : undefined
        const now = input.now ?? Date.now()
        if (currentLease?.status === "ready") return { acquired: false, lease: currentLease, retryAfterMs: 0 }
        if (currentLease?.status === "acquiring" && now - currentLease.updatedAt < input.staleAfterMs) {
          return {
            acquired: false,
            lease: currentLease,
            retryAfterMs: Math.max(0, input.staleAfterMs - (now - currentLease.updatedAt)),
          }
        }
        const resumable = currentLease?.status === "stopped"
        const next = {
          ...(current ?? lease(workspaceId, input.driver)),
          epoch: (current?.epoch ?? 0) + 1,
          status: "acquiring" as const,
          driver: current?.driver ?? input.driver,
          sandbox_id: resumable ? (current?.sandbox_id ?? null) : null,
          url: resumable ? (current?.url ?? null) : null,
          driver_resource_id: resumable ? (current?.driver_resource_id ?? null) : null,
          retry_count: current?.retry_count ?? 0,
          next_retry_at: null,
          last_error: null,
          updated_at: now,
        }
        leases.set(workspaceId, next)
        return { acquired: true, lease: toSandboxLease(next) }
      },
      async update(workspaceId: string, expectedEpoch: number, patch: any) {
        const current = leases.get(workspaceId)
        if (!current || current.epoch !== expectedEpoch) return
        const next = {
          ...current,
          ...(patch.status === "ready" ? { status: "ready" as const } : {}),
          ...(patch.status === "stopped" ? { status: "stopped" as const } : {}),
          ...(patch.status === "acquiring" ? { status: "acquiring" as const } : {}),
          ...(patch.status === "unavailable"
            ? { status: patch.nextRetryAt === undefined ? ("failed" as const) : ("backoff" as const) }
            : {}),
          ...(patch.sandboxId === undefined ? {} : { sandbox_id: patch.sandboxId ?? null }),
          ...(patch.url === undefined ? {} : { url: patch.url ?? null }),
          ...(patch.hostId === undefined ? {} : { lease_id: patch.hostId ?? current.lease_id }),
          ...(patch.driverResourceId === undefined ? {} : { driver_resource_id: patch.driverResourceId ?? null }),
          ...(patch.retryCount === undefined ? {} : { retry_count: patch.retryCount }),
          ...(patch.nextRetryAt === undefined ? {} : { next_retry_at: patch.nextRetryAt ?? null }),
          ...(patch.lastError === undefined ? {} : { last_error: patch.lastError ?? null }),
          ...(patch.lastHeartbeatAt === undefined ? {} : { last_heartbeat_at: patch.lastHeartbeatAt }),
          ...(patch.lastActivityAt === undefined ? {} : { last_activity_at: patch.lastActivityAt }),
          ...(patch.labels === undefined ? {} : { labels: patch.labels ?? null }),
          ...(patch.checkpoint === undefined ? {} : { checkpoint: patch.checkpoint ?? null }),
          ...(patch.persistence === undefined ? {} : { persistence: patch.persistence ?? null }),
          ...(patch.restore === undefined ? {} : { restore: patch.restore ?? null }),
          updated_at: Date.now(),
        }
        leases.set(workspaceId, next)
        return toSandboxLease(next)
      },
      async recordFailure(workspaceId: string, expectedEpoch: number, error: string, nextRetryAt?: number) {
        const current = leases.get(workspaceId)
        if (!current || current.epoch !== expectedEpoch) return
        const next = recordSupervisorSandboxLeaseFailure(workspaceId, error, nextRetryAt ?? null)
        return next ? toSandboxLease(next) : undefined
      },
      async release(workspaceId: string) {
        leases.delete(workspaceId)
      },
      async get(workspaceId: string) {
        const current = leases.get(workspaceId)
        return current ? toSandboxLease(current) : undefined
      },
      async list() {
        return [...leases.values()].map(toSandboxLease)
      },
    }),
  }
})

vi.mock("../../sandbox/driver-auth", () => ({
  sandboxDriverAuthAsync: (...args: unknown[]) => (mockSandboxDriverAuthAsync as any)(...args),
}))

vi.mock("@claxedo/sandbox-manager/drivers/daytona", () => ({
  createDaytonaSandboxDriver: (...args: unknown[]) => (mockCreateDaytonaSandboxDriver as any)(...args),
}))

vi.mock("@claxedo/sandbox-manager/drivers/box", () => ({
  createBoxSandboxDriver: (...args: unknown[]) => (mockCreateBoxSandboxDriver as any)(...args),
}))

vi.mock("@claxedo/sandbox-manager/drivers/cloudflare", () => ({
  createCloudflareSandboxDriver: (...args: unknown[]) => (mockCreateCloudflareSandboxDriver as any)(...args),
}))

vi.mock("@claxedo/sandbox-manager/drivers/modal", () => ({
  createModalSandboxDriver: (...args: unknown[]) => (mockCreateModalSandboxDriver as any)(...args),
}))

vi.mock("@claxedo/sandbox-manager/drivers/vercel", () => ({
  createVercelSandboxDriver: (...args: unknown[]) => (mockCreateVercelSandboxDriver as any)(...args),
}))

vi.mock("@claxedo/sandbox-manager/drivers/docker", () => ({
  createDockerSandboxDriver: (...args: unknown[]) => (mockCreateDockerSandboxDriver as any)(...args),
}))

vi.mock("@claxedo/server-core/agent-config/index", () => ({
  loadUserConfig: (...args: unknown[]) => (mockLoadUserConfig as any)(...args),
  sandboxDriverConfig: vi.fn((config?: { sandbox_driver?: unknown }) => config?.sandbox_driver ?? {}),
  defaultHarness: vi.fn(() => ({})),
  getRuntimeConfigSnapshot: (...args: unknown[]) => (mockGetRuntimeConfigSnapshot as any)(...args),
}))

vi.mock("./prepared-image.sql", () => ({
  ClaxedoPreparedImageTable: {},
  ClaxedoRuntimeSnapshotTable: {},
  getPreparedImage: vi.fn(() => undefined),
  getLatestPreparedImage: vi.fn(() => undefined),
  listPreparedImages: vi.fn(() => []),
  upsertPreparedImage: vi.fn(),
  deletePreparedImage: vi.fn(),
  getSnapshot: vi.fn(() => undefined),
  getLatestSnapshot: vi.fn(() => undefined),
  listSnapshots: vi.fn(() => []),
  insertSnapshot: vi.fn((row: any) => snapshots.push(row)),
  updateSnapshotStatus: vi.fn(),
  deleteSnapshot: vi.fn(),
  deleteSnapshotsByWorkspace: vi.fn(),
}))

// Mock fs for runtime bundle reads
vi.mock("fs", () => {
  const actual = require("node:fs")
  const readFileSync = vi.fn((file: string | URL | Buffer) => {
    const name = String(file)
    if (name.endsWith("package.json")) return Buffer.from(JSON.stringify({ version: "0.4.4" }))
    return Buffer.from("// mock runtime")
  })
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync,
      existsSync: vi.fn(() => true),
    },
    readFileSync,
    existsSync: vi.fn(() => true),
  }
})

// Mock fetch for health checks + config push
globalThis.fetch = vi.fn((url: string | URL | Request) => {
  const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : ((url as any).url ?? "")
  if (u.includes("/api/wr/health") || u.includes("/global/health")) {
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  }
  if (u.includes("/api/wr/config")) {
    return Promise.resolve(new Response("{}", { status: 200 }))
  }
  // SSE streams — return response that completes immediately
  return Promise.resolve(new Response("data: {}\n\n", { status: 200 }))
}) as any

// ── Import module under test (after mocks) ───────────────────────────────

const supervisor = await import("./index")
const testSupervisor = await import("./test-helper")

// ── Tests ────────────────────────────────────────────────────────────────

describe("workspace-supervisor", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    runtimePrivateKeyPem = await exportPKCS8(pair.privateKey)
    runtimePublicKeyPem = await exportSPKI(pair.publicKey)
  })

  beforeEach(() => {
    leases.clear()
    holds.clear()
    snapshots.length = 0
    store.clear()
    sandboxBootEnvCalls.length = 0
    driverId = "daytona"
    mockSandboxDriverAuthAsync.mockClear()
    mockSandboxDriverAuthAsync.mockImplementation(async (_cfg: unknown, id: string) => {
      if (id === "daytona") return { api_key: "dtn-default" }
      if (id === "cloudflare") return { api_token: "cf-default", worker_url: "https://worker.example.com" }
      if (id === "modal") return { token_id: "modal-default-id", token_secret: "modal-default-secret" }
      if (id === "vercel") return { access_token: "vercel-default", team_id: "team_1", project_id: "project_1" }
      if (id === "docker") return { image: "claxedo-sandbox:test" }
      if (id === "box") return { api_key: "bx-default" }
    })
    mockDaytonaLaunch.mockClear()
    mockCloudflareLaunch.mockClear()
    mockModalLaunch.mockClear()
    mockVercelLaunch.mockClear()
    mockDockerLaunch.mockClear()
    mockBoxLaunch.mockClear()
    mockVercelSnapshot.mockClear()
    mockCreateDaytonaSandboxDriver.mockClear()
    mockCreateCloudflareSandboxDriver.mockClear()
    mockCreateModalSandboxDriver.mockClear()
    mockCreateVercelSandboxDriver.mockClear()
    mockCreateDockerSandboxDriver.mockClear()
    mockCreateBoxSandboxDriver.mockClear()
    mockGetRuntimeConfigSnapshot.mockClear()
    mockGetRuntimeConfigSnapshot.mockImplementation(
      async (): Promise<any> => ({
        version: 2,
        mcp: {},
        auth: {},
        runners: [{ type: "opencode" }],
        commands: [],
      }),
    )
    mockUpdateWorkspace.mockClear()
    mockGetWorkspace.mockImplementation((id: string) => Promise.resolve(store.get(id) ?? workspace(id)))
    ;(globalThis.fetch as any).mockClear()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = runtimePrivateKeyPem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = runtimePublicKeyPem

    supervisor.configureWorkspaceSupervisor({
      server_url: "http://localhost:3000",
      relay_url: "https://relay.example.test",
    })
  })

  afterEach(async () => {
    await supervisor.shutdownWorkspaceSupervisor()
    if (previousRelayHostPublicKey === undefined) delete process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK
    else process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK = previousRelayHostPublicKey
    if (previousRuntimePrivateKey === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM
    else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = previousRuntimePrivateKey
    if (previousRuntimePublicKey === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = previousRuntimePublicKey
  })

  // ── ensureSupervisorSandbox ─────────────────────────────────────────

  describe("ensureSupervisorSandbox", () => {
    test("throws when workspace not found", async () => {
      mockGetWorkspace.mockImplementationOnce(() => Promise.resolve(undefined as any))

      await expect(supervisor.ensureSupervisorSandbox("nonexistent")).rejects.toThrow("workspace not found")
    })

    test("creates runtime for cloud workspace", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-new-1")

      expect(entry.status).toBe("ready")
      expect(entry.url).toBeTruthy()
      expect(entry.remote).toBe(true)
      expect(mockUpdateWorkspace).toHaveBeenCalledWith(
        "ws-new-1",
        expect.objectContaining({
          status: "acquiring_sandbox",
        }),
      )
      expect(mockUpdateWorkspace).toHaveBeenCalledWith(
        "ws-new-1",
        expect.objectContaining({
          status: "ready",
        }),
      )
      expect(supervisor.getSandboxLease("ws-new-1")?.sandbox_id).toBe("daytona-sdk-sb")
    })

    test("exposes the supervisor as the local SandboxManager", async () => {
      const manager = supervisor.createWorkspaceSupervisorSandboxManager()

      const ensured = await manager.ensure("ws-manager-1", { homeRegion: "us-east" })
      const target = await manager.target("ws-manager-1")

      expect(ensured).toMatchObject({
        status: "ready",
        workspaceId: "ws-manager-1",
        sandboxId: "daytona-sdk-sb",
        url: "https://daytona-sdk.example.com",
      })
      expect(target).toMatchObject({
        status: "ready",
        workspaceId: "ws-manager-1",
        sandboxId: "daytona-sdk-sb",
      })
      expect(target.status === "ready" && ensured.status === "ready" ? target.hostId === ensured.hostId : false).toBe(
        true,
      )
      expect((await manager.list()).find((lease) => lease.workspaceId === "ws-manager-1")).toMatchObject({
        status: "ready",
        driver: "daytona",
      })
    })

    test("local SandboxManager honors relay tunnel host identity", async () => {
      const manager = supervisor.createWorkspaceSupervisorSandboxManager()

      const ensured = await manager.ensure("ws-manager-relay-host", {
        homeRegion: "us-east",
        hostId: "host_link_1",
      })
      const target = await manager.target("ws-manager-relay-host")

      expect(ensured).toMatchObject({
        status: "ready",
        hostId: "host_link_1",
      })
      expect(target).toMatchObject({
        status: "ready",
        hostId: "host_link_1",
      })
    })

    test("uses direct Daytona SDK sandbox driver when Daytona auth is configured", async () => {
      mockSandboxDriverAuthAsync.mockImplementation(async () => ({ api_key: "dtn-key" }))

      const entry = await supervisor.ensureSupervisorSandbox("ws-daytona-sdk")

      expect(entry.status).toBe("ready")
      expect(entry.url).toBe("https://daytona-sdk.example.com")
      expect(mockCreateDaytonaSandboxDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "dtn-key",
          baseSnapshot: expect.any(String),
        }),
      )
      expect(mockDaytonaLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-daytona-sdk",
          source: { kind: "git", repoUrl: "https://github.com/test/repo.git", branch: undefined },
        }),
      )
    })

    test("passes resolved Daytona network policy CIDRs into SandboxManager", async () => {
      const policy = await import("@claxedo/server-core/sandbox/network/policy")
      const resolve = await import("../../sandbox/network/resolve")
      ;(policy.listPolicies as any).mockReturnValueOnce([
        { target: "api.example.test", kind: "host" },
      ])
      ;(resolve.resolveSandboxNetworkPolicy as any).mockResolvedValueOnce({
        mode: "restricted",
        hosts: ["api.example.test"],
        cidrs: ["203.0.113.10/32"],
      })

      await supervisor.ensureSupervisorSandbox("ws-daytona-network")

      expect(resolve.resolveSandboxNetworkPolicy).toHaveBeenCalledWith(
        [{ target: "api.example.test", kind: "host" }],
        "http://localhost:3000",
      )
      expect(mockDaytonaLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-daytona-network",
          net: {
            mode: "restricted",
            hosts: ["api.example.test"],
            cidrs: ["203.0.113.10/32"],
          },
        }),
      )
    })

    test("uses direct Cloudflare sandbox driver when Cloudflare auth is configured", async () => {
      driverId = "cloudflare"
      mockSandboxDriverAuthAsync.mockImplementation(async (_cfg: unknown, id: string) =>
        id === "cloudflare" ? { api_token: "cf-token", worker_url: "https://worker.example.com" } : undefined,
      )

      const entry = await supervisor.ensureSupervisorSandbox("ws-cloudflare-direct")

      expect(entry.status).toBe("ready")
      expect(entry.url).toBe("https://cloudflare-sdk.example.com")
      expect(mockCreateCloudflareSandboxDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          apiToken: "cf-token",
          workerUrl: "https://worker.example.com",
        }),
      )
      expect(mockCloudflareLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-cloudflare-direct",
          source: { kind: "git", repoUrl: "https://github.com/test/repo.git", branch: undefined },
        }),
      )
    })

    test("uses direct Modal sandbox driver when Modal auth is configured", async () => {
      driverId = "modal"
      mockSandboxDriverAuthAsync.mockImplementation(async (_cfg: unknown, id: string) =>
        id === "modal" ? { token_id: "modal-token-id", token_secret: "modal-token-secret" } : undefined,
      )

      const entry = await supervisor.ensureSupervisorSandbox("ws-modal-direct")

      expect(entry.status).toBe("ready")
      expect(entry.url).toBe("https://modal-sdk.example.com")
      expect(mockCreateModalSandboxDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenId: "modal-token-id",
          tokenSecret: "modal-token-secret",
        }),
      )
      expect(mockModalLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-modal-direct",
          source: { kind: "git", repoUrl: "https://github.com/test/repo.git", branch: undefined },
        }),
      )
    })

    test("uses direct Vercel sandbox driver when Vercel auth is configured", async () => {
      driverId = "vercel"
      mockSandboxDriverAuthAsync.mockImplementation(async (_cfg: unknown, id: string) =>
        id === "vercel" ? { access_token: "vercel-token", team_id: "team_1", project_id: "project_1" } : undefined,
      )

      const entry = await supervisor.ensureSupervisorSandbox("ws-vercel-direct")

      expect(entry.status).toBe("ready")
      expect(entry.url).toBe("https://vercel-sdk.example.com")
      expect(mockCreateVercelSandboxDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "vercel-token",
          teamId: "team_1",
          projectId: "project_1",
        }),
      )
      expect(mockVercelLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-vercel-direct",
          source: { kind: "git", repoUrl: "https://github.com/test/repo.git", branch: undefined },
        }),
      )
    })

    test("fails clearly when selected driver has no direct sandbox driver credentials", async () => {
      driverId = "modal"
      mockSandboxDriverAuthAsync.mockImplementation(async () => undefined)

      await expect(supervisor.ensureSupervisorSandbox("ws-missing-driver-auth")).rejects.toThrow(
        "Sandbox driver modal is not configured; missing token_id and token_secret",
      )
    })

    test("attaches to canonical ready sandbox lease before provisioning a new sandbox", async () => {
      leases.set("ws-existing-url", {
        ...lease("ws-existing-url"),
        status: "ready",
        sandbox_id: "daytona-existing-sb",
        driver_resource_id: "daytona-existing-sb",
        url: "http://existing-runtime.test",
      })
      store.set("ws-existing-url", {
        ...workspace("ws-existing-url"),
        status: "ready",
      })

      const entry = await supervisor.ensureSupervisorSandbox("ws-existing-url")

      expect(entry.status).toBe("ready")
      expect(entry.remote).toBe(true)
      expect(entry.url).toBe("http://existing-runtime.test")
      expect(entry.sandbox_target?.sandboxId).toBe("daytona-existing-sb")
      expect(entry.sandbox_target?.hostId).toBe("lease-ws-existing-url")
      expect(entry.sandbox_target?.driverResourceId).toBe("daytona-existing-sb")
      expect(mockDaytonaLaunch).not.toHaveBeenCalled()
      expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws-existing-url", {
        status: "ready",
      })
      expect(leases.get("ws-existing-url")?.url).toBe("http://existing-runtime.test")
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://existing-runtime.test/global/health",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      )
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://existing-runtime.test/api/wr/config",
        expect.objectContaining({
          method: "POST",
        }),
      )
    })

    test("provisions a fresh sandbox when there is no canonical sandbox lease", async () => {
      store.set("ws-stale-row-url", {
        ...workspace("ws-stale-row-url"),
        status: "ready",
      })

      const entry = await supervisor.ensureSupervisorSandbox("ws-stale-row-url")

      expect(entry.status).toBe("ready")
      expect(entry.url).toBe("https://daytona-sdk.example.com")
      expect(mockDaytonaLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-stale-row-url",
        }),
      )
      expect(mockUpdateWorkspace).toHaveBeenCalledWith(
        "ws-stale-row-url",
        expect.objectContaining({
          status: "ready",
        }),
      )
      expect(leases.get("ws-stale-row-url")?.url).toBe("https://daytona-sdk.example.com")
    })

    test("local SandboxManager target keeps lease host id separate from sandbox resource id", async () => {
      leases.set("ws-host-identity", {
        ...lease("ws-host-identity"),
        lease_id: "sandbox-manager-ws-host-identity",
        status: "ready",
        sandbox_id: "sandbox-resource-1",
        driver_resource_id: "driver-resource-1",
        url: "http://sandbox-manager-identity.test",
      })
      store.set("ws-host-identity", {
        ...workspace("ws-host-identity"),
        status: "ready",
      })

      const manager = supervisor.createWorkspaceSupervisorSandboxManager()
      const target = await manager.target("ws-host-identity")

      expect(target).toMatchObject({
        status: "ready",
        sandboxId: "sandbox-resource-1",
        hostId: "sandbox-manager-ws-host-identity",
        driverResourceId: "driver-resource-1",
      })
    })

    test("binds relay-protected sandbox access to one host id through the manager", async () => {
      const manager = supervisor.createWorkspaceSupervisorSandboxManager()

      await expect(
        manager.ensure("ws-relay-host-binding", { homeRegion: "us-east", hostId: "host_a" }),
      ).resolves.toMatchObject({
        status: "ready",
        url: "https://daytona-sdk.example.com",
        hostId: "host_a",
      })
      await expect(
        manager.ensure("ws-relay-host-binding", { homeRegion: "us-east", hostId: "host_a" }),
      ).resolves.toMatchObject({
        status: "ready",
        url: "https://daytona-sdk.example.com",
        hostId: "host_a",
      })
      await expect(
        manager.ensure("ws-relay-host-binding", { homeRegion: "us-east", hostId: "host_b" }),
      ).resolves.toMatchObject({
        status: "unavailable",
        error: "sandbox mismatch: ws-relay-host-binding",
      })
    })

    test("pushes MCP, auth, and slash commands to the cloud runtime", async () => {
      mockGetRuntimeConfigSnapshot.mockImplementationOnce(() =>
        Promise.resolve({
          version: 2,
          mcp: {
            "local-tool": {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
          auth: {
            "claude-acp": "sk-ant-runtime",
          },
          runners: [{ type: "claude-acp", binary: "/bin/claude-agent-acp" }],
          commands: [
            {
              name: "triage",
              content: "Triage the current issue.",
            },
          ],
        }),
      )

      await supervisor.ensureSupervisorSandbox("ws-config-push")

      const call = (globalThis.fetch as any).mock.calls.find((item: unknown[]) =>
        String(item[0]).includes("/api/wr/config"),
      )
      expect(call).toBeTruthy()
      expect(call[1].headers["x-workspace-runtime-management-token"]).toMatch(/^[^.]+\.[^.]+\.[^.]+$/)
      expect(call[1].headers.Authorization).toMatch(/^Bearer [0-9a-f-]+$/)
      expect(call[1].headers["X-Claxedo-Runtime-Config-Token"]).toMatch(/^[0-9a-f-]+$/)
      expect(JSON.parse(call[1].body)).toEqual({
        version: 2,
        mcp: {
          "local-tool": {
            type: "stdio",
            command: "node",
            args: ["server.js"],
          },
        },
        auth: {
          "claude-acp": "sk-ant-runtime",
        },
        runners: [{ type: "claude-acp", binary: "/bin/claude-agent-acp" }],
        commands: [
          {
            name: "triage",
            content: "Triage the current issue.",
          },
        ],
      })
    })

    test("cloud runtime config uses shared credentials and workspace identity", async () => {
      store.set("ws-hosted-config", {
        ...workspace("ws-hosted-config"),
        remote_directory: "/remote/app",
      })

      await supervisor.ensureSupervisorSandbox("ws-hosted-config")

      expect(mockGetRuntimeConfigSnapshot).toHaveBeenCalledWith(undefined, {
        secretScope: "shared",
        workspaceDir: "/remote/app",
        workspaceId: "ws-hosted-config",
      })
      const env = latestSandboxBootEnv("daytona")
      expect(env.WORKSPACE_RUNTIME_CONFIG_TOKEN).toBeTruthy()
      expect(env.WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN).toBeTruthy()
      expect(env.WORKSPACE_RUNTIME_HOST_ID).toBe("daytona-sdk-sb")
      expect(env.WORKSPACE_RUNTIME_RELAY_JWKS_URL).toBe("https://relay.example.test/.well-known/jwks.json")
      // The signer now refuses to mint without a published public key, so the
      // local-control-plane PEM branch is the only reachable state here.
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM).toBe(runtimePublicKeyPem)
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL).toBeUndefined()
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_ISSUER).toBe("claxedo-control-plane")
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE).toBe("supervisor-backplane")
      expect(env.CLAXEDO_RELAY_JWKS_URL).toBeUndefined()
    })

    test("daytona runtime uses public PEM for local management verification", async () => {
      process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = runtimePublicKeyPem
      store.set("ws-local-control-plane", {
        ...workspace("ws-local-control-plane"),
        remote_directory: "/remote/app",
      })

      await supervisor.ensureSupervisorSandbox("ws-local-control-plane")

      const env = latestSandboxBootEnv("daytona")
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM).toBeTruthy()
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL).toBeUndefined()
    })

    test("local managed cloud runtime can start direct unsigned without relay auth", async () => {
      supervisor.configureWorkspaceSupervisor({
        server_url: "http://localhost:3000",
      })

      await supervisor.ensureSupervisorSandbox("ws-missing-relay-auth")

      const env = latestSandboxBootEnv("daytona")
      expect(env.WORKSPACE_RUNTIME_HOST).toBe("0.0.0.0")
      expect(env.WORKSPACE_RUNTIME_ALLOW_UNAUTHENTICATED_NON_LOOPBACK).toBe("1")
      expect(env.CLAXEDO_RELAY_JWKS_URL).toBeUndefined()
    })

    test("non-local managed cloud runtime fails closed when relay auth verification cannot be provisioned", async () => {
      supervisor.configureWorkspaceSupervisor({
        server_url: "https://control.example.test",
      })

      await expect(supervisor.ensureSupervisorSandbox("ws-missing-relay-auth")).rejects.toThrow(
        "managed cloud VM runtime requires relay_url to configure relay-host auth",
      )
    })

    test("docker runtime gets a host-reachable control plane URL", async () => {
      driverId = "docker"
      mockSandboxDriverAuthAsync.mockImplementation(async (_cfg: unknown, id: string) =>
        id === "docker" ? { image: "claxedo-sandbox:test" } : undefined,
      )
      store.set("ws-docker-control-plane", {
        ...workspace("ws-docker-control-plane"),
        driver: "docker",
      })

      await supervisor.ensureSupervisorSandbox("ws-docker-control-plane")

      expect(mockCreateDockerSandboxDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "claxedo-sandbox:test",
        }),
      )
      const env = latestSandboxBootEnv("docker")
      expect(env.CLAXEDO_CONTROL_PLANE_URL).toBeUndefined()
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL).toBe("http://host.docker.internal:3000/.well-known/jwks.json")
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_ISSUER).toBe("claxedo-control-plane")
      expect(env.WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE).toBe("supervisor-backplane")
      expect(env.WORKSPACE_RUNTIME_HOST_ID).toBe("docker-sdk-sb")
      expect(env.WORKSPACE_RUNTIME_RELAY_JWKS_URL).toBe("https://relay.example.test/.well-known/jwks.json")
      expect(env.CLAXEDO_RELAY_JWKS_URL).toBeUndefined()
    })

    test("returns existing ready runtime without restarting", async () => {
      await supervisor.ensureSupervisorSandbox("ws-reuse-1")
      const callsBefore = mockDaytonaLaunch.mock.calls.length

      const entry2 = await supervisor.ensureSupervisorSandbox("ws-reuse-1")
      expect(entry2.status).toBe("ready")

      expect(mockDaytonaLaunch.mock.calls.length).toBe(callsBefore)
    })

    test("updates used_at on each call", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-time-1")
      const firstUsed = entry.used_at

      await new Promise((r) => setTimeout(r, 10))
      await supervisor.ensureSupervisorSandbox("ws-time-1")

      expect(entry.used_at).toBeGreaterThanOrEqual(firstUsed)
    })
  })

  test("discardSupervisorSandbox drops the lease and cached runtime", async () => {
    await supervisor.ensureSupervisorSandbox("ws-discard-1")

    expect(supervisor.getSandboxLease("ws-discard-1")).toBeDefined()

    await supervisor.discardSupervisorSandbox("ws-discard-1", "provision_failed")

    expect(supervisor.getSandboxLease("ws-discard-1")).toBeUndefined()
    expect(supervisor.getSupervisorSandboxTarget("ws-discard-1")).toBeUndefined()
  })

  // ── State transitions ──────────────────────────────────────────────

  describe("sandbox state transitions", () => {
    test("transitions: stopped → starting → ready", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-states-1")

      expect(entry.status).toBe("ready")
      expect(entry.started_at).toBeGreaterThan(0)
      expect(entry.crashes).toBe(0)
      expect(entry.retry_at).toBe(0)
    })

    test("launches the direct sandbox driver when no cached target exists", async () => {
      await supervisor.ensureSupervisorSandbox("ws-pool-1")

      expect(mockDaytonaLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-pool-1",
        }),
      )
    })

    test("emits acquiring_sandbox as first event", async () => {
      const tracker = captureProvisionEvents()

      await supervisor.ensureSupervisorSandbox("ws-events-1")

      const steps = tracker.events
        .filter(
          (e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
            e.type === "provision" && (e as any).workspaceId === "ws-events-1",
        )
        .map((e) => e.step)

      expect(steps[0]).toBe("acquiring_sandbox")
      tracker.cleanup()
    })

    test("full provision event sequence for fresh deploy", async () => {
      const tracker = captureProvisionEvents()

      await supervisor.ensureSupervisorSandbox("ws-full-1")

      const steps = tracker.events
        .filter(
          (e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
            e.type === "provision" && (e as any).workspaceId === "ws-full-1",
        )
        .map((e) => e.step)

      // `starting_runtime` marks the driver handing back a live sandbox URL —
      // the one post-acquire transition the supervisor can observe (the clone
      // and boot happen inside the driver's sandbox, invisible from here).
      expect(steps).toEqual(["acquiring_sandbox", "starting_runtime", "ready"])

      tracker.cleanup()
    })

    test("warm provision event sequence (both exist)", async () => {
      const tracker = captureProvisionEvents()

      await supervisor.ensureSupervisorSandbox("ws-warm-1")

      const steps = tracker.events
        .filter(
          (e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
            e.type === "provision" && (e as any).workspaceId === "ws-warm-1",
        )
        .map((e) => e.step)

      // No cloning event when the workspace filesystem is already present.
      expect(steps).toContain("acquiring_sandbox")
      expect(steps).toContain("ready")

      tracker.cleanup()
    })

    test("restores a workspace from runtime snapshot when the driver supports it", async () => {
      driverId = "vercel"
      leases.set("ws-snap-1", {
        ...lease("ws-snap-1", "vercel"),
        status: "stopped",
        accel_snapshot_id: "snap-1",
      })

      await supervisor.ensureSupervisorSandbox("ws-snap-1")

      expect(mockVercelLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-snap-1",
          bootSource: { kind: "driver-snapshot", snapshotId: "snap-1" },
        }),
      )
    })

    test("starts from a prepared image when the driver supports it", async () => {
      driverId = "modal"
      leases.set("ws-img-1", {
        ...lease("ws-img-1", "modal"),
        status: "stopped",
        accel_prepared_image_id: "img-1",
      })

      await supervisor.ensureSupervisorSandbox("ws-img-1")

      expect(mockModalLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-img-1",
          bootSource: { kind: "image", image: "img-1" },
        }),
      )
    })
  })

  // ── Sandbox reuse on wake ──────────────────────────────────────────

  describe("sandbox reuse after stop (wake path)", () => {
    test("sandbox target is cleared from memory on stop while lease keeps sandbox id", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-wake-1")
      expect(entry.sandbox_target?.sandboxId).toBe("daytona-sdk-sb")

      await supervisor.stopSupervisorSandbox("ws-wake-1", "test")

      expect(entry.status).toBe("stopped")
      expect(entry.url).toBeUndefined()
      expect(entry.sandbox_target).toBeUndefined()
      expect(supervisor.getSandboxLease("ws-wake-1")?.sandbox_id).toBe("daytona-sdk-sb")
    })

    test("resumes same-resource driver through the direct sandbox driver", async () => {
      await supervisor.ensureSupervisorSandbox("ws-wake-2")
      const callsBefore = mockDaytonaLaunch.mock.calls.length

      await supervisor.stopSupervisorSandbox("ws-wake-2", "test")

      const entry = await supervisor.ensureSupervisorSandbox("ws-wake-2")
      expect(entry.status).toBe("ready")

      expect(mockDaytonaLaunch.mock.calls.length).toBe(callsBefore + 1)
    })

    test("uses persisted lease sandbox id when restarting a same-resource driver", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-wake-reattach-1")
      await supervisor.stopSupervisorSandbox("ws-wake-reattach-1", "test")

      entry.sandbox_id = undefined

      await supervisor.ensureSupervisorSandbox("ws-wake-reattach-1")

      expect(mockDaytonaLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-wake-reattach-1",
        }),
      )
      expect(supervisor.getSupervisorSandboxTarget("ws-wake-reattach-1")?.sandboxId).toBe("daytona-sdk-sb")
    })

    test("wake emits acquire and ready when resuming the direct host", async () => {
      await supervisor.ensureSupervisorSandbox("ws-wake-3")
      await supervisor.stopSupervisorSandbox("ws-wake-3", "test")

      const tracker = captureProvisionEvents()

      await supervisor.ensureSupervisorSandbox("ws-wake-3")

      const steps = tracker.events
        .filter(
          (e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
            e.type === "provision" && (e as any).workspaceId === "ws-wake-3",
        )
        .map((e) => e.step)

      // `starting_runtime` marks the driver handing back a live sandbox URL —
      // the one post-acquire transition the supervisor can observe (the clone
      // and boot happen inside the driver's sandbox, invisible from here).
      expect(steps).toEqual(["acquiring_sandbox", "starting_runtime", "ready"])

      tracker.cleanup()
    })
  })

  // ── stopSupervisorSandbox ────────────────────────────────────

  describe("stopSupervisorSandbox", () => {
    test("stops sandbox through the sandbox manager", async () => {
      await supervisor.ensureSupervisorSandbox("ws-stop-1")

      await supervisor.stopSupervisorSandbox("ws-stop-1", "test")

      expect(store.get("ws-stop-1")?.status).toBe("stopped")
    })

    test("sets status to stopped and clears url", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-stop-2")
      expect(entry.status).toBe("ready")
      expect(entry.url).toBeTruthy()

      await supervisor.stopSupervisorSandbox("ws-stop-2", "test")

      expect(entry.status).toBe("stopped")
      expect(entry.url).toBeUndefined()
      expect(entry.port).toBeUndefined()
      expect(store.get("ws-stop-2")?.status).toBe("stopped")
    })

    test("no-op for unknown workspaceId", async () => {
      await supervisor.stopSupervisorSandbox("nonexistent", "test")
    })

    test("clears health monitor on stop", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-stop-hm")

      await supervisor.stopSupervisorSandbox("ws-stop-hm", "test")

      expect(entry.health_monitor).toBeUndefined()
    })

    test("uses the canonical freeze, scrub, and provider checkpoint flow before idle stop", async () => {
      driverId = "vercel"

      await supervisor.ensureSupervisorSandbox("ws-stop-snap")
      await supervisor.stopSupervisorSandbox("ws-stop-snap", "idle")

      expect(mockVercelSnapshot).toHaveBeenCalled()
      expect(supervisor.getSandboxLease("ws-stop-snap")?.checkpoint).toMatchObject({
        providerReference: "snap-stop-1",
        sourceEpoch: 1,
      })
      expect((globalThis.fetch as any).mock.calls.map((call: unknown[]) => String(call[0]))).toEqual(expect.arrayContaining([
        expect.stringContaining("/api/wr/checkpoint/freeze"),
        expect.stringContaining("/api/wr/checkpoint/flush"),
        expect.stringContaining("/api/wr/checkpoint/scrub"),
      ]))
      expect(supervisor.getSupervisorSandboxTarget("ws-stop-snap")).toBeUndefined()
    })
  })

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    test("transitions to backoff on direct sandbox driver ensureHost failure", async () => {
      mockDaytonaLaunch.mockImplementationOnce(() => Promise.reject(new Error("driver exhausted")))

      const tracker = captureProvisionEvents()

      await expect(supervisor.ensureSupervisorSandbox("ws-err-1")).rejects.toThrow("driver exhausted")

      const errorEvents = tracker.events.filter(
        (e): e is Extract<ClaxedoEvent, { type: "provision" }> => e.type === "provision" && (e as any).step === "error",
      )
      expect(errorEvents.length).toBeGreaterThanOrEqual(1)

      tracker.cleanup()
    })

    test("error event includes message", async () => {
      mockDaytonaLaunch.mockImplementationOnce(() => Promise.reject(new Error("no sandboxes available")))

      const tracker = captureProvisionEvents()

      await expect(supervisor.ensureSupervisorSandbox("ws-err-msg")).rejects.toThrow()

      const errorEvent = tracker.events.find(
        (e): e is Extract<ClaxedoEvent, { type: "provision" }> => e.type === "provision" && (e as any).step === "error",
      ) as any
      expect(errorEvent).toBeTruthy()
      expect(errorEvent.message).toContain("no sandboxes available")

      tracker.cleanup()
    })
  })

  // ── Concurrent start deduplication ─────────────────────────────────

  describe("concurrent start deduplication", () => {
    test("concurrent calls return the same promise", async () => {
      const p1 = supervisor.ensureSupervisorSandbox("ws-dedup-1")
      const p2 = supervisor.ensureSupervisorSandbox("ws-dedup-1")

      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1).toBe(r2)
      expect(r1.status).toBe("ready")

      const launchCalls = (mockDaytonaLaunch.mock.calls as any[][]).filter((c) => c[0]?.workspaceId === "ws-dedup-1")
      expect(launchCalls.length).toBe(1)
    })
  })

  // ── Hold / Release ─────────────────────────────────────────────────

  describe("holdSupervisorSandbox / releaseSupervisorSandbox", () => {
    test("no-op for unknown workspace", () => {
      supervisor.holdSupervisorSandbox("ws-hold-unknown")
      // Should not throw
    })

    test("increments and decrements active count", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-hold-2")

      supervisor.holdSupervisorSandbox("ws-hold-2")
      expect(entry.active).toBe(1)

      supervisor.holdSupervisorSandbox("ws-hold-2")
      expect(entry.active).toBe(2)

      supervisor.releaseSupervisorSandbox("ws-hold-2")
      expect(entry.active).toBe(1)

      supervisor.releaseSupervisorSandbox("ws-hold-2")
      expect(entry.active).toBe(0)
    })

    test("releases durable hold rows with runtime holds", async () => {
      await supervisor.ensureSupervisorSandbox("ws-hold-durable-1")

      supervisor.holdSupervisorSandbox("ws-hold-durable-1")
      supervisor.holdSupervisorSandbox("ws-hold-durable-1")
      expect(workspaceHolds("ws-hold-durable-1")).toHaveLength(2)

      supervisor.releaseSupervisorSandbox("ws-hold-durable-1")
      expect(workspaceHolds("ws-hold-durable-1")).toHaveLength(1)

      supervisor.releaseSupervisorSandbox("ws-hold-durable-1")
      expect(workspaceHolds("ws-hold-durable-1")).toHaveLength(0)
    })

    test("release does not go below 0", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-hold-3")

      supervisor.releaseSupervisorSandbox("ws-hold-3")
      supervisor.releaseSupervisorSandbox("ws-hold-3")

      expect(entry.active).toBe(0)
    })
  })

  // ── listSupervisorSandboxs ──────────────────────────────────────────

  describe("listSupervisorSandboxs", () => {
    test("lists ready runtimes", async () => {
      await supervisor.ensureSupervisorSandbox("ws-list-1")

      const list = supervisor.listSupervisorSandboxs()
      const found = list.find((r) => r.workspaceId === "ws-list-1")

      expect(found).toBeTruthy()
      expect(found!.status).toBe("ready")
      expect(found!.url).toBeTruthy()
    })

    test("does not list stopped runtimes", async () => {
      await supervisor.ensureSupervisorSandbox("ws-list-2")
      await supervisor.stopSupervisorSandbox("ws-list-2", "test")

      const list = supervisor.listSupervisorSandboxs()
      const found = list.find((r) => r.workspaceId === "ws-list-2")

      expect(found).toBeUndefined()
    })
  })

  // ── sandbox targets ───────────────────────────────────────────

  describe("getSupervisorSandboxTarget", () => {
    test("returns sandbox target for active direct sandbox", async () => {
      await supervisor.ensureSupervisorSandbox("ws-sandbox-1")

      const target = supervisor.getSupervisorSandboxTarget("ws-sandbox-1")
      expect(target?.sandboxId).toBe("daytona-sdk-sb")
    })

    test("returns undefined for unknown workspace", () => {
      expect(supervisor.getSupervisorSandboxTarget("nonexistent")).toBeUndefined()
    })

    test("target is cleared after stop", async () => {
      await supervisor.ensureSupervisorSandbox("ws-sandbox-2")
      await supervisor.stopSupervisorSandbox("ws-sandbox-2", "test")

      const target = supervisor.getSupervisorSandboxTarget("ws-sandbox-2")
      expect(target).toBeUndefined()
    })
  })

  // ── markSupervisorSandboxUse ─────────────────────────────────────────────────

  describe("markSupervisorSandboxUse", () => {
    test("updates used_at timestamp", async () => {
      const entry = await supervisor.ensureSupervisorSandbox("ws-mark-1")
      const before = entry.used_at

      await new Promise((r) => setTimeout(r, 10))
      supervisor.markSupervisorSandboxUse("ws-mark-1")

      expect(entry.used_at).toBeGreaterThanOrEqual(before)
    })

    test("no-op for unknown workspace", () => {
      supervisor.markSupervisorSandboxUse("nonexistent")
    })
  })

  // ── syncSupervisorSandbox ────────────────────────────────────

  describe("syncSupervisorSandbox", () => {
    test("ensures sandbox and pushes config", async () => {
      const entry = await supervisor.syncSupervisorSandbox("ws-sync-1")

      expect(entry.status).toBe("ready")
    })
  })

  // ── shutdownWorkspaceSupervisor ────────────────────────────────────

  describe("shutdownWorkspaceSupervisor", () => {
    test("stops all running runtimes", async () => {
      await supervisor.ensureSupervisorSandbox("ws-shutdown-1")
      await supervisor.ensureSupervisorSandbox("ws-shutdown-2")

      await supervisor.shutdownWorkspaceSupervisor()

      const list = supervisor.listSupervisorSandboxs()
      expect(list).toHaveLength(0)
    })
  })
})

// ── Expected behavior: Daytona sandbox wake ─────────────────────────────
// These tests document the EXPECTED behavior for waking stopped sandboxes.

describe("workspace-supervisor: expected wake behavior", () => {
  beforeEach(() => {
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = runtimePrivateKeyPem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = runtimePublicKeyPem
    // The shared driver-auth mock keeps whatever implementation the LAST test
    // of the previous describe installed; restore the defaults this block needs.
    mockSandboxDriverAuthAsync.mockImplementation(async (_cfg: unknown, id: string) => {
      if (id === "daytona") return { api_key: "dtn-default" }
    })
    supervisor.configureWorkspaceSupervisor({
      server_url: "http://localhost:3000",
      relay_url: "https://relay.example.test",
    })
  })

  afterEach(async () => {
    await supervisor.shutdownWorkspaceSupervisor()
    if (previousRuntimePrivateKey === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM
    else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = previousRuntimePrivateKey
  })

  test("when Daytona host is stopped, direct sandbox driver resume is used to wake it", async () => {
    await supervisor.ensureSupervisorSandbox("ws-wake-start-1")
    await supervisor.stopSupervisorSandbox("ws-wake-start-1", "test")

    const callsBefore = mockDaytonaLaunch.mock.calls.length

    await supervisor.ensureSupervisorSandbox("ws-wake-start-1")

    expect(mockDaytonaLaunch.mock.calls.length).toBe(callsBefore + 1)
  })

  test("wake produces fewer provision events than cold start", async () => {
    mockGetWorkspace.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        project_id: "proj-1",
        directory: "/workspace",
        kind: "cloud" as const,
        driver: driverId as any,
        repo_url: "https://github.com/test/repo.git",
        remote_directory: "/workspace",
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    )

    const tracker = captureProvisionEvents()
    await supervisor.ensureSupervisorSandbox("ws-wake-warm-1")

    const steps = tracker.events
      .filter(
        (e): e is Extract<ClaxedoEvent, { type: "provision" }> =>
          e.type === "provision" && (e as any).workspaceId === "ws-wake-warm-1",
      )
      .map((e) => e.step)

    expect(steps).toContain("acquiring_sandbox")
    expect(steps).toContain("ready")

    tracker.cleanup()
  })

  test("stop → resume cycle preserves sandbox identity", async () => {
    mockGetWorkspace.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        project_id: "proj-1",
        directory: "/workspace",
        kind: "cloud" as const,
        driver: driverId as any,
        repo_url: "",
        remote_directory: "/workspace",
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    )

    // Start
    await supervisor.ensureSupervisorSandbox("ws-identity-1")
    expect(supervisor.getSupervisorSandboxTarget("ws-identity-1")?.sandboxId).toBe("daytona-sdk-sb")

    // Stop
    await supervisor.stopSupervisorSandbox("ws-identity-1", "test")

    await supervisor.ensureSupervisorSandbox("ws-identity-1")
    expect(supervisor.getSupervisorSandboxTarget("ws-identity-1")?.sandboxId).toBe("daytona-sdk-sb")
  })
})
