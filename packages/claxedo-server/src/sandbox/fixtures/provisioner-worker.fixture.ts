import type { D1Database } from "@cloudflare/workers-types"
import { createSandboxManager, liftSandboxRetryWait, SandboxProviderKeyRefusedError, SandboxProviderRateLimitedError, SandboxRuntimeBootError, type SandboxDriver, type SandboxDriverEnsureInput } from "@claxedo/sandbox-manager"
import { createD1SandboxLeaseStore } from "../stores/d1"
import { sandboxProvisionerClass } from "../provisioner.cf"
import { FIXTURE_OUTCOME_HELD_MS } from "./provisioner-outcome-held"
import { sandboxProvisioner, type SandboxProvisionerNamespace, type SandboxStartDrive } from "../../workspace/sandbox-start"

type Env = { CONTROL_PLANE_DB: D1Database; SANDBOX_PROVISIONER: SandboxProvisionerNamespace }

const CALLS_TABLE = "fixture_driver_calls"

async function recordCall(database: D1Database, workspaceId: string) {
  await database.prepare(`create table if not exists ${CALLS_TABLE} (workspace_id text not null)`).run()
  await database.prepare(`insert into ${CALLS_TABLE} (workspace_id) values (?)`).bind(workspaceId).run()
  const row = await database.prepare(`select count(*) as n from ${CALLS_TABLE} where workspace_id = ?`).bind(workspaceId).first<{ n: number }>()
  return row?.n ?? 0
}

async function driverCalls(database: D1Database, workspaceId: string) {
  const row = await database
    .prepare(`select count(*) as n from sqlite_master where type = 'table' and name = ?`)
    .bind(CALLS_TABLE)
    .first<{ n: number }>()
  if (!row?.n) return 0
  const calls = await database.prepare(`select count(*) as n from ${CALLS_TABLE} where workspace_id = ?`).bind(workspaceId).first<{ n: number }>()
  return calls?.n ?? 0
}

const FIXED_KEYS_TABLE = "fixture_fixed_keys"

async function keyFixed(database: D1Database, workspaceId: string) {
  await database.prepare(`create table if not exists ${FIXED_KEYS_TABLE} (workspace_id text not null)`).run()
  return !!(await database.prepare(`select 1 from ${FIXED_KEYS_TABLE} where workspace_id = ?`).bind(workspaceId).first())
}

/** The person replaces the key `ws_key_refused` starts on, and the key change lifts the lease's wait. */
async function fixKey(database: D1Database, workspaceId: string) {
  await keyFixed(database, workspaceId)
  await database.prepare(`insert into ${FIXED_KEYS_TABLE} (workspace_id) values (?)`).bind(workspaceId).run()
  return liftSandboxRetryWait(createD1SandboxLeaseStore({ database }), workspaceId)
}

/**
 * A driver scripted by the workspace id: `ws_slow_<ms>` becomes ready after
 * that long, `ws_poll_<n>` asks to be polled n times first, `ws_boot_fail`
 * exits before it is ready, `ws_flaky` fails once at the provider and
 * `ws_flaky_<n>` n times, `ws_key_refused` has its key refused until `/fix-key`,
 * `ws_day_limited_<n>` is refused at its provider's daily start limit n times,
 * `ws_hour_limited` at its hourly one every time, `ws_step_throws` throws out of the start step once the lease is ready (its
 * runtime is not provisioned until a second step), `ws_stopped_under` has its
 * lease stopped while the driver runs its first boot, and a workspace named
 * `asleep` has a runtime that never answers a ready lease.
 */
function scriptedDriver(database: D1Database): SandboxDriver {
  const ready = (input: SandboxDriverEnsureInput) => ({
    sandboxId: `sandbox_${input.workspaceId}`,
    url: `https://runtime.test/${input.workspaceId}`,
    hostId: `host_${input.workspaceId}`,
    labels: input.labels,
  })
  const ensureHost = async (input: SandboxDriverEnsureInput) => {
    const calls = await recordCall(database, input.workspaceId)
    const slow = /^ws_slow_(\d+)/.exec(input.workspaceId)
    if (slow) await new Promise((resolve) => setTimeout(resolve, Number(slow[1])))
    const poll = /^ws_poll_(\d+)/.exec(input.workspaceId)
    if (poll && calls <= Number(poll[1])) return { provisioning: true as const, retryAfterMs: 100 }
    if (input.workspaceId.startsWith("ws_boot_fail")) throw new SandboxRuntimeBootError("the image has no runtime")
    if (input.workspaceId.startsWith("ws_key_refused") && !(await keyFixed(database, input.workspaceId))) {
      throw new SandboxProviderKeyRefusedError("the key was rejected (unauthorized)")
    }
    const dayLimited = /^ws_day_limited_(\d+)/.exec(input.workspaceId)
    if (dayLimited && calls <= Number(dayLimited[1])) throw new SandboxProviderRateLimitedError({ window: "day", limit: 200 }, "the start limit is used up")
    if (input.workspaceId.startsWith("ws_hour_limited")) throw new SandboxProviderRateLimitedError({ window: "hour", limit: 60 }, "the start limit is used up")
    const flaky = /^ws_flaky(?:_(\d+))?/.exec(input.workspaceId)
    if (flaky && calls <= Number(flaky[1] ?? 1)) throw new Error("provider hiccup")
    if (input.workspaceId.startsWith("ws_stopped_under") && calls === 1) {
      await createD1SandboxLeaseStore({ database }).update(input.workspaceId, input.epoch, { status: "stopped" })
    }
    return ready(input)
  }
  return {
    id: "scripted",
    ensureHost,
    resumeHost: (input) => ensureHost(input.ensure),
    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
      egressControl: "hosts",
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "not-applicable",
        restoreMount: "not-applicable",
      },
    },
  }
}

const FIXTURE_MAX_RETRY_COUNT = 4
const FIXTURE_RETRY_CAP_COOLDOWN_MS = 60_000

function manager(env: Env) {
  return createSandboxManager({
    leaseStore: createD1SandboxLeaseStore({ database: env.CONTROL_PLANE_DB }),
    driver: scriptedDriver(env.CONTROL_PLANE_DB),
    retryAfterMs: 100,
    retryDelayMs: () => 200,
    maxRetryCount: FIXTURE_MAX_RETRY_COUNT,
    retryCapCooldownMs: FIXTURE_RETRY_CAP_COOLDOWN_MS,
  })
}

const RENEWALS_TABLE = "fixture_renewals"

async function recordRenewal(database: D1Database, workspaceId: string) {
  await database.prepare(`create table if not exists ${RENEWALS_TABLE} (workspace_id text not null)`).run()
  await database.prepare(`insert into ${RENEWALS_TABLE} (workspace_id) values (?)`).bind(workspaceId).run()
  return renewals(database, workspaceId)
}

async function renewals(database: D1Database, workspaceId: string) {
  const table = await database.prepare(`select count(*) as n from sqlite_master where type = 'table' and name = ?`).bind(RENEWALS_TABLE).first<{ n: number }>()
  if (!table?.n) return 0
  const row = await database.prepare(`select count(*) as n from ${RENEWALS_TABLE} where workspace_id = ?`).bind(workspaceId).first<{ n: number }>()
  return row?.n ?? 0
}

/** `ws_renew_<n>`: its settings are due again 200 ms after every delivery, and it keeps serving through n renewals. */
const RENEWAL_DUE_MS = 200

const ROOT_RENEWALS_TABLE = "fixture_root_renewals"

/**
 * `ws_root_<name>`: a Task root, whose start schedules nothing and whose
 * settings a push outside any run delivered; every renewal records the
 * capability set it was prepared with, and it is due again 200 ms later for
 * as long as its lease is ready.
 */
async function recordRootRenewal(database: D1Database, workspaceId: string, capabilities: unknown) {
  await database.prepare(`create table if not exists ${ROOT_RENEWALS_TABLE} (workspace_id text not null, capabilities text)`).run()
  await database.prepare(`insert into ${ROOT_RENEWALS_TABLE} (workspace_id, capabilities) values (?, ?)`).bind(workspaceId, capabilities === undefined ? null : JSON.stringify(capabilities)).run()
}

async function rootRenewals(database: D1Database, workspaceId: string): Promise<unknown[]> {
  const table = await database.prepare(`select count(*) as n from sqlite_master where type = 'table' and name = ?`).bind(ROOT_RENEWALS_TABLE).first<{ n: number }>()
  if (!table?.n) return []
  const rows = await database.prepare(`select capabilities from ${ROOT_RENEWALS_TABLE} where workspace_id = ? order by rowid`).bind(workspaceId).all<{ capabilities: string | null }>()
  return rows.results.map((row) => (row.capabilities === null ? null : JSON.parse(row.capabilities)))
}

const ROOT_STEPS_TABLE = "fixture_root_steps"

/**
 * `ws_task_<name>`: a Task root started with its capability set; every step
 * of it records the step and the capability set it was prepared with, and its
 * settings are due again 200 ms after it is ready, for as long as it serves.
 */
async function recordRootStep(database: D1Database, workspaceId: string, step: string, capabilities: unknown) {
  await database.prepare(`create table if not exists ${ROOT_STEPS_TABLE} (workspace_id text not null, step text not null, capabilities text)`).run()
  await database.prepare(`insert into ${ROOT_STEPS_TABLE} (workspace_id, step, capabilities) values (?, ?, ?)`).bind(workspaceId, step, capabilities === undefined ? null : JSON.stringify(capabilities)).run()
}

async function rootSteps(database: D1Database, workspaceId: string): Promise<Array<{ step: string; capabilities: unknown }>> {
  const table = await database.prepare(`select count(*) as n from sqlite_master where type = 'table' and name = ?`).bind(ROOT_STEPS_TABLE).first<{ n: number }>()
  if (!table?.n) return []
  const rows = await database.prepare(`select step, capabilities from ${ROOT_STEPS_TABLE} where workspace_id = ? order by rowid`).bind(workspaceId).all<{ step: string; capabilities: string | null }>()
  return rows.results.map((row) => ({ step: row.step, capabilities: row.capabilities === null ? null : JSON.parse(row.capabilities) }))
}

const WATCHES_TABLE = "fixture_watches"

/** Records one idle read with the failures the provisioner counted before it; answers how many reads the workspace has had. */
async function recordWatch(database: D1Database, workspaceId: string, failures: number) {
  await database.prepare(`create table if not exists ${WATCHES_TABLE} (workspace_id text not null, failures integer not null)`).run()
  await database.prepare(`insert into ${WATCHES_TABLE} (workspace_id, failures) values (?, ?)`).bind(workspaceId, failures).run()
  return (await watches(database, workspaceId)).length
}

async function watches(database: D1Database, workspaceId: string): Promise<number[]> {
  const table = await database.prepare(`select count(*) as n from sqlite_master where type = 'table' and name = ?`).bind(WATCHES_TABLE).first<{ n: number }>()
  if (!table?.n) return []
  const rows = await database.prepare(`select failures from ${WATCHES_TABLE} where workspace_id = ? order by rowid`).bind(workspaceId).all<{ failures: number }>()
  return rows.results.map((row) => row.failures)
}

const NOTICES_TABLE = "fixture_notices"

async function recordNotice(database: D1Database, workspaceId: string, step: string) {
  await database.prepare(`create table if not exists ${NOTICES_TABLE} (workspace_id text not null, step text not null)`).run()
  await database.prepare(`insert into ${NOTICES_TABLE} (workspace_id, step) values (?, ?)`).bind(workspaceId, step).run()
}

async function notices(database: D1Database, workspaceId: string): Promise<string[]> {
  const table = await database.prepare(`select count(*) as n from sqlite_master where type = 'table' and name = ?`).bind(NOTICES_TABLE).first<{ n: number }>()
  if (!table?.n) return []
  const rows = await database.prepare(`select step from ${NOTICES_TABLE} where workspace_id = ? order by rowid`).bind(workspaceId).all<{ step: string }>()
  return rows.results.map((row) => row.step)
}

/**
 * `ws_watch_<n>`: its idleness is read 200 ms after it is ready and after every
 * read; the n-th read finds it idle and stops it. `ws_watchfail_<n>`: every
 * read throws until the provisioner has counted n failures, and that read
 * stops it as unreachable.
 */
const WATCH_DUE_MS = 200

function drive(env: Env): SandboxStartDrive {
  const sandboxes = manager(env)
  const input = { homeRegion: "us-east", labels: {} }
  const renewing = (workspaceId: string) => /^ws_renew_(\d+)/.exec(workspaceId)
  const watching = (workspaceId: string) => /^ws_watch(fail)?_(\d+)/.exec(workspaceId)
  const taskRoot = (workspaceId: string) => workspaceId.startsWith("ws_task_")
  return {
    acquire: async (workspaceId, capabilities) => {
      if (taskRoot(workspaceId)) await recordRootStep(env.CONTROL_PLANE_DB, workspaceId, "acquire", capabilities)
      return sandboxes.acquire(workspaceId, input)
    },
    provision: async (workspaceId, epoch, capabilities) => {
      const answer = await sandboxes.provision(workspaceId, epoch, input)
      if (taskRoot(workspaceId)) {
        await recordRootStep(env.CONTROL_PLANE_DB, workspaceId, "provision", capabilities)
        return answer.status === "ready" ? { ...answer, renewAt: Date.now() + RENEWAL_DUE_MS } : answer
      }
      if (workspaceId.startsWith("ws_step_throws") && answer.status === "ready" && await driverCalls(env.CONTROL_PLANE_DB, workspaceId) === 1) {
        throw Object.assign(new Error("the runtime refused its settings"), { code: "runtime_provision_failed" })
      }
      if (renewing(workspaceId) && answer.status === "ready") return { ...answer, renewAt: Date.now() + RENEWAL_DUE_MS }
      if (watching(workspaceId) && answer.status === "ready") return { ...answer, watchAt: Date.now() + WATCH_DUE_MS }
      return answer
    },
    renew: async (workspaceId, capabilities) => {
      if (taskRoot(workspaceId)) {
        if ((await sandboxes.target(workspaceId)).status !== "ready") return undefined
        await recordRootStep(env.CONTROL_PLANE_DB, workspaceId, "renew", capabilities)
        return Date.now() + RENEWAL_DUE_MS
      }
      if (workspaceId.startsWith("ws_root_")) {
        if ((await sandboxes.target(workspaceId)).status !== "ready") return undefined
        await recordRootRenewal(env.CONTROL_PLANE_DB, workspaceId, capabilities)
        return Date.now() + RENEWAL_DUE_MS
      }
      const scripted = renewing(workspaceId)
      if (!scripted) return undefined
      const count = await recordRenewal(env.CONTROL_PLANE_DB, workspaceId)
      return count < Number(scripted[1]) ? Date.now() + RENEWAL_DUE_MS : undefined
    },
    watch: async (workspaceId, failures) => {
      const scripted = watching(workspaceId)
      if (!scripted) return undefined
      const target = await sandboxes.target(workspaceId)
      if (target.status !== "ready") return undefined
      const count = await recordWatch(env.CONTROL_PLANE_DB, workspaceId, failures)
      const limit = Number(scripted[2])
      if (scripted[1]) {
        if (failures < limit) throw new Error("the runtime answered nothing")
        await sandboxes.stop(workspaceId, { expectedEpoch: target.epoch })
        return undefined
      }
      if (count < limit) return Date.now() + WATCH_DUE_MS
      await sandboxes.stop(workspaceId, { expectedEpoch: target.epoch, idleBefore: Date.now() })
      return undefined
    },
    target: (workspaceId) => sandboxes.target(workspaceId),
    announce: (workspaceId, step) => recordNotice(env.CONTROL_PLANE_DB, workspaceId, step),
    live: async (workspaceId) => {
      const target = await sandboxes.target(workspaceId)
      if (target.status !== "ready") return undefined
      if (workspaceId.includes("asleep") && await driverCalls(env.CONTROL_PLANE_DB, workspaceId) < 2) return undefined
      if (workspaceId.startsWith("ws_step_throws") && await driverCalls(env.CONTROL_PLANE_DB, workspaceId) === 1) return undefined
      return target
    },
  }
}

export class SandboxProvisioner extends sandboxProvisionerClass(drive, { outcomeHeldMs: FIXTURE_OUTCOME_HELD_MS, followUpRetryMs: WATCH_DUE_MS }) {}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get("ws") ?? ""
    if (url.pathname === "/start") {
      const plugin = url.searchParams.get("plugin")
      return Response.json(await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).start(workspaceId, {
        ...(url.searchParams.has("retry") ? { retry: true } : {}),
        ...(plugin ? { capabilities: { plugins: [{ sourceId: "src", pluginName: plugin }], skills: [] } } : {}),
      }))
    }
    if (url.pathname === "/refresh") return Response.json(await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).refresh(workspaceId))
    if (url.pathname === "/redeliver") {
      await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).redeliver(workspaceId)
      return Response.json({ redelivered: true })
    }
    if (url.pathname === "/follow") {
      const capabilities = { plugins: [{ sourceId: "src", pluginName: url.searchParams.get("plugin") ?? "" }], skills: [] }
      await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).follow({ workspaceId, capabilities }, { renewAt: Date.now() + RENEWAL_DUE_MS })
      return Response.json({ followed: true })
    }
    if (url.pathname === "/stop") {
      const current = await manager(env).target(workspaceId)
      return Response.json(await manager(env).stop(workspaceId, current.status === "ready" ? { expectedEpoch: current.epoch } : {}))
    }
    if (url.pathname === "/root-renewals") return Response.json({ renewals: await rootRenewals(env.CONTROL_PLANE_DB, workspaceId) })
    if (url.pathname === "/root-steps") return Response.json({ steps: await rootSteps(env.CONTROL_PLANE_DB, workspaceId) })
    if (url.pathname === "/in-flight") return Response.json((await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).inFlight()) ?? null)
    if (url.pathname === "/target") return Response.json(await manager(env).target(workspaceId))
    if (url.pathname === "/driver-calls") return Response.json({ calls: await driverCalls(env.CONTROL_PLANE_DB, workspaceId) })
    if (url.pathname === "/renewals") return Response.json({ renewals: await renewals(env.CONTROL_PLANE_DB, workspaceId) })
    if (url.pathname === "/notices") return Response.json({ notices: await notices(env.CONTROL_PLANE_DB, workspaceId) })
    if (url.pathname === "/fix-key") return Response.json({ lifted: await fixKey(env.CONTROL_PLANE_DB, workspaceId) })
    if (url.pathname === "/watches") return Response.json({ watches: await watches(env.CONTROL_PLANE_DB, workspaceId) })
    return new Response("not found", { status: 404 })
  },
}
