import { describe, expect, test, vi } from "vitest"
import { createSandboxManager, type SandboxDriver, type SandboxDriverEnsureInput } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../authority/services"
import { HostedWorkspaceRoutes } from "../routes/hosted/workspace"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { hostedSandboxInput } from "./hosted-sandbox-input"

const CONTROL_PLANE_ORIGIN = "https://cp.claxedo.test"
const REQUEST_ORIGIN = "https://edge.claxedo.test"
const RELAY_URL = "https://relay.claxedo.test"

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
    },
  } satisfies SandboxDriver
  return { driver, created, lose: () => hosts.clear() }
}

function composition() {
  const { driver, created, lose } = recreatingDriver()
  const sandboxManager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
  const rows = new Map<string, Record<string, unknown>>()
  const authority = {
    usersMe: async () => ({ subject: "owner" }),
    authorizeWorkspaceCreate: async () => {},
    createCloudWorkspace: async (_auth: unknown, args: {
      workspaceId: string
      projectId?: string
      displayName: string
      repoUrl?: string
      gitBranch?: string
      remoteDirectory?: string
      homeRegion?: string
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
      })
      return { workspace_id: args.workspaceId }
    },
    openWorkspace: async (_auth: unknown, args: { workspaceId: string }) => ({ allowed: true, role: "owner", workspace: rows.get(args.workspaceId) }),
    resolveWorkspaceOwner: async () => ({ userId: "owner", orgId: "org" }),
    auditAllow: async () => ({}),
    auditDeny: async () => ({}),
  }
  const services = {
    authority,
    sandbox: { sandboxManager, defaultDriver: driver.id },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const egress = { relayUrl: RELAY_URL, sandboxControlPlaneOrigin: CONTROL_PLANE_ORIGIN }
  const delivery = createHostedRuntimeDelivery({
    authority: authority as unknown as WorkspaceAuthority,
    services,
    sandboxManager,
    driver,
    sandboxInput: async (workspaceId, prepared) => hostedSandboxInput(rows.get(workspaceId) ?? {}, { egress, ...prepared }),
    settings: {} as never,
    credentials: () => ({}) as never,
    signingEnv: {},
    provisionedRunner: undefined,
  })
  const env = { WORKSPACE_RUNTIME_MCP_TOOL_GROUPS: "sessions,subagents" }
  const secrets = [{ name: "ANTHROPIC_API_KEY", value: "sk-ant", hosts: ["api.anthropic.com"] }]
  const prepareRuntime = async () => ({ secrets, env })
  delivery.composeRuntime({ prepareRuntime, provisionRuntime: async () => {} })
  const app = HostedWorkspaceRoutes(services, {
    authConfig: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
    verifier,
    ...egress,
    countActiveOrgSandboxLeases: async () => 0,
    resolveRepoAddresses: async () => ["140.82.112.3"],
    prepareRuntime,
    provisionRuntime: async () => {},
  })
  return { app, delivery, created, lose }
}

describe("refreshing a running hosted sandbox", () => {
  test("a refresh that re-creates the host hands the driver everything the create did", async () => {
    const { app, delivery, created, lose } = composition()
    const res = await app.fetch(new Request(`${REQUEST_ORIGIN}/create`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "proj_1",
        repoUrl: "https://github.com/acme/widgets.git",
        gitBranch: "main",
        remoteDirectory: "/srv/widgets",
      }),
    }))
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(created).toHaveLength(1))

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
  })
})
