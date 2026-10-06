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
 * exits before it is ready, and `ws_flaky` fails once at the provider.
 */
function scriptedDriver(database: D1Database): SandboxDriver {
  const ready = (input: SandboxDriverEnsureInput) => ({
    sandboxId: `sandbox_${input.workspaceId}`,
    url: `https://runtime.test/${input.workspaceId}`,
    hostId: `host_${input.workspaceId}`,
    labels: input.labels,
  })
  return {
    id: "scripted",
    async ensureHost(input) {
      const calls = await recordCall(database, input.workspaceId)
      const slow = /^ws_slow_(\d+)/.exec(input.workspaceId)
      if (slow) await new Promise((resolve) => setTimeout(resolve, Number(slow[1])))
      const poll = /^ws_poll_(\d+)/.exec(input.workspaceId)
      if (poll && calls <= Number(poll[1])) return { provisioning: true as const, retryAfterMs: 100 }
      if (input.workspaceId.startsWith("ws_boot_fail")) throw new SandboxRuntimeBootError("the image has no runtime")
      if (input.workspaceId.startsWith("ws_flaky") && calls === 1) throw new Error("provider hiccup")
      return ready(input)
    },
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

function drive(env: Env): SandboxStartDrive {
  const sandboxes = manager(env)
  const input = { homeRegion: "us-east", labels: {} }
  return {
    acquire: (workspaceId) => sandboxes.acquire(workspaceId, input),
    provision: (workspaceId, epoch) => sandboxes.provision(workspaceId, epoch, input),
    target: (workspaceId) => sandboxes.target(workspaceId),
  }
}

export class SandboxProvisioner extends sandboxProvisionerClass(drive, FIXTURE_OUTCOME_HELD_MS) {}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    const workspaceId = url.searchParams.get("ws") ?? ""
    if (url.pathname === "/start") return Response.json(await sandboxProvisioner(env.SANDBOX_PROVISIONER, workspaceId).start(workspaceId))
    if (url.pathname === "/target") return Response.json(await manager(env).target(workspaceId))
    if (url.pathname === "/driver-calls") return Response.json({ calls: await driverCalls(env.CONTROL_PLANE_DB, workspaceId) })
    return new Response("not found", { status: 404 })
  },
}
