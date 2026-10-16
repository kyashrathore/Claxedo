import { afterEach, describe, expect, test, vi } from "vitest"
import { createSandboxManager, type SandboxDriver, type SandboxDriverEnsureInput, type SandboxTarget } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../authority/services"
import { HostedWorkspaceRoutes } from "../routes/hosted/workspace"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { hostedSandboxInput } from "./hosted-sandbox-input"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { inlineSandboxStart, unusedSandboxRedeliver, unusedSandboxFollow } from "../test-support/inline-sandbox-start"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"
import { IDLE_CHECK_FAILURE_LIMIT, IDLE_CHECK_MS, WORKSPACE_IDLE_MS } from "../sandbox/workspace-idle"

const pushed = vi.hoisted(() => [] as string[])
/** When set, the runtime refuses its settings with this reason. */
const pushRefusal = vi.hoisted(() => ({ reason: undefined as string | undefined }))
/** What the runtime answers about its settings: nothing until a test gives it an answer, the way a runtime that is gone answers nothing. */
const runtimeStatus = vi.hoisted(() => ({ answer: undefined as { state: "applied" | "applying"; revision: number } | undefined }))
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: () => ({
  applyConfig: async () => {
    if (pushRefusal.reason) throw new Error(pushRefusal.reason)
    pushed.push("config")
  },
  configStatus: async () => {
    if (!runtimeStatus.answer) throw new Error("the runtime did not answer")
    return runtimeStatus.answer
  },
}) }))
/** What the runtime answers an idle read with: its health body, or nothing when it is unreachable. */
const runtimeIdle = { report: undefined as Record<string, unknown> | undefined }
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", () => ({ mintSupervisorBackplaneToken: async () => ({ supervisorBackplaneToken: "supervisor-token" }) }))

const CONTROL_PLANE_ORIGIN = "https://cp.claxedo.test"
const REQUEST_ORIGIN = "https://edge.claxedo.test"
const RELAY_URL = "https://relay.claxedo.test"

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  pushRefusal.reason = undefined
  runtimeStatus.answer = undefined
  runtimeIdle.report = undefined
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer, orgId: "org" },
})

/** A provider that loses or stops hosts: an ensure for a host it no longer holds creates a new one. */
function recreatingDriver(id: string) {
  const hosts = new Set<string>()
  const stopped = new Set<string>()
  const inspection = { failure: undefined as Error | undefined }
  const created: SandboxDriverEnsureInput[] = []
  const driver = {
    id,
    ensureHost: async (input: SandboxDriverEnsureInput) => {
      const hostId = input.hostId ?? input.workspaceId
      if (!hosts.has(hostId)) {
        hosts.add(hostId)
        created.push(input)
      }
      return { sandboxId: `sb_${input.workspaceId}`, url: "https://runtime.test", hostId, labels: input.labels }
    },
    inspect: async (target: SandboxTarget) => {
      if (inspection.failure) throw inspection.failure
      return !hosts.has(target.hostId) ? "gone" : stopped.has(target.hostId) ? "stopped" : "serving"
    },
    metadata: {
      driverRunsIn: ["node"],
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
      machineClasses: ["small", "default", "large"],
    },
  } satisfies SandboxDriver
  return { driver, created, inspection, lose: () => hosts.clear(), stopOnItsOwn: () => { for (const host of hosts) stopped.add(host) } }
}

/** `driverId` names the catalog driver whose metadata the plane reads, "cloudflare" being one whose host reads its own idleness. */
async function composition(driverId = "test") {
  const instance = await workspaceBackingDatabase([])
  active.push(instance)
  const { driver, created, inspection, lose, stopOnItsOwn } = recreatingDriver(driverId)
  const stops: Array<{ workspaceId: string; epoch: number; idleBefore?: number }> = []
  const lost: Array<{ workspaceId: string; at: number }> = []
  const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
  const rows = new Map<string, Record<string, unknown>>()
  const authority = {
    usersMe: async () => ({ subject: "owner" }),
    authorizeWorkspaceCreate: async () => ({ orgId: "org" }),
    createCloudWorkspace: async (_auth: unknown, args: {
      workspaceId: string
      projectId?: string
      displayName: string
      repoUrl?: string
      gitBranch?: string
      remoteDirectory?: string
      homeRegion?: string
      machineClass?: string
    }) => {
      rows.set(args.workspaceId, {
        workspace_id: args.workspaceId,
        org_id: "org",
        project_id: args.projectId ?? "project_derived",
        backing: "cloud-vm",
        display_name: args.displayName,
        ...(args.homeRegion ? { home_region: args.homeRegion } : {}),
        ...(args.repoUrl ? { repo_url: args.repoUrl } : {}),
        ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
        ...(args.remoteDirectory ? { remote_directory: args.remoteDirectory } : {}),
        ...(args.machineClass ? { machine_class: args.machineClass } : {}),
      })
      await instance.database.prepare(`insert into workspaces
        (workspace_id, org_id, project_id, owner_user_id, backing, display_name, created_at, updated_at, deleted_at)
        values (?, 'org', 'project', 'owner', 'cloud-vm', ?, 1, 1, null)`).bind(args.workspaceId, args.displayName).run()
      return { workspace_id: args.workspaceId }
    },
    openWorkspace: async (_auth: unknown, args: { workspaceId: string }) => ({ allowed: true, role: "owner", workspace: rows.get(args.workspaceId) }),
    resolveWorkspaceOwner: async () => ({ userId: "owner", orgId: "org", projectId: "project" }),
    auditAllow: async () => ({}),
    auditDeny: async () => ({}),
  }
  const services = {
    authority,
    sandbox: {
      sandboxManager,
      workspaceDriver: async () => driver,
      orgDriver: async () => driver,
    },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const egress = { relayUrl: RELAY_URL, sandboxControlPlaneOrigin: CONTROL_PLANE_ORIGIN }
  const delivery = createHostedRuntimeDelivery({
    authority: authority as unknown as WorkspaceAuthority,
    database: instance.database,
    services,
    sandboxManager,
    workspaceSecretBrokering: async () => driver.metadata.secretBrokering,
    sandboxInput: async (workspaceId, prepared) => hostedSandboxInput(rows.get(workspaceId) ?? {}, { egress, ...prepared }),
    settings: { read: async () => ({ version: 3, connections: {} }), write: async () => {} },
    credentials: () => ({ listCredentials: async () => [], accountSelections: async () => ({}), resolveCredentialSecretById: async () => null }) as never,
    signingEnv: {},
    provisionedRunner: undefined,
    deliverSessionRowsPass: async (workspaceId) => { pushed.push(`session rows pass ${workspaceId}`) },
    sandboxRefresh: (workspaceId) => inlineSandboxStart(delivery.start)(workspaceId),
    sandboxRedeliver: unusedSandboxRedeliver,
    sandboxFollow: unusedSandboxFollow,
    runtimeLost: async (workspaceId, at) => { lost.push({ workspaceId, at }) },
    idleStop: (workspaceId, epoch, stop) => {
      stops.push({ workspaceId, epoch, ...stop })
      return sandboxManager.stop(workspaceId, { expectedEpoch: epoch, ...stop })
    },
    runtimeFetch: async (workspaceId, _orgId, path) => {
      if (path !== "/api/wr/health") return Response.json({}, { status: 404 })
      if (!runtimeIdle.report) throw new Error("the runtime is unreachable")
      return Response.json({ workspaceId, ...runtimeIdle.report })
    },
  })
  const env = { WORKSPACE_RUNTIME_MCP_TOOL_GROUPS: "sessions,subagents" }
  const secrets = [{ name: "ANTHROPIC_API_KEY", value: "sk-ant", hosts: ["api.anthropic.com"] }]
  const prepareRuntime = async () => ({ secrets, env })
  delivery.composeRuntime({ prepareRuntime })
  const app = HostedWorkspaceRoutes(services, {
    authConfig: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
    verifier,
    ...egress,
    countActiveOrgSandboxLeases: async () => 0,
    resolveRepoAddresses: async () => ["140.82.112.3"],
    sandboxStart: inlineSandboxStart(delivery.start),
  })
  const create = async (body: Record<string, unknown>) => {
    const res = await app.fetch(new Request(`${REQUEST_ORIGIN}/create`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ projectId: "proj_1", workspaceName: "Widgets", repoUrl: "https://github.com/acme/widgets.git", ...body }),
    }))
    expect(res.status).toBe(200)
    return (await res.json() as { workspaceId: string }).workspaceId
  }
  return { app, delivery, created, inspection, lose, stopOnItsOwn, create, secrets, env, stops, lost, sandboxManager }
}

describe("the steps of a hosted sandbox start", () => {
  test("acquire takes the lease over the prepared input and runs no driver; provision at that epoch boots it and delivers its settings", async () => {
    const { delivery, created, create, secrets, env } = await composition()
    const workspaceId = await create({ gitBranch: "main", remoteDirectory: "/srv/widgets", machineClass: "large" })

    const acquired = await delivery.start.acquire(workspaceId)
    expect(acquired).toMatchObject({ status: "provisioning", epoch: 1, opened: true })
    expect(created).toHaveLength(0)
    expect(await delivery.start.target(workspaceId)).toMatchObject({ status: "unavailable", leaseStatus: "acquiring" })

    const provisioned = await delivery.start.provision(workspaceId, 1)
    expect(provisioned).toMatchObject({ status: "ready", epoch: 1, hostId: `test-${workspaceId}` })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      source: { kind: "git", repoUrl: "https://github.com/acme/widgets.git", branch: "main" },
      workspaceRoot: "/srv/widgets",
      labels: expect.objectContaining({ projectId: "proj_1" }),
      net: { mode: "restricted", hosts: expect.arrayContaining(["relay.claxedo.test", "cp.claxedo.test", "github.com"]) },
      env,
      secrets,
      machineClass: "large",
    })
    expect(pushed.slice(-2)).toEqual(["config", `session rows pass ${workspaceId}`])
    expect(await delivery.start.target(workspaceId)).toMatchObject({ status: "ready", epoch: 1 })
  })

  test("a later acquire of the ready lease asks for its resume on the same epoch, and names no opening", async () => {
    const { delivery, create } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    await delivery.start.provision(workspaceId, 1)

    const again = await delivery.start.acquire(workspaceId)
    expect(again).toMatchObject({ status: "provisioning", epoch: 1 })
    expect(again).not.toHaveProperty("opened")
    expect(await delivery.start.provision(workspaceId, 1)).toMatchObject({ status: "ready", epoch: 1 })
  })

  test("a provision for an epoch the lease has left answers that the lease changed, and reaches no driver", async () => {
    const { delivery, created, create } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    expect(await delivery.start.provision(workspaceId, 7)).toMatchObject({ status: "unavailable", error: "runtime_lease_changed" })
    expect(created).toHaveLength(0)
  })

  test("a preparation that throws refuses the start before any lease is taken", async () => {
    const { delivery, created, create } = await composition()
    const workspaceId = await create({})
    delivery.composeRuntime({ prepareRuntime: async () => { throw new Error("gateway signing key unavailable") } })

    expect(await delivery.start.acquire(workspaceId)).toEqual({ status: "failed", code: "runtime_prepare_failed", message: "gateway signing key unavailable" })
    expect(created).toHaveLength(0)
    expect(await delivery.start.target(workspaceId)).toMatchObject({ status: "unavailable", reason: "runtime_lease_missing" })
  })

  test("a runtime that answers is proof its host serves, recorded on the lease as its last heartbeat; one that does not answer records nothing and is not live", async () => {
    const { delivery, create, sandboxManager } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    await delivery.start.provision(workspaceId, 1)
    const booted = await sandboxManager.list()
    expect(booted[0]?.lastHeartbeatAt).toBeUndefined()

    expect(await delivery.start.live(workspaceId)).toBeUndefined()
    expect((await sandboxManager.list())[0]?.lastHeartbeatAt).toBeUndefined()

    runtimeStatus.answer = { state: "applied", revision: 1 }
    const before = Date.now()
    expect(await delivery.start.live(workspaceId)).toMatchObject({ status: "ready", epoch: 1 })
    const alive = (await sandboxManager.list())[0]
    expect(alive?.lastHeartbeatAt).toBeGreaterThanOrEqual(before)
    expect(alive).toMatchObject({ status: "ready", epoch: 1 })
  })

  test("a runtime that refuses its settings fails the start after the sandbox is ready, so no token is minted over a half-configured runtime", async () => {
    const { delivery, create } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    pushRefusal.reason = "artifact corrupt"

    expect(await delivery.start.provision(workspaceId, 1)).toEqual({ status: "failed", code: "runtime_provision_failed", message: "artifact corrupt" })
    expect(await delivery.start.target(workspaceId)).toMatchObject({ status: "ready", epoch: 1 })
  })
})

describe("watching a serving hosted sandbox for idleness", () => {
  test("a ready answer of a driver whose host reads no idleness schedules the first read; the reads stop the sandbox as idle once the window has passed", async () => {
    const { delivery, create, stops, sandboxManager } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    const before = Date.now()
    const ready = await delivery.start.provision(workspaceId, 1)
    expect(ready).toMatchObject({ status: "ready", epoch: 1 })
    expect(ready.status === "ready" ? ready.watchAt : undefined).toBeGreaterThanOrEqual(before + IDLE_CHECK_MS)

    runtimeIdle.report = { idleSince: Date.now() - WORKSPACE_IDLE_MS + 60_000 }
    const next = await delivery.start.watch(workspaceId, 0)
    expect(next).toBeGreaterThanOrEqual(Date.now() + IDLE_CHECK_MS - 1_000)
    expect(stops).toEqual([])

    runtimeIdle.report = { idleSince: Date.now() - WORKSPACE_IDLE_MS }
    expect(await delivery.start.watch(workspaceId, 0)).toBeUndefined()
    expect(stops).toEqual([{ workspaceId, epoch: 1, idleBefore: expect.any(Number) }])
    expect(await sandboxManager.target(workspaceId)).toMatchObject({ status: "unavailable", leaseStatus: "stopped" })
    expect(await delivery.start.watch(workspaceId, 0)).toBeUndefined()
    expect(stops).toHaveLength(1)
  })

  test("a runtime that answers nothing is read again, counted, and stopped only once the failure budget is spent", async () => {
    const { delivery, create, stops, lost } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    await delivery.start.provision(workspaceId, 1)

    await expect(delivery.start.watch(workspaceId, 0)).rejects.toThrow("unreachable")
    await expect(delivery.start.watch(workspaceId, IDLE_CHECK_FAILURE_LIMIT - 2)).rejects.toThrow("unreachable")
    expect(stops).toEqual([])
    expect(lost).toEqual([])
    expect(await delivery.start.watch(workspaceId, IDLE_CHECK_FAILURE_LIMIT - 1)).toBeUndefined()
    expect(stops).toEqual([{ workspaceId, epoch: 1 }])
    expect(lost).toEqual([{ workspaceId, at: expect.any(Number) }])
  })

  test("a runtime that answers nothing on a host the provider no longer has ends its lease at the first read, without spending the failure budget", async () => {
    const { delivery, create, stops, lost, lose, sandboxManager } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    await delivery.start.provision(workspaceId, 1)
    lose()

    expect(await delivery.start.watch(workspaceId, 0)).toBeUndefined()
    expect(stops).toEqual([])
    expect(await sandboxManager.target(workspaceId)).toMatchObject({ status: "unavailable", leaseStatus: "destroyed" })
    expect((await sandboxManager.list()).find((lease) => lease.workspaceId === workspaceId)).toMatchObject({ status: "destroyed", lastError: `runtime_host_gone: sb_${workspaceId} is gone` })
    expect(lost).toEqual([{ workspaceId, at: expect.any(Number) }])
  })

  test("a runtime that answers nothing on a host the provider stopped on its own ends its lease stopped at the first read, and its sessions' turns are ended with it", async () => {
    const { delivery, create, stops, lost, stopOnItsOwn, sandboxManager } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    await delivery.start.provision(workspaceId, 1)
    stopOnItsOwn()
    const before = Date.now()

    expect(await delivery.start.watch(workspaceId, 0)).toBeUndefined()
    expect(stops).toEqual([])
    expect(await sandboxManager.target(workspaceId)).toMatchObject({ status: "unavailable", leaseStatus: "stopped" })
    expect(lost).toHaveLength(1)
    expect(lost[0].workspaceId).toBe(workspaceId)
    expect(lost[0].at).toBeGreaterThanOrEqual(before)
    expect(await delivery.start.watch(workspaceId, 0)).toBeUndefined()
    expect(lost).toHaveLength(1)
  })

  test("a sandbox whose host reads its own idleness is watched for liveness alone: an answered read is proof of life and stops nothing, and a host its provider stopped ends the lease stopped at the first unanswered read", async () => {
    const { delivery, create, stops, lost, stopOnItsOwn, sandboxManager } = await composition("cloudflare")
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    const before = Date.now()
    const ready = await delivery.start.provision(workspaceId, 1)
    expect(ready.status === "ready" ? ready.watchAt : undefined).toBeGreaterThanOrEqual(before + IDLE_CHECK_MS)

    runtimeIdle.report = { idleSince: Date.now() - WORKSPACE_IDLE_MS }
    expect(await delivery.start.watch(workspaceId, 0)).toBeGreaterThanOrEqual(Date.now() + IDLE_CHECK_MS - 1_000)
    expect(stops).toEqual([])
    const answered = (await sandboxManager.list())[0]
    expect(answered).toMatchObject({ status: "ready", epoch: 1 })
    expect(answered?.lastHeartbeatAt).toBeGreaterThanOrEqual(before)

    runtimeIdle.report = undefined
    stopOnItsOwn()
    expect(await delivery.start.watch(workspaceId, 0)).toBeUndefined()
    expect(stops).toEqual([])
    expect(await sandboxManager.target(workspaceId)).toMatchObject({ status: "unavailable", leaseStatus: "stopped" })
    expect(lost).toEqual([{ workspaceId, at: expect.any(Number) }])
  })

  test("a provider that cannot say whether the host runs leaves the read counted against the failure budget, which still stops the sandbox", async () => {
    const { delivery, create, stops, inspection } = await composition("cloudflare")
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    await delivery.start.provision(workspaceId, 1)
    inspection.failure = new Error("the provider is unreachable")

    await expect(delivery.start.watch(workspaceId, 0)).rejects.toThrow("the runtime is unreachable")
    expect(stops).toEqual([])
    expect(await delivery.start.watch(workspaceId, IDLE_CHECK_FAILURE_LIMIT - 1)).toBeUndefined()
    expect(stops).toEqual([{ workspaceId, epoch: 1 }])
  })

  test("a runtime that answers nothing on a host the provider still serves is read again, and nothing is ended", async () => {
    const { delivery, create, lost, sandboxManager } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    await delivery.start.provision(workspaceId, 1)

    await expect(delivery.start.watch(workspaceId, 0)).rejects.toThrow("unreachable")
    expect(await sandboxManager.target(workspaceId)).toMatchObject({ status: "ready" })
    expect(lost).toEqual([])
  })
})

describe("refreshing a running hosted sandbox", () => {
  test("a refresh that re-creates the host hands the driver everything the first start did", async () => {
    const { app, delivery, created, lose, create } = await composition()
    const workspaceId = await create({ gitBranch: "main", remoteDirectory: "/srv/widgets" })
    await app.fetch(new Request(`${REQUEST_ORIGIN}/${workspaceId}/connection`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: "{}",
    }))
    expect(created).toHaveLength(1)

    lose()
    await delivery.pluginsChanged("owner")

    expect(created).toHaveLength(2)
    const [fromCreate, fromRefresh] = created
    const provisioned = (input: SandboxDriverEnsureInput) => ({
      source: input.source,
      projectLabel: input.labels.projectId,
      workspaceRoot: input.workspaceRoot,
      net: input.net,
      env: input.env,
      secrets: input.secrets,
    })
    expect(provisioned(fromCreate)).toMatchObject({
      source: { kind: "git", repoUrl: "https://github.com/acme/widgets.git", branch: "main" },
      projectLabel: "proj_1",
      workspaceRoot: "/srv/widgets",
      net: { mode: "restricted", hosts: expect.arrayContaining(["relay.claxedo.test", "cp.claxedo.test", "github.com"]) },
      env: { WORKSPACE_RUNTIME_MCP_TOOL_GROUPS: "sessions,subagents" },
      secrets: [expect.objectContaining({ name: "ANTHROPIC_API_KEY" })],
    })
    expect(provisioned(fromRefresh)).toEqual(provisioned(fromCreate))
    expect(fromRefresh?.workspaceId).toBe(workspaceId)
    expect(pushed.slice(-2), "a ready runtime gets its settings, then its session rows pass").toEqual(["config", `session rows pass ${workspaceId}`])
  })
})
