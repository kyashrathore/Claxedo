import { afterEach, describe, expect, test, vi } from "vitest"
import { createSandboxManager, type SandboxDriver, type SandboxDriverEnsureInput } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../authority/services"
import { HostedWorkspaceRoutes } from "../routes/hosted/workspace"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { hostedSandboxInput } from "./hosted-sandbox-input"
import type { ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { inlineSandboxStart } from "../test-support/inline-sandbox-start"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"

const pushed = vi.hoisted(() => [] as string[])
/** When set, the runtime refuses its settings with this reason. */
const pushRefusal = vi.hoisted(() => ({ reason: undefined as string | undefined }))
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: () => ({ applyConfig: async () => {
  if (pushRefusal.reason) throw new Error(pushRefusal.reason)
  pushed.push("config")
} }) }))
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", () => ({ mintSupervisorBackplaneToken: async () => ({ supervisorBackplaneToken: "supervisor-token" }) }))

const CONTROL_PLANE_ORIGIN = "https://cp.claxedo.test"
const REQUEST_ORIGIN = "https://edge.claxedo.test"
const RELAY_URL = "https://relay.claxedo.test"

const active: ControlPlaneDatabase[] = []
afterEach(async () => {
  pushRefusal.reason = undefined
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer, orgId: "org" },
})

/** A provider that loses hosts: an ensure for a host it no longer holds creates a new one. */
function recreatingDriver() {
  const hosts = new Set<string>()
  const created: SandboxDriverEnsureInput[] = []
  const driver = {
    id: "test",
    ensureHost: async (input: SandboxDriverEnsureInput) => {
      const hostId = input.hostId ?? input.workspaceId
      if (!hosts.has(hostId)) {
        hosts.add(hostId)
        created.push(input)
      }
      return { sandboxId: `sb_${input.workspaceId}`, url: "https://runtime.test", hostId, labels: input.labels }
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
  return { driver, created, lose: () => hosts.clear() }
}

async function composition() {
  const instance = await workspaceBackingDatabase([])
  active.push(instance)
  const { driver, created, lose } = recreatingDriver()
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
      defaultDriver: driver.id,
      workspaceDriver: async () => ({ driver, key: "operator" }),
      orgDriver: async () => ({ driver, key: "operator" }),
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
  return { app, delivery, created, lose, create, secrets, env }
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

  test("a runtime that refuses its settings fails the start after the sandbox is ready, so no token is minted over a half-configured runtime", async () => {
    const { delivery, create } = await composition()
    const workspaceId = await create({})
    await delivery.start.acquire(workspaceId)
    pushRefusal.reason = "artifact corrupt"

    expect(await delivery.start.provision(workspaceId, 1)).toEqual({ status: "failed", code: "runtime_provision_failed", message: "artifact corrupt" })
    expect(await delivery.start.target(workspaceId)).toMatchObject({ status: "ready", epoch: 1 })
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
