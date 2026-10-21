import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { createSandboxManager, type SandboxDriver, type SandboxManager } from "@claxedo/sandbox-manager"
import type { RelayTokenInput } from "@claxedo/server-core/adapters/relay-port"
import { createD1CoreAuthority } from "../authority/adapters/d1/core-authority"
import { recordRelayRuntimeToken } from "../authority/relay-token-record"
import { UNUSED_DURABLE_SESSION_LOG, UNUSED_PROJECTION_STORE } from "../authority/unavailable-session-stores"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import { orgSandboxDrivers } from "../sandbox/org-sandbox-drivers"
import { createOrgSandboxManager } from "../sandbox/org-sandbox-manager"
import { createD1SandboxLeaseStore } from "../sandbox/stores/d1"
import { hostedSandboxInput } from "../workspace/hosted-sandbox-input"
import type { SandboxStart } from "../workspace/sandbox-start"

/** What a runtime access token carries here: the principal the host dispatched as, for the fake runtime's registration call back. */
export type FixtureRuntimeToken = { workspaceId: string; actorId: string; actorKind: "human" | "agent"; principalKind: "user" | "service" }

function tokenPrincipal(token: FixtureRuntimeToken) {
  return token.principalKind === "user"
    ? { principalKind: "user" as const, actorId: token.actorId, actorKind: "human" as const }
    : { principalKind: "service" as const, actorId: token.actorId, actorKind: "agent" as const }
}

function readyDriver(ensures: { count: number }): SandboxDriver {
  return {
    id: "modal",
    metadata: {
      driverRunsIn: ["worker"],
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
    },
    ensureHost: async (input) => {
      ensures.count++
      return {
        sandboxId: `sandbox_${input.workspaceId}`,
        url: `https://sandbox.test/${input.workspaceId}`,
        hostId: `host_${input.workspaceId}`,
        labels: input.labels,
      }
    },
  }
}

/**
 * The workspace's sandbox start the way its provisioner answers it: a serving
 * sandbox answers ready, any other start takes the lease, and the driver steps
 * the provisioner's alarm would run follow inside the start unless the test
 * holds that root's boot, when they run at `settle`. A start the test failed
 * answers the provider's refusal once.
 */
function rootStarts(database: D1Database, manager: SandboxManager) {
  const held = new Set<string>()
  const failing = new Set<string>()
  const input = async (workspaceId: string) => {
    const row = await database
      .prepare("select workspace_id, project_id, repo_url, git_branch, remote_directory from workspaces where workspace_id = ?")
      .bind(workspaceId)
      .first()
    if (!row) throw new Error(`no root ${workspaceId} was filed before its start`)
    return hostedSandboxInput(row, { egress: { defaultHomeRegion: "us-east" }, preparation: undefined })
  }
  const boot = async (workspaceId: string, epoch: number) => {
    for (;;) {
      const answer = await manager.provision(workspaceId, epoch, await input(workspaceId))
      if (answer.status !== "provisioning") return answer
    }
  }
  const start: SandboxStart = async (workspaceId) => {
    if (failing.delete(workspaceId)) return { status: "unavailable", error: "the provider is out of capacity", homeRegion: "us-east" }
    const current = await manager.target(workspaceId)
    if (current.status === "ready") return current
    const acquired = await manager.acquire(workspaceId, await input(workspaceId))
    if (acquired.status !== "provisioning" || held.has(workspaceId)) return acquired
    return boot(workspaceId, acquired.epoch)
  }
  const settle = async (workspaceId: string) => {
    held.delete(workspaceId)
    const lease = (await manager.list()).find((row) => row.workspaceId === workspaceId)
    return lease ? boot(workspaceId, lease.epoch) : manager.target(workspaceId)
  }
  return { start, settle, held, failing }
}

/**
 * The hosted control plane a session host dispatches through, over the real
 * D1 authority and a sandbox manager on the D1 lease store. Faked: the sandbox
 * provider, the provisioner's alarm, and the relay's token mint. The workspace
 * runtime behind the relay is the test's outbound service, which reaches back
 * through `hooks` as the real runtime's session routes reach the control
 * plane: to register a reserved session, to ask whether the token's actor may
 * use one, and to publish a person's turn.
 */
export function hostedSessionFixture(database: D1Database, deploymentId: string) {
  const authority = createD1CoreAuthority(database, { deploymentId, product: { kind: "claxedo-hosted" } })
  const ensures = { count: 0 }
  const driver = readyDriver(ensures)
  const leaseStore = createD1SandboxLeaseStore({ database })
  const drivers = orgSandboxDrivers({
    keys: { drivers: ["modal"], create: () => driver, chosenDriver: async () => undefined },
    credentials: () => ({
      listCredentials: async () => [
        { id: "cred_modal", owner: null, provider_id: "modal", kind: "sandbox_driver", status: "active", revision: 1, created_at: 0 },
      ],
      resolveCredentialSecretById: async () => JSON.stringify({ token: "modal-token" }),
    }) as unknown as ControlPlaneCredentials,
  })
  const sandbox = createOrgSandboxManager({
    leaseStore,
    drivers,
    workspaceOrg: async (workspaceId) => (await authority.resolveWorkspaceOwner?.(workspaceId))?.orgId,
    manager: (keyDriver) => createSandboxManager({ leaseStore, driver: keyDriver }),
  })
  const services = {
    authority,
    sessionHosts: authority,
    projectionStore: UNUSED_PROJECTION_STORE,
    durableSessionLog: UNUSED_DURABLE_SESSION_LOG,
    telemetry: { capture: () => {} },
    localExecution: { enabled: false },
    defaultHomeRegion: "us-east",
    sandbox: { sandboxManager: sandbox.manager, orgDriver: sandbox.orgDriver, workspaceDriver: sandbox.workspaceDriver },
    relay: {
      relayUrls: { "us-east": "https://relay.test" },
      provider: {
        mintRuntimeAccessToken: async (input: RelayTokenInput) => {
          const minted = { jti: crypto.randomUUID(), expiresAt: Date.now() + 600_000 }
          await recordRelayRuntimeToken(authority, { ...input, ...minted, token: "" })
          const claims: FixtureRuntimeToken = {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            actorKind: input.actorKind,
            principalKind: input.principalKind,
          }
          return { ...minted, token: btoa(JSON.stringify(claims)) }
        },
        getRelayEndpoint: async () => "https://relay.test",
      },
    },
  } as unknown as ControlPlaneServices
  const starts = rootStarts(database, sandbox.manager)

  const hooks = new Hono()
  hooks.post("/__fail-start", async (c) => {
    starts.failing.add((await c.req.json<{ workspaceId: string }>()).workspaceId)
    return c.json({ ok: true })
  })
  hooks.post("/__hold-boot", async (c) => {
    starts.held.add((await c.req.json<{ workspaceId: string }>()).workspaceId)
    return c.json({ ok: true })
  })
  hooks.post("/__settle", async (c) => c.json(await starts.settle((await c.req.json<{ workspaceId: string }>()).workspaceId)))
  hooks.post("/__authorize", async (c) => {
    const body = await c.req.json<{ token: string; sessionId: string; action: "read" | "write" }>()
    const token = JSON.parse(atob(body.token)) as FixtureRuntimeToken
    try {
      await authority.authorizeRuntimeSession({ ...tokenPrincipal(token), sessionId: body.sessionId, workspaceId: token.workspaceId, action: body.action })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 403)
    }
    return c.json({ allowed: true })
  })
  hooks.post("/__human-turn", async (c) => {
    const { sessionId } = await c.req.json<{ sessionId: string }>()
    await database.prepare("update sessions set last_human_turn_at = ?, status = 'busy', status_at = ? where session_id = ?").bind(Date.now(), Date.now(), sessionId).run()
    return c.json({ ok: true })
  })
  hooks.post("/__stop", async (c) => {
    const { workspaceId } = await c.req.json<{ workspaceId: string }>()
    return c.json(await sandbox.manager.stop(workspaceId))
  })
  hooks.get("/__ensures", (c) => c.json({ ensures: ensures.count }))
  hooks.post("/__register", async (c) => {
    const body = await c.req.json<{ token: string; operationId: string; sessionId: string; createdAt: number; updatedAt: number; title?: string }>()
    const token = JSON.parse(atob(body.token)) as FixtureRuntimeToken
    try {
      await authority.registerRuntimeSession({
        ...tokenPrincipal(token),
        operationId: body.operationId,
        sessionId: body.sessionId,
        workspaceId: token.workspaceId,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
        ...(body.title ? { title: body.title } : {}),
      })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 403)
    }
    return c.json({ allowed: true })
  })

  return { authority, services, starts, hooks }
}
