import type { D1Database } from "@cloudflare/workers-types"
import { createSandboxManager, SandboxRuntimeBootError, type SandboxDriver, type SandboxDriverEnsureInput } from "@claxedo/sandbox-manager"
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

/**
 * A driver scripted by the workspace id: `ws_slow_<ms>` becomes ready after
 * that long, `ws_poll_<n>` asks to be polled n times first, `ws_boot_fail`
 * exits before it is ready, `ws_flaky` fails once at the provider,
 * `ws_step_throws` throws out of the start step once the lease is ready (its
 * runtime is not provisioned until a second step), and a workspace named
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
    if (input.workspaceId.startsWith("ws_flaky") && calls === 1) throw new Error("provider hiccup")
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

function manager(env: Env) {
  return createSandboxManager({
    leaseStore: createD1SandboxLeaseStore({ database: env.CONTROL_PLANE_DB }),
    driver: scriptedDriver(env.CONTROL_PLANE_DB),
    retryAfterMs: 100,
    retryDelayMs: () => 200,
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
  return {
    acquire: (workspaceId) => sandboxes.acquire(workspaceId, input),
    provision: async (workspaceId, epoch) => {
      const answer = await sandboxes.provision(workspaceId, epoch, input)
      if (workspaceId.startsWith("ws_step_throws") && answer.status === "ready" && await driverCalls(env.CONTROL_PLANE_DB, workspaceId) === 1) {
        throw Object.assign(new Error("the runtime refused its settings"), { code: "runtime_provision_failed" })
      }
      if (renewing(workspaceId) && answer.status === "ready") return { ...answer, renewAt: Date.now() + RENEWAL_DUE_MS }
      if (watching(workspaceId) && answer.status === "ready") return { ...answer, watchAt: Date.now() + WATCH_DUE_MS }
      return answer
    },
    renew: async (workspaceId) => {
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
    if (url.pathname === "/start") return Response.json(await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).start(workspaceId))
    if (url.pathname === "/refresh") return Response.json(await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).refresh(workspaceId))
    if (url.pathname === "/in-flight") return Response.json((await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).inFlight()) ?? null)
    if (url.pathname === "/target") return Response.json(await manager(env).target(workspaceId))
    if (url.pathname === "/driver-calls") return Response.json({ calls: await driverCalls(env.CONTROL_PLANE_DB, workspaceId) })
    if (url.pathname === "/renewals") return Response.json({ renewals: await renewals(env.CONTROL_PLANE_DB, workspaceId) })
    if (url.pathname === "/watches") return Response.json({ watches: await watches(env.CONTROL_PLANE_DB, workspaceId) })
    return new Response("not found", { status: 404 })
  },
}
