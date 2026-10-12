import { afterEach, beforeEach, expect, test } from "vitest"
import { createSandboxManager, type SandboxDriver, type SandboxManager } from "@claxedo/sandbox-manager"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import { createD1SandboxLeaseStore } from "../sandbox/stores/d1"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { createD1UsageLedger } from "./adapters/d1-usage-ledger"

const MINUTE = 60_000
const PERIOD = 1_900_000_000_000

let controlPlane: ControlPlaneDatabase
let at = PERIOD
let manager: SandboxManager

beforeEach(async () => {
  controlPlane = await miniflareControlPlaneDatabase()
  at = PERIOD
  const db = controlPlane.database
  await db.batch([
    db.prepare("insert into users values ('usr_alice', 'active', 1, 1, null, null)"),
    db.prepare("insert into users values ('usr_bob', 'active', 1, 1, null, null)"),
    db.prepare("insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at, deleted_at) values ('org_acme', 'Acme', 'deployment', 'usr_alice', 'deployment-1', 1, 1, null)"),
    db.prepare("insert into projects values ('prj_app', 'org_acme', 'repo:app', 'usr_alice', 1, 1, null)"),
    ...[
      ["ws_old", "usr_alice"], ["ws_cross", "usr_alice"], ["ws_stop", "usr_alice"], ["ws_idle", "usr_alice"],
      ["ws_delete", "usr_alice"], ["ws_released", "usr_alice"], ["ws_running", "usr_alice"], ["ws_bob", "usr_bob"],
    ].map(([id, owner]) => db.prepare(`insert into workspaces
      (workspace_id, org_id, project_id, owner_user_id, backing, display_name, created_at, updated_at)
      values (?, 'org_acme', 'prj_app', ?, 'cloud-vm', ?, 1, 1)`).bind(id, owner, id)),
  ])
  manager = createSandboxManager({
    leaseStore: createD1SandboxLeaseStore({ database: db, now: () => at }),
    driver: driver(),
    now: () => at,
  })
})

afterEach(async () => {
  await controlPlane.dispose()
})

function driver(): SandboxDriver {
  return {
    id: "test-provider",
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "hosts-and-cidrs",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "not-applicable",
        restoreMount: "not-applicable",
      },
      machineClasses: ["small", "default", "large"],
    },
    ensureHost: async (input) => ({
      sandboxId: `sandbox_${input.workspaceId}`,
      url: `https://runtime.test/${input.workspaceId}`,
      hostId: `host_${input.workspaceId}`,
      labels: input.labels,
    }),
  }
}

async function boot(workspaceId: string, startsAt: number, machineClass: "small" | "large" = "small") {
  at = startsAt
  expect(await manager.ensure(workspaceId, { homeRegion: "us-east", machineClass })).toMatchObject({ status: "ready" })
}

async function machineTime(person: string, since = PERIOD, org = "org_acme") {
  const routes = UsageRoutes({
    ledger: createD1UsageLedger({ database: controlPlane.database }),
    identity: async (request) => {
      const signed = request.headers.get("x-test-person")
      return signed ? { org_id: org, user_id: signed } : undefined
    },
    pricing: tokenTrackerPricing("bundled"),
    now: () => at,
  })
  const response = await routes.request(`/machine-time?since=${since}`, { headers: { "x-test-person": person } })
  expect(response.status).toBe(200)
  return await response.json()
}

async function bootRows() {
  const rows = await controlPlane.database.prepare("select * from sandbox_boots order by workspace_id").all()
  return rows.results
}

test("each ended boot is recorded once with its owner and machine class, and a person's minutes this period count only their own boots, clipped to the period, plus the ones still running", async () => {
  await boot("ws_old", PERIOD - 180 * MINUTE)
  at = PERIOD - 120 * MINUTE
  await manager.stop("ws_old")

  await boot("ws_cross", PERIOD - 30 * MINUTE, "large")
  at = PERIOD + 30 * MINUTE
  await manager.stop("ws_cross")

  await boot("ws_stop", PERIOD + 60 * MINUTE)
  at += 10 * MINUTE
  expect(await manager.stop("ws_stop")).toMatchObject({ ok: true, status: "stopped" })
  expect(await manager.stop("ws_stop")).toMatchObject({ ok: true, status: "stopped" })

  await boot("ws_idle", PERIOD + 120 * MINUTE)
  at += 20 * MINUTE
  expect(await manager.stop("ws_idle", { idleBefore: at - 15 * MINUTE })).toMatchObject({ ok: true, status: "stopped" })

  await boot("ws_delete", PERIOD + 180 * MINUTE)
  at += 5 * MINUTE
  expect(await manager.destroy("ws_delete")).toMatchObject({ ok: true, status: "destroyed" })

  await boot("ws_released", PERIOD + 200 * MINUTE)
  at += 7 * MINUTE
  expect(await manager.release("ws_released")).toEqual({ released: true })

  await boot("ws_bob", PERIOD + 60 * MINUTE)
  at += 40 * MINUTE
  await manager.stop("ws_bob")

  await boot("ws_running", PERIOD + 240 * MINUTE)
  at += 15 * MINUTE

  expect(await bootRows()).toEqual([
    { workspace_id: "ws_bob", epoch: 1, org_id: "org_acme", owner_user_id: "usr_bob", driver: "test-provider", machine_class: "small", started_at: PERIOD + 60 * MINUTE, stopped_at: PERIOD + 100 * MINUTE },
    { workspace_id: "ws_cross", epoch: 1, org_id: "org_acme", owner_user_id: "usr_alice", driver: "test-provider", machine_class: "large", started_at: PERIOD - 30 * MINUTE, stopped_at: PERIOD + 30 * MINUTE },
    { workspace_id: "ws_delete", epoch: 1, org_id: "org_acme", owner_user_id: "usr_alice", driver: "test-provider", machine_class: "small", started_at: PERIOD + 180 * MINUTE, stopped_at: PERIOD + 185 * MINUTE },
    { workspace_id: "ws_idle", epoch: 1, org_id: "org_acme", owner_user_id: "usr_alice", driver: "test-provider", machine_class: "small", started_at: PERIOD + 120 * MINUTE, stopped_at: PERIOD + 140 * MINUTE },
    { workspace_id: "ws_old", epoch: 1, org_id: "org_acme", owner_user_id: "usr_alice", driver: "test-provider", machine_class: "small", started_at: PERIOD - 180 * MINUTE, stopped_at: PERIOD - 120 * MINUTE },
    { workspace_id: "ws_released", epoch: 1, org_id: "org_acme", owner_user_id: "usr_alice", driver: "test-provider", machine_class: "small", started_at: PERIOD + 200 * MINUTE, stopped_at: PERIOD + 207 * MINUTE },
    { workspace_id: "ws_stop", epoch: 1, org_id: "org_acme", owner_user_id: "usr_alice", driver: "test-provider", machine_class: "small", started_at: PERIOD + 60 * MINUTE, stopped_at: PERIOD + 70 * MINUTE },
  ])

  const until = PERIOD + 255 * MINUTE
  expect(await machineTime("usr_alice")).toMatchObject({ since: PERIOD, until, activeMs: (30 + 10 + 20 + 5 + 7 + 15) * MINUTE, running: 1 })
  expect(await machineTime("usr_bob")).toMatchObject({ since: PERIOD, until, activeMs: 40 * MINUTE, running: 0 })
  expect(await machineTime("usr_carol")).toEqual({ since: PERIOD, until, activeMs: 0, running: 0, workspaces: [], providers: [] })
  expect(await machineTime("usr_alice", PERIOD, "org_other")).toEqual({ since: PERIOD, until, activeMs: 0, running: 0, workspaces: [], providers: [] })
  expect((await machineTime("usr_alice", PERIOD - 150 * MINUTE)).activeMs).toBe((30 + 60 + 10 + 20 + 5 + 7 + 15) * MINUTE)
  expect((await machineTime("usr_alice", PERIOD + 245 * MINUTE)).activeMs).toBe(10 * MINUTE)
})

test("a boot that started before the period and still runs counts from the period's start, and a woken workspace's next boot is its own interval", async () => {
  await boot("ws_running", PERIOD - 60 * MINUTE)
  at = PERIOD + 25 * MINUTE
  expect(await machineTime("usr_alice")).toMatchObject({ since: PERIOD, until: at, activeMs: 25 * MINUTE, running: 1 })

  await manager.stop("ws_running")
  await boot("ws_running", PERIOD + 40 * MINUTE)
  at = PERIOD + 50 * MINUTE
  await manager.stop("ws_running")

  expect((await bootRows()).map((row) => [row.epoch, row.started_at, row.stopped_at])).toEqual([
    [1, PERIOD - 60 * MINUTE, PERIOD + 25 * MINUTE],
    [2, PERIOD + 40 * MINUTE, PERIOD + 50 * MINUTE],
  ])
  expect(await machineTime("usr_alice")).toMatchObject({ since: PERIOD, until: at, activeMs: 35 * MINUTE, running: 0 })
})

test("the machine-time read refuses an unsigned caller, a period over 90 days, and a ledger that keeps no boots", async () => {
  const routes = (ledger: Parameters<typeof UsageRoutes>[0]["ledger"]) => UsageRoutes({
    ledger,
    identity: async (request) => (request.headers.has("x-test-person") ? { org_id: "org_acme", user_id: "usr_alice" } : undefined),
    pricing: tokenTrackerPricing("bundled"),
    now: () => at,
  })
  const headers = { "x-test-person": "usr_alice" }
  const ledger = createD1UsageLedger({ database: controlPlane.database })
  expect((await routes(ledger).request(`/machine-time?since=${PERIOD}`)).status).toBe(401)
  expect((await routes(ledger).request(`/machine-time?since=${PERIOD - 91 * 24 * 60 * MINUTE}`, { headers })).status).toBe(400)
  expect((await routes(ledger).request(`/machine-time?since=${PERIOD + MINUTE}`, { headers })).status).toBe(400)
  expect((await routes(ledger).request("/machine-time", { headers })).status).toBe(400)
  expect((await routes({ usageDashboard: ledger.usageDashboard }).request(`/machine-time?since=${PERIOD}`, { headers })).status).toBe(503)
})

test("the period is split per workspace, provider and size, priced at the provider's published rate where it has one, running workspaces first", async () => {
  const boat = createSandboxManager({
    leaseStore: createD1SandboxLeaseStore({ database: controlPlane.database, now: () => at }),
    driver: { ...driver(), id: "boat" },
    now: () => at,
  })
  at = PERIOD + 10 * MINUTE
  expect(await boat.ensure("ws_old", { homeRegion: "us-east", machineClass: "small" })).toMatchObject({ status: "ready" })
  at = PERIOD + 70 * MINUTE
  await boat.stop("ws_old")
  at = PERIOD + 100 * MINUTE
  expect(await boat.ensure("ws_cross", { homeRegion: "us-east", machineClass: "large" })).toMatchObject({ status: "ready" })
  at = PERIOD + 120 * MINUTE
  await boat.stop("ws_cross")
  at = PERIOD + 130 * MINUTE
  expect(await boat.ensure("ws_cross", { homeRegion: "us-east" })).toMatchObject({ status: "ready" })
  await boot("ws_running", PERIOD + 115 * MINUTE)
  at = PERIOD + 145 * MINUTE

  const time = await machineTime("usr_alice")

  const small = { size: "small", vcpu: 2, memoryGb: 4, usdPerHour: 0.018 }
  const large = { size: "large", vcpu: 8, memoryGb: 16, usdPerHour: 0.072 }
  expect(time).toMatchObject({ activeMs: (60 + 35 + 30) * MINUTE, running: 2 })
  expect(time.workspaces).toEqual([
    { workspaceId: "ws_cross", projectId: "prj_app", name: "ws_cross", provider: "boat", providerLabel: "Boat", machineClass: "large", activeMs: 35 * MINUTE, runningSince: PERIOD + 130 * MINUTE, rate: large, costUsd: (0.072 * 35 * MINUTE) / 3_600_000 },
    { workspaceId: "ws_running", projectId: "prj_app", name: "ws_running", provider: "test-provider", providerLabel: "test-provider", machineClass: "small", activeMs: 30 * MINUTE, runningSince: PERIOD + 115 * MINUTE },
    { workspaceId: "ws_old", projectId: "prj_app", name: "ws_old", provider: "boat", providerLabel: "Boat", machineClass: "small", activeMs: 60 * MINUTE, rate: small, costUsd: (0.018 * 60 * MINUTE) / 3_600_000 },
  ])
  expect(time.providers).toEqual([{
    provider: "boat",
    label: "Boat",
    meter: "Boat bills machine time per second while a sandbox runs, at an hourly rate per size; a stopped sandbox costs nothing.",
    source: { url: "https://docs.boat.dev/pricing", readOn: "2026-10-12" },
  }])
  expect((await bootRows()).map((row) => [row.workspace_id, row.driver, row.machine_class])).toEqual([["ws_cross", "boat", "large"], ["ws_old", "boat", "small"]])
})
