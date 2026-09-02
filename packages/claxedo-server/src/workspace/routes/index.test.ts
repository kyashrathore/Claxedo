import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { ClerkVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

type WorkspaceTestRow = Record<string, unknown> & {
  id: string
  directory: string
}

const mocks = {
  loadUserConfig: vi.fn(async () => ({ sandbox: {} })),
  saveUserConfig: vi.fn(async () => {}),
  getCredentialByProvider: vi.fn(() => undefined),
  putCredential: vi.fn(async () => ({})),
  deleteCredentialsByProvider: vi.fn(async () => 0),
  ensureHostForRepo: vi.fn(),
  workspaceRows: new Map<string, Record<string, unknown>>(),
  resolveWorkspace: vi.fn(
    async (input: { workspaceId?: string; directory?: string }) =>
      mocks.workspaceRows.get(input.workspaceId ?? "") ?? mocks.workspaceRows.get(input.directory ?? ""),
  ),
  ensureWorkspace: vi.fn(
    async (input: { workspaceId?: string; org_id?: string; directory?: string; kind?: string; status?: string }) => {
      const row: WorkspaceTestRow = {
        id: input.workspaceId ?? crypto.randomUUID(),
        org_id: input.org_id,
        project_id: input.workspaceId ?? crypto.randomUUID(),
        workspace_name: input.directory?.split("/").filter(Boolean).at(-1) ?? "workspace",
        directory: input.directory ?? "/workspace",
        kind: input.kind ?? "local",
        status: input.status,
        created_at: 1,
        updated_at: 1,
      }
      mocks.workspaceRows.set(row.id, row)
      mocks.workspaceRows.set(row.directory, row)
      return row
    },
  ),
  getProjectWorkspace: vi.fn(),
  listProjects: vi.fn(async () => []),
  deleteWorkspace: vi.fn(async () => true),
  discardSupervisorSandbox: vi.fn(async () => {}),
  ensureSupervisorSandbox: vi.fn(async () => ({ url: "http://runtime/ws_1" })),
  getSupervisorSandboxStatus: vi.fn(() => undefined),
  getSandbox: vi.fn(() => undefined),
  markSupervisorSandboxUse: vi.fn(),
  touchSupervisorSandbox: vi.fn(),
  getSupervisorSandboxTarget: vi.fn(() => undefined),
  holdSupervisorSandbox: vi.fn(),
  releaseSupervisorSandbox: vi.fn(),
  syncWorkspaceRuntimeAgentExtensions: vi.fn(async () => {}),
  broadcastRuntimeConfig: vi.fn(async () => {}),
  configureWorkspaceSupervisor: vi.fn(),
  shutdownWorkspaceSupervisor: vi.fn(async () => {}),
  listSupervisorSandboxs: vi.fn(() => []),
  getLease: vi.fn(() => undefined),
  startUserHostedWorkspaceTunnel: vi.fn(async () => ({ url: "http://runtime/ws_local", reused: false })),
  stopUserHostedWorkspaceTunnel: vi.fn(() => true),
  stopAllUserHostedWorkspaceTunnels: vi.fn(() => 0),
}

function resetWorkspaceStoreMocks() {
  mocks.workspaceRows.clear()
  mocks.resolveWorkspace.mockReset()
  mocks.resolveWorkspace.mockImplementation(
    async (input: { workspaceId?: string; directory?: string }) =>
      mocks.workspaceRows.get(input.workspaceId ?? "") ?? mocks.workspaceRows.get(input.directory ?? ""),
  )
  mocks.ensureWorkspace.mockReset()
  mocks.ensureWorkspace.mockImplementation(
    async (input: { workspaceId?: string; org_id?: string; directory?: string; kind?: string; status?: string }) => {
      const row: WorkspaceTestRow = {
        id: input.workspaceId ?? crypto.randomUUID(),
        org_id: input.org_id,
        project_id: input.workspaceId ?? crypto.randomUUID(),
        workspace_name: input.directory?.split("/").filter(Boolean).at(-1) ?? "workspace",
        directory: input.directory ?? "/workspace",
        kind: input.kind ?? "local",
        status: input.status,
        created_at: 1,
        updated_at: 1,
      }
      mocks.workspaceRows.set(row.id, row)
      mocks.workspaceRows.set(row.directory, row)
      return row
    },
  )
}

vi.mock("@claxedo/server-core/agent-config/index", () => ({
  loadUserConfig: mocks.loadUserConfig,
  sandboxDriverConfig: vi.fn((config?: { sandbox_driver?: unknown }) => config?.sandbox_driver ?? {}),
  saveUserConfig: mocks.saveUserConfig,
  setSandboxDriverConfig: vi.fn((config: { sandbox_driver?: unknown }, driverConfig: unknown) => {
    config.sandbox_driver = driverConfig
  }),
  defaultHarness: vi.fn(() => ({ type: "opencode" })),
  getRuntimeConfigSnapshot: vi.fn(async () => ({
    version: 1,
    mcp: {},
    runner: { type: "opencode" },
    auth: {},
  })),
  getEffectiveConfig: vi.fn(async () => ({})),
}))

vi.mock("@claxedo/server-core/credentials/registry", () => ({
  getCredentialByProvider: mocks.getCredentialByProvider,
  putCredential: mocks.putCredential,
  deleteCredentialsByProvider: mocks.deleteCredentialsByProvider,
}))

vi.mock("@claxedo/server-core/sandbox/network/policy", () => ({
  ensureHostForRepo: mocks.ensureHostForRepo,
}))

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: mocks.resolveWorkspace,
  workspaceIdFromDirectoryRef: (input: string | undefined) => {
    const value = input?.trim()
    return value && /^ws_[A-Za-z0-9_-]+$/.test(value) ? value : undefined
  },
  ensureWorkspace: mocks.ensureWorkspace,
  getWorkspaceByDirectory: vi.fn(async (directory: string) => mocks.workspaceRows.get(directory)),
  getWorkspace: vi.fn(async (id: string) => mocks.workspaceRows.get(id)),
  getProjectWorkspace: mocks.getProjectWorkspace,
  listWorkspaces: vi.fn(async () => [...new Set(mocks.workspaceRows.values())]),
  listProjects: mocks.listProjects,
  updateWorkspace: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const row = mocks.workspaceRows.get(id)
    if (!row) return undefined
    Object.assign(row, patch)
    return row
  }),
  bindWorkspace: vi.fn(async () => {}),
  deleteWorkspace: mocks.deleteWorkspace,
  deleteWorkspaceByDirectory: vi.fn(async (directory: string) => mocks.workspaceRows.delete(directory)),
}))

// Agent-extension sync reaches the supervisor through the composed port now,
// so the same spy is installed there. Mocking the module alone would leave the
// assertion below passing against a call nothing makes.
const { configureWorkspaceSupervisorPort } = await import("@claxedo/server-core/workspace/supervisor-port")
configureWorkspaceSupervisorPort({
  hold() {},
  release() {},
  markUse() {},
  touch() {},
  async broadcastRuntimeConfig() {},
  syncAgentExtensions: async (...args) => { await mocks.syncWorkspaceRuntimeAgentExtensions(...(args as unknown as [])) },
})

vi.mock("../../workspace/supervisor", () => ({
  discardSupervisorSandbox: mocks.discardSupervisorSandbox,
  ensureSupervisorSandbox: mocks.ensureSupervisorSandbox,
  getSupervisorSandboxStatus: mocks.getSupervisorSandboxStatus,
  verifyWorkspaceRuntimeControlToken: vi.fn(() => false),
  getSandbox: mocks.getSandbox,
  markSupervisorSandboxUse: mocks.markSupervisorSandboxUse,
  touchSupervisorSandbox: mocks.touchSupervisorSandbox,
  getSupervisorSandboxTarget: mocks.getSupervisorSandboxTarget,
  holdSupervisorSandbox: mocks.holdSupervisorSandbox,
  releaseSupervisorSandbox: mocks.releaseSupervisorSandbox,
  syncWorkspaceRuntimeAgentExtensions: mocks.syncWorkspaceRuntimeAgentExtensions,
  broadcastRuntimeConfig: mocks.broadcastRuntimeConfig,
  configureWorkspaceSupervisor: mocks.configureWorkspaceSupervisor,
  shutdownWorkspaceSupervisor: mocks.shutdownWorkspaceSupervisor,
  workspaceSupervisorServerUrl: vi.fn(() => "http://127.0.0.1:3001"),
  listSupervisorSandboxs: mocks.listSupervisorSandboxs,
}))

vi.mock("../../user-hosted-tunnel", () => ({
  startUserHostedWorkspaceTunnel: mocks.startUserHostedWorkspaceTunnel,
  stopUserHostedWorkspaceTunnel: mocks.stopUserHostedWorkspaceTunnel,
  stopAllUserHostedWorkspaceTunnels: mocks.stopAllUserHostedWorkspaceTunnels,
}))

const { localOnlyAuthAdapter } = await import("@claxedo/server-core/platform/auth/auth")
const { WorkspaceRoutes } = await import("./index")
const { createFixedWindowConnectionRateLimiter } = await import("../../platform/auth/rate-limit")

const acceptedSandboxProbe = (async () =>
  ({ ok: true, status: 200, text: async () => "", body: undefined }) as unknown as Response) as unknown as typeof fetch

function services(): ControlPlaneServices {
  return {
    projectionStore: {} as never,
    durableSessionLog: {} as never,
    auth: localOnlyAuthAdapter(),
    credentials: {
      listCredentials: vi.fn(async () => []),
      getCredentialByProvider: vi.fn(async (providerId) => ({
        id: `cred_${providerId}`,
        provider_id: providerId,
        kind: "sandbox_driver" as const,
        source: "managed" as const,
        secure_ref: "local:secret",
        status: "available" as const,
        created_at: 1,
        updated_at: 1,
      })),
      putCredential: vi.fn(async (input) => ({
        id: `cred_${input.driver_id}`,
        provider_id: input.driver_id,
        kind: input.kind,
        source: input.source,
        secure_ref: "local:secret",
        status: "available" as const,
        created_at: 1,
        updated_at: 1,
      })),
      deleteCredential: vi.fn(async () => true),
      deleteCredentialsByProvider: vi.fn(async () => 1),
      updateCredentialStatus: vi.fn(async () => {}),
      syncLocalCredentials: vi.fn(async () => ({ synced: [], existing: [], missing: [], failed: [] })),
    },
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
    authority: {
      usersMe: vi.fn(async () => ({
        actor_id: "actor_1",
        actor_kind: "human" as const,
        actor_public_id: "usr_public_1",
        actor_name: "Test User",
      })),
      listOrgs: vi.fn(async () => []),
      resolveOrgId: vi.fn(async () => "org_1" as never),
      authorizeSessionRead: vi.fn(async () => {}),
      authorizeSessionWrite: vi.fn(async () => {}),
      grantSessionParticipant: vi.fn(async () => ({ participant_id: "participant_1" })),
      revokeSessionParticipant: vi.fn(async () => ({ removed: true })),
      authorizeWorkspaceOpen: vi.fn(async () => {}),
      projectRole: vi.fn(async () => ({ ok: false as const })),
      authorizeProject: vi.fn(async () => ({ ok: false as const })),
      authorizeChannelProject: vi.fn(async () => ({ ok: false as const })),
      authorizeChannelWorkspace: vi.fn(async () => {}),
      bindChannelIdentity: vi.fn(async () => ({ bindingId: "chn_1", created: true, userId: "user_1", actorId: "user_1", actorKind: "human" as const })),
      revokeChannelIdentity: vi.fn(async () => ({ revoked: true })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: {
          workspace_id: "ws_1",
          org_id: "org_1",
          project_id: "project_1",
          backing: "cloud-vm" as const,
          access: "cloud" as const,
        },
      })),
      listWorkspaces: vi.fn(async () => [{ workspace_id: "ws_1", role: "owner" }]),
      registerLocalForSharing: vi.fn(async () => ({})),
      createHostEnrollmentRequest: vi.fn(async () => ({ request_id: "req_1", nonce: "nonce_1", expires_at: 60_000 })),
      enrollHost: vi.fn(async (_auth, input: { hostId: string }) => ({
        enrollment_id: "enr_1",
        host_id: input.hostId,
        expires_at: 60_000,
        last_seen_at: 1,
        created_at: 1,
      })),
      heartbeatHostEnrollment: vi.fn(async () => ({
        expires_at: 120_000,
        last_seen_at: 1,
        assigned_workspace_ids: [] as string[],
      })),
      pauseHostEnrollment: vi.fn(async () => ({ paused: true })),
      activeHostEnrollment: vi.fn(async () => ({ active: false as const, reason: "not-enrolled" as const })),
      markSecondDeviceOpen: vi.fn(async () => ({ recorded: true, second_device_open_at: 1 })),
      activeWorkspaceHost: vi.fn(async () => ({
        active: true,
        host_id: "host_1",
        workspace_id: "ws_1",
        expires_at: 60_000,
        last_seen_at: 1,
      })),
      assignWorkspaceHost: vi.fn(async (_auth, input: { workspaceId: string; hostId: string }) => ({
        assigned: true as const,
        workspace_id: input.workspaceId,
        host_id: input.hostId,
      })),
      unassignWorkspaceHost: vi.fn(async () => ({ unassigned: true })),
      listHostAssignments: vi.fn(async () => []),
      deleteWorkspace: vi.fn(async () => ({})),
      createCloudWorkspace: vi.fn(async () => ({})),
      grantWorkspaceShare: vi.fn(async () => ({})),
      revokeWorkspaceShare: vi.fn(async () => ({})),
      listSessions: vi.fn(async () => []),
      readSessionMessages: vi.fn(async () => ({ allowed: true, messages: [] })),
      syncSessionMessages: vi.fn(async () => ({})),
      upsertSessionVisibility: vi.fn(async () => ({})),
      replaceSessionVisibility: vi.fn(async () => ({})),
      deleteSessionVisibility: vi.fn(async () => ({})),
      recordRuntimeAccessToken: vi.fn(async () => ({})),
      recordRuntimeAccessTokenForService: vi.fn(async () => ({})),
      runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
      revokeRuntimeAccessToken: vi.fn(async () => ({})),
      revokeRuntimeAccessTokensForWorkspaceUser: vi.fn(async () => ({})),
      listWorkspaceAgentExtensions: vi.fn(async () => []),
      listWorkspaceAgentExtensionsForRuntime: vi.fn(async () => []),
      authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => {}),
      upsertWorkspaceAgentExtension: vi.fn(async () => ({})),
      setWorkspaceAgentExtensionEnabled: vi.fn(async () => ({})),
      deleteWorkspaceAgentExtension: vi.fn(async () => ({})),
      listAgentExtensionPolicyOverrides: vi.fn(async () => []),
      listAgentExtensionPolicyOverridesForRuntime: vi.fn(async () => []),
      setAgentExtensionPolicyOverride: vi.fn(async () => ({})),
      deleteAgentExtensionPolicyOverride: vi.fn(async () => ({})),
      auditDeny: vi.fn(async () => {}),
      auditAllow: vi.fn(async () => {}),
    },
  }
}

function readySandboxManager(hostId = "ws_1") {
  const ensure = vi.fn(async (workspaceId: string) => ({
    status: "ready" as const,
    workspaceId,
    sandboxId: hostId,
    url: `https://runtime.example.test/${workspaceId}`,
    hostId,
    epoch: 1,
    homeRegion: "us-east" as const,
  }))
  return {
    manager: { ensure } as never,
    ensure,
  }
}

const authConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})

describe("workspace routes signed control plane authority", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetWorkspaceStoreMocks()
    mocks.startUserHostedWorkspaceTunnel.mockResolvedValue({ url: "http://runtime/ws_local", reused: false })
    mocks.stopUserHostedWorkspaceTunnel.mockReturnValue(true)
    mocks.ensureWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      project_id: "project_1",
      project_name: "Demo",
      workspace_name: "signed-demo",
      directory: "/workspace",
      kind: "cloud",
      repo_url: "https://github.com/acme/demo.git",
      repo_name: "demo",
      git_branch: "main",
      driver: "daytona",
      status: "acquiring_sandbox",
      created_at: 1,
      updated_at: 1,
    })
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      org_id: "org_1",
      project_id: "project_1",
      workspace_name: "signed-demo",
      directory: "/workspace",
      kind: "cloud",
      driver: "daytona",
      status: "ready",
      created_at: 1,
      updated_at: 1,
    })
  })

  afterEach(() => {
    delete process.env.CLAXEDO_ENABLE_DOCKER_SANDBOX
    resetWorkspaceStoreMocks()
  })

  test("signed cloud create records Convex workspace metadata before provisioning", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    const verify = vi.fn(verifier)
    const app = WorkspaceRoutes(svc, { authConfig, verifier: verify })

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
        gitBranch: "main",
        workspaceName: "Signed Demo",
      }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      workspaceId: "ws_1",
      directory: "/workspace",
      access: "cloud",
      backing: {
        kind: "cloud-vm",
      },
    })
    expect(JSON.stringify(json)).not.toContain("/tmp/claxedo-workspace-route-test")
    expect(verify).toHaveBeenCalledWith("user_1", authConfig)
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_1", "control_plane.auth.signed", {
      issuer: "https://clerk.example.test",
    })
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
    )
    expect(svc.authority?.createCloudWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      expect.objectContaining({
        workspaceId: "ws_1",
        projectId: expect.stringMatching(/^ws_/),
        displayName: "signed-demo",
        repoUrl: "https://github.com/acme/demo.git",
        repoName: "demo",
        gitBranch: "main",
      }),
    )
    expect(sandbox.ensure).toHaveBeenCalledWith("ws_1", {
      homeRegion: "us-east",
      labels: {
        projectId: "project_1",
      },
      workspaceRoot: "/workspace",
      source: {
        kind: "git",
        repoUrl: "https://github.com/acme/demo.git",
        branch: "main",
      },
    })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_1", "workspace.cloud.create", {
      workspaceId: "ws_1",
      projectId: expect.stringMatching(/^ws_/),
      driver: "daytona",
      repoName: "demo",
      gitBranch: "main",
    })
  })

  test("signed mode refuses anonymous inventory list from a remote caller (H1)", async () => {
    const app = WorkspaceRoutes(services(), { authConfig, verifier })

    const res = await app.request("http://remote.attacker.example/")

    expect(res.status).toBe(401)
    expect(mocks.listProjects).not.toHaveBeenCalled()
  })

  test("tokenless loopback keeps the local inventory in signed mode", async () => {
    const app = WorkspaceRoutes(services(), { authConfig, verifier })

    const res = await app.request("http://localhost/")

    expect(res.status).toBe(200)
    expect(mocks.listProjects).toHaveBeenCalled()
  })

  test("signed mode refuses anonymous inventory list even with hosted access param from a remote caller", async () => {
    const app = WorkspaceRoutes(services(), { authConfig, verifier })

    const res = await app.request("http://remote.attacker.example/?access=Cloud")

    expect(res.status).toBe(401)
    expect(mocks.listProjects).not.toHaveBeenCalled()
  })

  test("signed mode refuses anonymous delete of a local workspace from a remote caller (H2)", async () => {
    mocks.workspaceRows.set("ws_local", {
      id: "ws_local",
      directory: "/tmp/local-checkout",
      kind: "local",
      status: "ready",
      created_at: 1,
      updated_at: 1,
    })
    const app = WorkspaceRoutes(services(), { authConfig, verifier })

    const res = await app.request("http://remote.attacker.example/ws_local", { method: "DELETE" })

    expect(res.status).toBe(401)
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled()
  })

  test("tokenless loopback can still delete a local workspace in signed mode", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce({
      id: "ws_loop",
      directory: "/tmp/loop-checkout",
      kind: "local",
      status: "ready",
      created_at: 1,
      updated_at: 1,
    })
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/ws_loop", { method: "DELETE" })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(mocks.deleteWorkspace).toHaveBeenCalledWith("ws_loop")
  })

  test("signed mode refuses anonymous provisioning create from a remote caller (H3)", async () => {
    const sandbox = readySandboxManager()
    const svc = services()
    svc.sandbox.sandboxManager = sandbox.manager
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://remote.attacker.example/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/acme/demo.git" }),
    })

    expect(res.status).toBe(401)
    expect(sandbox.ensure).not.toHaveBeenCalled()
    // Egress allowlist widening is part of the same unauthenticated surface.
    expect(mocks.ensureHostForRepo).not.toHaveBeenCalled()
  })

  test("signed mode refuses anonymous resolve of a workspace from a remote caller", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce({
      id: "ws_victim",
      directory: "/Users/me/top-secret",
      kind: "local",
      status: "ready",
      created_at: 1,
      updated_at: 1,
    })
    const app = WorkspaceRoutes(services(), { authConfig, verifier })

    const res = await app.request("http://remote.attacker.example/resolve?workspaceId=ws_victim")

    expect(res.status).toBe(401)
    // The row must not be materialized by an unauthenticated caller either
    // (create=true side effect).
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled()
  })

  test("signed mode refuses a remote caller whose bearer fails verification", async () => {
    const strictVerifier: ClerkVerifier = async (token) => {
      if (token !== "user_1") throw new ControlPlaneAuthError(401, "invalid_bearer_token", "invalid")
      return { mode: "signed" as const, user: { subject: token, tokenIdentifier: token, issuer: authConfig.issuer } }
    }
    const app = WorkspaceRoutes(services(), { authConfig, verifier: strictVerifier })

    const res = await app.request("http://remote.attacker.example/", {
      headers: { Authorization: "Bearer forged" },
    })

    expect(res.status).toBe(401)
    expect(mocks.listProjects).not.toHaveBeenCalled()
  })

  test("tokenless loopback create passes the gate and reaches driver validation", async () => {
    const sandbox = readySandboxManager()
    const svc = services()
    svc.sandbox.sandboxManager = sandbox.manager
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/acme/demo.git" }),
    })

    // Not 401: the tokenless loopback contract is preserved end-to-end. With
    // the composed mocks the create fully succeeds — provisioning included.
    expect(res.status).toBe(200)
    expect(sandbox.ensure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: { kind: "git", repoUrl: "https://github.com/acme/demo.git" } }),
    )
    expect(mocks.ensureHostForRepo).toHaveBeenCalledWith("https://github.com/acme/demo.git")
  })

  test("connection-backed cloud create keeps the token ephemeral and persists only the clean repository URL", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      connections: {
        repositoryForAuth: vi.fn(async () => ({
          ok: true as const,
          repository: {
            id: "1",
            name: "private-repo",
            fullName: "acme/private-repo",
            cloneUrl: "https://github.com/acme/private-repo.git",
            private: true,
            permissions: { read: true, write: false },
          },
          token: "github-secret",
        })),
      },
    })

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        connectionId: "connection-1",
        repo: { fullName: "acme/private-repo" },
        gitBranch: "main",
        workspaceName: "Private Repo",
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).not.toContain("github-secret")
    expect(mocks.ensureWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      repo_url: "https://github.com/acme/private-repo.git",
    }))
    expect(svc.authority?.createCloudWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repoUrl: "https://github.com/acme/private-repo.git" }),
    )
    expect(sandbox.ensure).toHaveBeenCalledWith("ws_1", expect.objectContaining({
      source: {
        kind: "git",
        repoUrl: "https://github.com/acme/private-repo.git",
        branch: "main",
      },
      secrets: [{
        name: "CLAXEDO_GITHUB_CLONE_AUTH",
        value: `Basic ${Buffer.from("x-access-token:github-secret").toString("base64")}`,
        hosts: ["github.com"],
        header: "Authorization",
      }],
    }))
    expect(JSON.stringify(mocks.ensureWorkspace.mock.calls)).not.toContain("github-secret")
  })

  test("signed cloud create provisions through SandboxManager when composed", async () => {
    const svc = services()
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "eu-west" }))
    svc.sandbox.sandboxManager = { ensure } as never
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      defaultHomeRegion: "eu-west",
    })

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
        gitBranch: "main",
        remoteDirectory: "/work/demo",
        workspaceName: "Signed Demo",
      }),
    })

    expect(res.status).toBe(200)
    expect(ensure).toHaveBeenCalledWith("ws_1", {
      homeRegion: "eu-west",
      labels: {
        projectId: "project_1",
      },
      workspaceRoot: "/work/demo",
      source: {
        kind: "git",
        repoUrl: "https://github.com/acme/demo.git",
        branch: "main",
      },
    })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
  })

  test("signed cloud create auto-adds SSH repo hosts while preserving the source URL for workspace-runtime", async () => {
    const svc = services()
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    svc.sandbox.sandboxManager = { ensure } as never
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repoUrl: "git@github.com:acme/demo.git",
        gitBranch: "main",
        workspaceName: "SSH Demo",
      }),
    })

    expect(res.status).toBe(200)
    expect(mocks.ensureHostForRepo).toHaveBeenCalledWith("git@github.com:acme/demo.git")
    expect(ensure).toHaveBeenCalledWith("ws_1", expect.objectContaining({
      source: {
        kind: "git",
        repoUrl: "git@github.com:acme/demo.git",
        branch: "main",
      },
    }))
  })

  test("signed cloud create cleans local row when SandboxManager provisioning rejects", async () => {
    const svc = services()
    svc.sandbox.sandboxManager = {
      ensure: vi.fn(async () => {
        throw new Error("driver failed")
      }),
    } as never
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
      }),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(res.status).toBe(200)
    expect(mocks.discardSupervisorSandbox).toHaveBeenCalledWith("ws_1", "provision_failed")
    expect(mocks.deleteWorkspace).toHaveBeenCalledWith("ws_1")
  })

  test("signed cloud create does not depend on telemetry availability", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    const capture = vi.fn(() => {
      throw new Error("telemetry down")
    })
    svc.telemetry = { capture }
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
        workspaceName: "Signed Demo",
      }),
    })

    expect(res.status).toBe(200)
    expect(sandbox.ensure).toHaveBeenCalledWith("ws_1", expect.objectContaining({
      homeRegion: "us-east",
      workspaceRoot: "/workspace",
    }))
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith("user_1", "control_plane.auth.signed", {
      issuer: "https://clerk.example.test",
    })
    expect(capture).toHaveBeenCalledWith(
      "user_1",
      "workspace.cloud.create",
      expect.objectContaining({
        workspaceId: "ws_1",
        driver: "daytona",
        repoName: "demo",
        gitBranch: "signed-demo",
      }),
    )
  })

  test("signed callers can list sandbox driver status without local secrets", async () => {
    const app = WorkspaceRoutes(services(), { authConfig, verifier })

    const res = await app.request("http://localhost/drivers", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      default_driver: "daytona",
      drivers: expect.arrayContaining([expect.objectContaining({ id: "daytona", label: "Daytona" })]),
    })
  })

  test("sandbox driver settings do not keep provider route or body aliases", async () => {
    const app = WorkspaceRoutes(services())

    const oldRoute = await app.request("http://127.0.0.1/providers")
    expect(oldRoute.status).toBe(404)

    const oldBody = await app.request("http://127.0.0.1/drivers/default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "daytona" }),
    })
    expect(oldBody.status).toBe(400)
    await expect(oldBody.json()).resolves.toEqual({
      error: {
        code: "sandbox_driver_unsupported",
        message: "Unsupported sandbox driver",
      },
    })
  })

  test("signed callers cannot mutate local sandbox driver settings", async () => {
    const app = WorkspaceRoutes(services(), { authConfig, verifier })

    for (const item of [
      {
        method: "PUT",
        path: "/drivers/default",
        body: { driver: "daytona" },
      },
      {
        method: "PUT",
        path: "/drivers/daytona/auth",
        body: { auth: { api_key: "secret" }, default: true },
      },
      {
        method: "DELETE",
        path: "/drivers/daytona/auth",
      },
    ]) {
      const res = await app.request(`https://app.example.test${item.path}`, {
        method: item.method,
        headers: {
          Authorization: "Bearer user_1",
          ...(item.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(item.body ? { body: JSON.stringify(item.body) } : {}),
      })
      expect(res.status).toBe(403)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "local_only_sandbox_driver",
          message:
            "Sandbox driver configuration is local-only and is not available through signed/team Control Plane access",
        },
      })
    }
    expect(mocks.saveUserConfig).not.toHaveBeenCalled()
    expect(mocks.putCredential).not.toHaveBeenCalled()
    expect(mocks.deleteCredentialsByProvider).not.toHaveBeenCalled()
  })

  test("local sandbox driver auth stores multi-field sandbox driver credentials as structured managed secrets", async () => {
    const svc = services()
    // Saving now probes the provider first; held at "accepted" so the subject
    // stays the stored encoding rather than the verdict (which
    // sandbox-driver-verify.test.ts owns). Without it this makes a real network
    // call with a fake token and is refused.
    const app = WorkspaceRoutes(svc, { fetch: acceptedSandboxProbe })

    const res = await app.request("http://127.0.0.1/drivers/vercel/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: {
          access_token: " vercel-token ",
          team_id: " team-id ",
          project_id: " project-id ",
        },
        default: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(svc.credentials.putCredential).toHaveBeenCalledWith({
      provider_id: "vercel",
      kind: "sandbox_driver",
      source: "managed",
      label: "Sandbox driver vercel",
      secret: JSON.stringify({
        access_token: "vercel-token",
        team_id: "team-id",
        project_id: "project-id",
      }),
    })
  })

  test("local sandbox driver auth does not store incomplete sandbox driver credentials", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc)

    const res = await app.request("http://127.0.0.1/drivers/cloudflare/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: {
          api_token: "cf-token",
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(svc.credentials.putCredential).not.toHaveBeenCalled()
  })

  test("unsigned local create does not require Convex authority", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    const app = WorkspaceRoutes(svc, {
      authConfig: {
        enabled: false,
        mode: "local-only",
        reason: "local",
      },
    })

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
      }),
    })

    expect(res.status).toBe(200)
    expect(svc.authority?.createCloudWorkspace).not.toHaveBeenCalled()
    expect(sandbox.ensure).toHaveBeenCalledWith("ws_1", expect.objectContaining({
      source: {
        kind: "git",
        repoUrl: "https://github.com/acme/demo.git",
      },
    }))
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
  })

  test("cloud create returns structured provisioning input errors", async () => {
    const svc = services()
    const getCredentialByProvider = vi.fn<() => Promise<CredentialMetadata | undefined>>(async () => undefined)
    const app = WorkspaceRoutes(svc, {
      authConfig: {
        enabled: false,
        mode: "local-only",
        reason: "local",
      },
      credentials: {
        ...svc.credentials,
        getCredentialByProvider,
      },
    })

    const unsupportedDriver = await app.request("http://localhost/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
        driver: "not-a-driver",
      }),
    })
    expect(unsupportedDriver.status).toBe(400)
    await expect(unsupportedDriver.json()).resolves.toEqual({
      error: {
        code: "sandbox_driver_unsupported",
        message: "Unsupported sandbox driver",
        driver: "not-a-driver",
      },
    })

    const unavailableDriver = await app.request("http://localhost/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
        driver: "docker",
      }),
    })
    expect(unavailableDriver.status).toBe(400)
    await expect(unavailableDriver.json()).resolves.toEqual({
      error: {
        code: "sandbox_driver_unavailable",
        message: "Sandbox driver is not available",
        driver: "docker",
      },
    })

    const missingCredentials = await app.request("http://localhost/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
        driver: "daytona",
      }),
    })
    expect(missingCredentials.status).toBe(400)
    await expect(missingCredentials.json()).resolves.toEqual({
      error: {
        code: "sandbox_driver_credentials_missing",
        message: "Missing daytona credentials",
        driver: "daytona",
      },
    })

    getCredentialByProvider.mockResolvedValueOnce({
      id: "cred_1",
      provider_id: "daytona",
      kind: "sandbox_driver",
      source: "managed",
      status: "available",
      created_at: 1,
      updated_at: 1,
    })
    const missingSource = await app.request("http://localhost/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ driver: "daytona" }),
    })
    expect(missingSource.status).toBe(400)
    await expect(missingSource.json()).resolves.toEqual({
      error: {
        code: "cloud_workspace_source_required",
        message: "repoUrl or projectId is required",
      },
    })

    getCredentialByProvider.mockResolvedValueOnce({
      id: "cred_2",
      provider_id: "daytona",
      kind: "sandbox_driver",
      source: "managed",
      status: "available",
      created_at: 1,
      updated_at: 1,
    })
    const missingManager = await app.request("http://localhost/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/acme/demo.git",
        driver: "daytona",
      }),
    })
    expect(missingManager.status).toBe(503)
    await expect(missingManager.json()).resolves.toEqual({
      error: {
        code: "sandbox_driver_unavailable",
        message: "No cloud sandbox driver is configured on this control plane",
      },
    })
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled()
    expect(mocks.ensureHostForRepo).not.toHaveBeenCalled()
    expect(getCredentialByProvider).toHaveBeenCalledTimes(3)
  })

  test("docker cloud create can start from a project without a remote URL", async () => {
    process.env.CLAXEDO_ENABLE_DOCKER_SANDBOX = "1"
    const svc = services()
    const sandbox = readySandboxManager("ws_docker")
    svc.sandbox.sandboxManager = sandbox.manager
    const app = WorkspaceRoutes(svc, {
      authConfig: {
        enabled: false,
        mode: "local-only",
        reason: "local",
      },
    })
    mocks.getProjectWorkspace.mockResolvedValueOnce({
      id: "project_local_only",
      project_id: "project_local_only",
      directory: "/tmp/no-remote",
      kind: "local",
      created_at: 1,
      updated_at: 1,
    })
    mocks.ensureWorkspace.mockImplementationOnce(
      async (input: {
        workspaceId?: string
        directory?: string
        kind?: string
        status?: string
        driver?: string
        repo_url?: string
      }) => {
        const row: WorkspaceTestRow = {
          id: input.workspaceId ?? "ws_docker",
          project_id: "project_local_only",
          workspace_name: "docker-dev",
          directory: input.directory ?? "/workspace",
          kind: input.kind ?? "cloud",
          driver: input.driver,
          repo_url: input.repo_url,
          status: input.status,
          created_at: 1,
          updated_at: 1,
        }
        mocks.workspaceRows.set(row.id, row)
        mocks.workspaceRows.set(row.directory, row)
        return row
      },
    )

    const res = await app.request("http://localhost/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project_local_only",
        workspaceName: "docker-dev",
        driver: "docker",
      }),
    })

    expect(res.status).toBe(200)
    expect(mocks.ensureWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        driver: "docker",
        repo_url: undefined,
        workspace_name: "docker-dev",
      }),
    )
    expect(sandbox.ensure).toHaveBeenCalledWith(expect.stringMatching(/^ws_/), expect.objectContaining({
      source: { kind: "empty" },
      workspaceRoot: "/workspace",
    }))
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
  })

  test("the unauthenticated POST /ensure route is gone (it could boot billable runtimes)", async () => {
    const app = WorkspaceRoutes(services(), {
      authConfig: {
        enabled: false,
        mode: "local-only",
        reason: "local",
      },
    })

    const res = await app.request("http://localhost/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_1" }),
    })

    expect(res.status).toBe(404)
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
  })

  test("unsigned local-worktree local access resolves directly without Convex or Workspace Relay", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce({
      id: "ws_local",
      project_id: "project_1",
      workspace_name: "Local Main",
      directory: "/tmp/local-main",
      kind: "local",
      repo_name: "local-main",
      git_branch: "dev",
      created_at: 1,
      updated_at: 1,
    })
    const svc = services()
    const app = WorkspaceRoutes(svc, {
      authConfig: {
        enabled: false,
        mode: "local-only",
        reason: "local",
      },
    })

    const res = await app.request("http://localhost/resolve?workspaceId=ws_local")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_local",
      kind: "local",
      directory: "/tmp/local-main",
    })
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(svc.authority?.authorizeWorkspaceOpen).not.toHaveBeenCalled()
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
  })

  test("signed local-worktree local access stays direct and does not mint relay tokens", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce({
      id: "ws_local",
      project_id: "project_1",
      workspace_name: "Local Main",
      directory: "/tmp/local-main",
      kind: "local",
      repo_name: "local-main",
      git_branch: "dev",
      created_at: 1,
      updated_at: 1,
    })
    const svc = services()
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_unexpected",
      tokenExpiresAt: 123,
      jti: "jti_unexpected",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/resolve?workspaceId=ws_local", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_local",
      kind: "local",
      directory: "/tmp/local-main",
    })
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(svc.authority?.authorizeWorkspaceOpen).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
    expect(signer).not.toHaveBeenCalled()
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
  })

  test("signed directory resolve prefers user-hosted authority without consulting the local store", async () => {
    const svc = services()
    svc.authority!.listWorkspaces = vi.fn(async () => [{
      workspace_id: "ws_shared",
      remote_directory: "/tmp/local-alias",
    }])
    svc.authority!.openWorkspace = vi.fn(async () => ({
      allowed: true,
      role: "editor",
      workspace: {
        workspace_id: "ws_shared",
        project_id: "proj_shared",
        backing: "local-worktree" as const,
        access: "user-hosted" as const,
        display_name: "Shared workspace",
        repo_name: "opencode",
        git_branch: "dev",
      },
    }))
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/resolve?directory=%2Ftmp%2Flocal-alias", {
      headers: {
        Authorization: "Bearer user_2",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_shared",
      projectId: "proj_shared",
      kind: "user-hosted",
      access: "user-hosted",
      backing: {
        kind: "user-hosted",
        branch: "dev",
      },
    })
    expect(svc.authority?.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_2" }),
      { workspaceId: "ws_shared" },
    )
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled()
  })

  test("signed directory resolve cannot create a local alias when authority has no match", async () => {
    const svc = services()
    svc.authority!.listWorkspaces = vi.fn(async () => [])
    mocks.resolveWorkspace.mockResolvedValueOnce(undefined)
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/resolve?directory=%2Fworkspace%2Fmissing&create=true", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({
      error: { code: "workspace_not_found", message: "Workspace not found" },
    })
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({
      workspaceId: undefined,
      directory: "/workspace/missing",
      create: false,
    })
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled()
  })

  test("unsigned directory resolve preserves local create semantics", async () => {
    mocks.resolveWorkspace.mockImplementationOnce(async (input: { directory?: string; create?: boolean }) =>
      input.create
        ? {
            id: "ws_local_created",
            project_id: "project_local_created",
            workspace_name: "created",
            directory: input.directory ?? "/workspace/created",
            kind: "local",
            created_at: 1,
            updated_at: 1,
          }
        : undefined)
    const app = WorkspaceRoutes(services(), {
      authConfig: { enabled: false, mode: "local-only", reason: "local" },
    })

    const res = await app.request("http://localhost/resolve?directory=%2Fworkspace%2Fcreated&create=true")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_local_created",
      directory: "/workspace/created",
      kind: "local",
    })
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({
      workspaceId: undefined,
      directory: "/workspace/created",
      create: true,
    })
  })

  test("signed cloud resolve checks Convex workspace open authority", async () => {
    const svc = services()
    const verify = vi.fn(verifier)
    const app = WorkspaceRoutes(svc, { authConfig, verifier: verify })

    const res = await app.request("http://localhost/resolve?workspaceId=ws_1", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_1",
      directory: "/workspace",
      access: "cloud",
      backing: {
        kind: "cloud-vm",
      },
    })
    expect(verify).toHaveBeenCalledWith("user_1", authConfig)
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
    )
    expect(svc.authority?.authorizeWorkspaceOpen).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      { workspaceId: "ws_1" },
    )
  })

  test("signed hosted resolve can open an authority workspace by remote directory", async () => {
    const svc = services()
    mocks.resolveWorkspace.mockResolvedValue(undefined)
    svc.authority!.listWorkspaces = vi.fn(async () => [
      {
        workspace_id: "ws_hosted",
        project_id: "proj_hosted",
        access: "cloud",
        backing: "cloud-vm",
        remote_directory: "/workspace/hosted",
        display_name: "Hosted workspace",
        repo_name: "opencode",
        git_branch: "dev",
      },
    ])
    svc.authority!.openWorkspace = vi.fn(async () => ({
      allowed: true,
      role: "editor",
      workspace: {
        workspace_id: "ws_hosted",
        project_id: "proj_hosted",
        access: "cloud",
        backing: "cloud-vm",
        remote_directory: "/workspace/hosted",
        display_name: "Hosted workspace",
        repo_name: "opencode",
        git_branch: "dev",
      },
    }))
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request(`http://localhost/resolve?directory=${encodeURIComponent("/workspace/hosted")}`, {
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_hosted",
      projectId: "proj_hosted",
      directory: "/workspace/hosted",
      status: "ready",
      kind: "cloud",
      access: "cloud",
      backing: {
        kind: "cloud-vm",
        repoName: "opencode",
        branch: "dev",
      },
    })
    expect(svc.authority?.listWorkspaces).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
    )
    expect(svc.authority?.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      { workspaceId: "ws_hosted" },
    )
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled()
  })

  test("signed directory resolve rejects a runtime path shared by multiple workspaces", async () => {
    const svc = services()
    svc.authority!.listWorkspaces = vi.fn(async () => [
      { workspace_id: "ws_cloud_a", access: "cloud", backing: "cloud-vm", remote_directory: "/workspace" },
      { workspace_id: "ws_cloud_b", access: "cloud", backing: "cloud-vm", remote_directory: "/workspace" },
    ])
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/resolve?directory=%2Fworkspace", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "workspace_directory_ambiguous",
        message: "Multiple workspaces use this runtime directory; resolve with a canonical workspaceId",
      },
    })
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled()
  })

  test("signed raw workspace-id directory refs open canonical authority when the local store misses", async () => {
    const svc = services()
    mocks.resolveWorkspace.mockResolvedValueOnce(undefined)
    svc.authority!.openWorkspace = vi.fn(async () => ({
      allowed: true,
      role: "owner",
      workspace: {
        workspace_id: "ws_signed",
        project_id: "proj_signed",
        access: "cloud",
        backing: "cloud-vm",
        remote_directory: "/workspace/signed",
      },
    }))
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/resolve?directory=ws_signed", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_signed",
      directory: "/workspace/signed",
      kind: "cloud",
    })
    expect(svc.authority?.listWorkspaces).not.toHaveBeenCalled()
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({
      workspaceId: "ws_signed",
      directory: undefined,
      create: false,
    })
    expect(svc.authority?.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      { workspaceId: "ws_signed" },
    )
  })

  test("signed workspace open is rate limited before Convex open authority", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    })

    const first = await app.request("http://localhost/resolve?workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })
    const second = await app.request("http://localhost/resolve?workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    await expect(second.json()).resolves.toEqual({
      error: {
        code: "control_plane_rate_limited",
        message: "Control Plane request limit exceeded",
        retryAfterMs: 60_000,
      },
    })
    expect(svc.authority?.authorizeWorkspaceOpen).toHaveBeenCalledTimes(1)
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        action: "workspaces.open.denied",
        reason: "control_plane_rate_limited",
        workspaceId: "ws_1",
        metadata: {
          retryAfterMs: 60_000,
        },
      },
    )
  })

  test("signed missing workspace ids resolve through Convex authority", async () => {
    const svc = services()
    mocks.resolveWorkspace.mockResolvedValue(undefined)
    svc.authority!.openWorkspace = vi.fn(async () => ({
      allowed: true,
      role: "editor",
      workspace: {
        workspace_id: "ws_shared",
        project_id: "proj_shared",
        backing: "local-worktree" as const,
        access: "user-hosted" as const,
        display_name: "Shared workspace",
        repo_name: "opencode",
        git_branch: "dev",
        repo_url: "https://github.com/acme/opencode.git",
      },
    }))
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/resolve?workspaceId=ws_shared", {
      headers: {
        Authorization: "Bearer user_2",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      workspaceId: "ws_shared",
      projectId: "proj_shared",
      directory: "/workspace",
      workspaceName: "Shared workspace",
      kind: "user-hosted",
      access: "user-hosted",
      backing: {
        kind: "user-hosted",
        branch: "dev",
        workspaceName: "Shared workspace",
      },
      driver: null,
      status: "ready",
      git: {
        repo: "opencode",
        branch: "dev",
        remote: "https://github.com/acme/opencode.git",
      },
    })
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_2" }),
    )
    expect(svc.authority?.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_2" }),
      { workspaceId: "ws_shared" },
    )
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_shared" }))
  })

  test("unsigned workspace ids resolve through the local workspace store", async () => {
    mocks.resolveWorkspace.mockImplementation(async (input: { workspaceId?: string; directory?: string }) => {
      expect(input.workspaceId).toBe("ws_local_image_codex")
      return {
        id: "ws_local_image_codex",
        project_id: "project_1",
        workspace_name: "Local image",
        directory: "/workspace",
        remote_directory: "/workspace",
        kind: "cloud",
        driver: "local-image",
        status: "ready",
        created_at: 1,
        updated_at: 1,
      }
    })
    const svc = services()
    const app = WorkspaceRoutes(svc, {
      authConfig: {
        enabled: false,
        mode: "local-only",
        reason: "local",
      },
    })

    const res = await app.request("http://localhost/resolve?workspaceId=ws_local_image_codex")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_local_image_codex",
      directory: "/workspace",
      kind: "cloud",
      status: "ready",
      backing: {
        kind: "cloud-vm",
        remoteDirectory: "/workspace",
      },
    })
  })

  test("directory refs are not treated as workspace identity", async () => {
    const directory = ["workspace", "ws_local_image_codex"].join(":")
    mocks.resolveWorkspace.mockResolvedValue(undefined)
    const svc = services()
    const app = WorkspaceRoutes(svc, {
      authConfig: {
        enabled: false,
        mode: "local-only",
        reason: "local",
      },
    })

    const res = await app.request(`http://localhost/resolve?directory=${encodeURIComponent(directory)}`)

    expect(res.status).toBe(404)
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: undefined,
        directory,
      }),
    )
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
  })

  test("raw workspace id refs in directory resolve as workspace identity", async () => {
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_local_image_codex",
      project_id: "project_1",
      directory: "/workspace",
      remote_directory: "/workspace",
      kind: "cloud",
      driver: "daytona",
      status: "ready",
      created_at: 1,
      updated_at: 1,
    })
    const svc = services()
    const app = WorkspaceRoutes(svc, {
      authConfig: {
        enabled: false,
        mode: "local-only",
        reason: "local",
      },
    })

    const res = await app.request("http://localhost/resolve?directory=ws_local_image_codex")

    expect(res.status).toBe(200)
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_local_image_codex",
        directory: undefined,
      }),
    )
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_local_image_codex",
      directory: "/workspace",
      kind: "cloud",
      status: "ready",
    })
  })

  test("signed cloud list reads Convex workspace discovery without changing local list default", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const signed = await app.request("http://localhost/?access=cloud", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(signed.status).toBe(200)
    await expect(signed.json()).resolves.toEqual({
      workspaces: [{ workspace_id: "ws_1", role: "owner" }],
    })
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
    )
    expect(svc.authority?.listWorkspaces).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
    )

    const local = await app.request("http://localhost/")
    expect(local.status).toBe(200)
    expect(svc.authority?.listWorkspaces).toHaveBeenCalledTimes(1)
    expect(mocks.listProjects).toHaveBeenCalled()
  })

  test("signed workspace list is rate limited before Convex list", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    })

    const first = await app.request("http://localhost/?access=cloud", {
      headers: { Authorization: "Bearer user_1" },
    })
    const second = await app.request("http://localhost/?access=cloud", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    await expect(second.json()).resolves.toEqual({
      error: {
        code: "control_plane_rate_limited",
        message: "Control Plane request limit exceeded",
        retryAfterMs: 60_000,
      },
    })
    expect(svc.authority?.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  test("signed user-hosted list reads Convex shared workspaces instead of local projects", async () => {
    const svc = services()
    svc.authority!.listWorkspaces = vi.fn(async () => [
      {
        workspace_id: "ws_cloud",
        backing: "cloud-vm",
        access: "cloud",
        role: "editor",
      },
      {
        workspace_id: "ws_shared",
        backing: "local-worktree",
        access: "user-hosted",
        role: "viewer",
        // Reachability travels with the row: the rail says "viewer · host
        // offline" before any pane opens the workspace, so the route must not
        // project the authority's host state away.
        host_online: false,
      },
    ])
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/?access=user-hosted", {
      headers: {
        Authorization: "Bearer user_2",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      workspaces: [
        {
          workspace_id: "ws_shared",
          backing: "local-worktree",
          access: "user-hosted",
          role: "viewer",
          host_online: false,
        },
      ],
    })
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_2" }),
    )
    expect(svc.authority?.listWorkspaces).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_2" }),
    )
    expect(mocks.listProjects).not.toHaveBeenCalled()
  })

  test("signed cloud connection mints and records a Runtime Access Token lazily", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    svc.authority!.listWorkspaceAgentExtensions = vi.fn(async () => [
      {
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 1,
          updated_at: 1,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          manifest_digests: { package: "abc" },
          component_digests: { package: "abc" },
          targets: ["cursor"],
        },
      },
    ])
    svc.authority!.listAgentExtensionPolicyOverrides = vi.fn(async () => [
      {
        id: "review",
        scope: "user" as const,
        enabled: false,
        reason: "disabled by user",
      },
    ])
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_123",
      tokenExpiresAt: 123_000,
      jti: "jti_1",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_1/connection", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      access: "cloud",
      backing: "cloud-vm",
      // The stream scope the sandbox's runtime composition serves — a client
      // cannot discover it, so the mint states it.
      sessionAuthority: "managed-private",
      workspaceId: "ws_1",
      hostId: "ws_1",
      relayUrl: "https://relay.example.test",
      runtimeAccessToken: "rat_123",
      tokenExpiresAt: 123_000,
      role: "owner",
    })
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
    )
    expect(svc.authority?.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      { workspaceId: "ws_1" },
    )
    expect(svc.authority?.authorizeWorkspaceOpen).not.toHaveBeenCalled()
    expect(sandbox.ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "us-east" })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(signer).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      actorPublicId: "usr_public_1",
      actorName: "Test User",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "ws_1",
      role: "owner",
    })
    expect(svc.authority?.recordRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        jti: "jti_1",
        workspaceId: "ws_1",
        hostId: "ws_1",
        actorId: "actor_1",
        actorKind: "human",
        role: "owner",
        expiresAt: 123_000,
      },
    )
    expect(svc.authority?.auditAllow).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        action: "runtime_access_token.minted",
        workspaceId: "ws_1",
        metadata: {
          jti: "jti_1",
          hostId: "ws_1",
          expiresAt: 123_000,
        },
      },
    )
    expect(mocks.syncWorkspaceRuntimeAgentExtensions).toHaveBeenCalledWith(
      "ws_1",
      [
        expect.objectContaining({
          desired: expect.objectContaining({ id: "review" }),
        }),
      ],
      {
        policyOverrides: [
          {
            id: "review",
            scope: "user",
            enabled: false,
            reason: "disabled by user",
          },
        ],
      },
    )
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_1", "control_plane.auth.signed", {
      issuer: "https://clerk.example.test",
    })
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_1", "runtime_access_token.minted", {
      workspaceId: "ws_1",
      access: "cloud",
      backing: "cloud-vm",
      hostId: "ws_1",
      role: "owner",
      jti: "jti_1",
      expiresAt: 123_000,
    })
  })

  test("signed cloud connection uses SandboxManager sandbox target when composed", async () => {
    const svc = services()
    const ensure = vi.fn(async () => ({
      status: "ready" as const,
      workspaceId: "ws_1",
      sandboxId: "sandbox_manager",
      url: "https://runtime-manager.test/ws_1",
      hostId: "host_manager",
      epoch: 4,
      homeRegion: "us-east" as const,
    }))
    svc.sandbox.sandboxManager = { ensure } as never
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_manager",
      tokenExpiresAt: 123_000,
      jti: "jti_manager",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_1/connection", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      workspaceId: "ws_1",
      hostId: "host_manager",
    })
    expect(ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "us-east" })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(signer).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      actorPublicId: "usr_public_1",
      actorName: "Test User",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_manager",
      role: "owner",
    })
    expect(svc.authority?.recordRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        jti: "jti_manager",
        workspaceId: "ws_1",
        hostId: "host_manager",
        actorId: "actor_1",
        actorKind: "human",
        role: "owner",
        expiresAt: 123_000,
      },
    )
  })

  test("signed cloud connection waits when SandboxManager is still provisioning", async () => {
    const svc = services()
    const ensure = vi.fn(async () => ({
      status: "provisioning" as const,
      retryAfterMs: 2_000,
      epoch: 2,
      homeRegion: "us-east" as const,
    }))
    svc.sandbox.sandboxManager = { ensure } as never
    const signer = vi.fn()
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_1/connection", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      status: "provisioning",
      workspaceId: "ws_1",
      runtimeKind: "cloud",
      retryAfterMs: 2_000,
    })
    expect(signer).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
  })

  test("signed cloud connection requires bearer auth outside loopback", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("https://app.example.test/ws_1/connection")

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "missing_bearer_token",
        message: "Authorization: Bearer token is required",
      },
    })
    expect(svc.telemetry.capture).toHaveBeenCalledWith("local", "control_plane.auth.denied", {
      code: "missing_bearer_token",
      status: 401,
    })
  })

  test("loopback cloud connection opens local Relay-compatible Docker runtime without bearer auth", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "http://relay.test",
    })

    const res = await app.request("http://localhost/ws_1/connection")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      access: "cloud",
      backing: "cloud-vm",
      // A loopback caller of the local server is served by its own EMBEDDED
      // workspace runtime, which composes the unbound local policy.
      sessionAuthority: "local",
      workspaceId: "ws_1",
      hostId: "ws_1",
      relayUrl: "http://relay.test",
      runtimeAccessToken: "local-loopback-ws_1",
      role: "owner",
    })
    expect(sandbox.ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "us-east" })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
  })

  test("loopback cloud connection uses SandboxManager host identity when composed", async () => {
    const svc = services()
    const ensure = vi.fn(async () => ({
      status: "ready" as const,
      workspaceId: "ws_1",
      sandboxId: "sandbox_manager",
      url: "https://runtime-manager.test/ws_1",
      hostId: "host_manager",
      epoch: 4,
      homeRegion: "us-east" as const,
    }))
    svc.sandbox.sandboxManager = { ensure } as never
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_loopback_manager",
      tokenExpiresAt: 123_000,
      jti: "jti_loopback_manager",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "http://relay.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_1/connection")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      access: "cloud",
      backing: "cloud-vm",
      workspaceId: "ws_1",
      hostId: "host_manager",
      relayUrl: "http://relay.test",
      runtimeAccessToken: "rat_loopback_manager",
      role: "owner",
    })
    expect(ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "us-east" })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(signer).toHaveBeenCalledWith({
      principalKind: "service",
      actorId: "control-plane",
      actorKind: "agent",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_manager",
      role: "owner",
    })
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
  })

  test("loopback cloud connection falls back to local token when signer exists but workspace has no org", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_should_not_be_needed",
      tokenExpiresAt: 123_000,
      jti: "jti_should_not_be_needed",
    }))
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      directory: "/workspace",
      kind: "cloud",
      created_at: 1,
      updated_at: 1,
    })
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "http://relay.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_1/connection")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      access: "cloud",
      backing: "cloud-vm",
      workspaceId: "ws_1",
      relayUrl: "http://relay.test",
      runtimeAccessToken: "local-loopback-ws_1",
      role: "owner",
    })
    expect(signer).not.toHaveBeenCalled()
  })

  test("loopback cloud connection falls back to local Relay-compatible origin when no relay is configured", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    mocks.resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      directory: "/workspace",
      kind: "cloud",
      created_at: 1,
      updated_at: 1,
    })
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
    })

    const res = await app.request("http://localhost/ws_1/connection")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      access: "cloud",
      backing: "cloud-vm",
      // A loopback caller of the local server is served by its own EMBEDDED
      // workspace runtime, which composes the unbound local policy.
      sessionAuthority: "local",
      workspaceId: "ws_1",
      hostId: "ws_1",
      relayUrl: "http://localhost",
      runtimeAccessToken: "local-loopback-ws_1",
      role: "owner",
    })
    expect(sandbox.ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "us-east" })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(svc.authority?.openWorkspace).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
  })

  test("loopback cloud connection with bearer auth stays on signed control-plane path", async () => {
    const svc = services()
    const sandbox = readySandboxManager()
    svc.sandbox.sandboxManager = sandbox.manager
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "http://127.0.0.1:7777",
    })

    const res = await app.request("http://localhost/ws_1/connection", {
      headers: {
        Authorization: "Bearer user_other",
      },
    })

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_signer_unavailable",
        message: "Runtime Access Token signer is not configured",
      },
    })
    expect(sandbox.ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "us-east" })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(svc.authority?.usersMe).toHaveBeenCalled()
    expect(svc.authority?.openWorkspace).toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
  })

  test("signed cloud connection rejects denied workspace authorization before minting a Runtime Access Token", async () => {
    const svc = services()
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_123",
      tokenExpiresAt: 123_000,
      jti: "jti_1",
    }))
    svc.authority!.openWorkspace = vi.fn(async () => ({ allowed: false }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_1/connection", {
      headers: {
        Authorization: "Bearer user_other",
      },
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "workspace_access_denied",
        message: "Workspace access denied",
      },
    })
    expect(mocks.ensureSupervisorSandbox).not.toHaveBeenCalled()
    expect(signer).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(expect.objectContaining({ token: "user_other" }), {
      action: "workspaces.open.denied",
      reason: "workspace_authorization_denied",
      workspaceId: "ws_1",
      metadata: undefined,
    })
  })

  test("signed user-hosted connection opens Convex-visible shared local workspace without local store row", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(undefined)
    const svc = services()
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_user_hosted",
      tokenExpiresAt: 789_000,
      jti: "jti_user_hosted",
    }))
    svc.authority!.openWorkspace = vi.fn(async () => ({
      allowed: true,
      role: "editor",
      workspace: {
        workspace_id: "ws_shared",
        backing: "local-worktree" as const,
        access: "user-hosted" as const,
      },
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_shared/connection", {
      headers: {
        Authorization: "Bearer user_2",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      access: "user-hosted",
      backing: "local-worktree",
      runtimeKind: "user-hosted",
      // The owner's own daemon composes the unbound local policy, so it serves
      // the WORKSPACE-WIDE event streams as well as session-scoped ones.
      sessionAuthority: "local",
      workspaceId: "ws_shared",
      homeRegion: "us-east",
      relayUrl: "https://relay.example.test",
      runtimeAccessToken: "rat_user_hosted",
      tokenExpiresAt: 789_000,
      role: "editor",
    })
    expect(svc.authority?.openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ token: "user_2" }), {
      workspaceId: "ws_shared",
    })
    expect(signer).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      actorPublicId: "usr_public_1",
      actorName: "Test User",
      orgId: "org_1",
      workspaceId: "ws_shared",
      hostId: "host_1",
      role: "editor",
    })
    expect(svc.authority?.recordRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_2" }),
      {
        jti: "jti_user_hosted",
        workspaceId: "ws_shared",
        hostId: "host_1",
        actorId: "actor_1",
        actorKind: "human",
        role: "editor",
        expiresAt: 789_000,
      },
    )
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_2", "runtime_access_token.minted", {
      workspaceId: "ws_shared",
      access: "user-hosted",
      backing: "local-worktree",
      hostId: "host_1",
      role: "editor",
      jti: "jti_user_hosted",
      expiresAt: 789_000,
      hostLeaseExpiresAt: 60_000,
      relayRoom: "ws_shared",
      relayUrl: "https://relay.example.test",
    })
  })

  test("signed user-hosted connection rejects denied shared workspace authorization before host lookup", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(undefined)
    const svc = services()
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_user_hosted",
      tokenExpiresAt: 789_000,
      jti: "jti_user_hosted",
    }))
    svc.authority!.openWorkspace = vi.fn(async () => ({ allowed: false }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_shared/connection", {
      headers: {
        Authorization: "Bearer user_other",
      },
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "workspace_access_denied",
        message: "Workspace access denied",
      },
    })
    expect(svc.authority?.activeWorkspaceHost).not.toHaveBeenCalled()
    expect(signer).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(expect.objectContaining({ token: "user_other" }), {
      action: "workspaces.open.denied",
      reason: "workspace_authorization_denied",
      workspaceId: "ws_shared",
      metadata: undefined,
    })
  })

  test("signed user-hosted connection refresh rejects inactive previous Runtime Access Tokens", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(undefined)
    const svc = services()
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_user_hosted",
      tokenExpiresAt: 789_000,
      jti: "jti_user_hosted",
    }))
    svc.authority!.openWorkspace = vi.fn(async () => ({
      allowed: true,
      role: "editor",
      workspace: {
        workspace_id: "ws_shared",
        backing: "local-worktree" as const,
        access: "user-hosted" as const,
      },
    }))
    svc.authority!.runtimeAccessTokenActive = vi.fn(async () => ({
      active: false,
      code: "runtime_access_token_workspace_mismatch",
      reason: "Runtime Access Token does not match host",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_shared/connection/refresh", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        previousJti: "jti_bad",
      }),
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_workspace_mismatch",
        message: "Runtime Access Token does not match host",
      },
    })
    expect(svc.authority?.runtimeAccessTokenActive).toHaveBeenCalledWith({
      jti: "jti_bad",
      workspaceId: "ws_shared",
      hostId: "host_1",
    })
    expect(signer).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
    expect(svc.authority?.revokeRuntimeAccessToken).not.toHaveBeenCalled()
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(expect.objectContaining({ token: "user_2" }), {
      action: "runtime_access_token.refresh.denied",
      reason: "runtime_access_token_workspace_mismatch",
      workspaceId: "ws_shared",
      metadata: {
        jti: "jti_bad",
        hostId: "host_1",
      },
    })
  })

  test("signed user-hosted connection fails closed when Local Host Link is offline or paused", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(undefined)
    const svc = services()
    svc.authority!.openWorkspace = vi.fn(async () => ({
      allowed: true,
      role: "viewer",
      workspace: {
        workspace_id: "ws_shared",
        backing: "local-worktree" as const,
        access: "user-hosted" as const,
      },
    }))
    svc.authority!.activeWorkspaceHost = vi.fn(async () => ({ active: false as const }))
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_user_hosted",
      tokenExpiresAt: 789_000,
      jti: "jti_user_hosted",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_shared/connection", {
      headers: {
        Authorization: "Bearer user_2",
      },
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "user_hosted_workspace_unavailable",
        message: "User-hosted sandbox is unavailable",
      },
    })
    expect(signer).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(expect.objectContaining({ token: "user_2" }), {
      action: "runtime_access_token.denied",
      reason: "workspace_host_unavailable",
      workspaceId: "ws_shared",
    })
  })

  test("signed cloud connection rate limits Runtime Access Token minting per user and workspace", async () => {
    const svc = services()
    svc.sandbox.sandboxManager = readySandboxManager().manager
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_123",
      tokenExpiresAt: 123_000,
      jti: "jti_1",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
      connectionRateLimiter: createFixedWindowConnectionRateLimiter({
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    })

    const first = await app.request("http://localhost/ws_1/connection", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })
    const second = await app.request("http://localhost/ws_1/connection", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    await expect(second.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_rate_limited",
        message: "Workspace connection token limit exceeded",
        retryAfterMs: 60_000,
      },
    })
    expect(signer).toHaveBeenCalledTimes(1)
    expect(svc.authority?.recordRuntimeAccessToken).toHaveBeenCalledTimes(1)
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        action: "runtime_access_token.denied",
        reason: "runtime_access_token_rate_limited",
        workspaceId: "ws_1",
        metadata: {
          retryAfterMs: 60_000,
        },
      },
    )
  })

  test("signed cloud connection refresh records the new token and revokes the previous JTI", async () => {
    const svc = services()
    svc.sandbox.sandboxManager = readySandboxManager().manager
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_456",
      tokenExpiresAt: 456_000,
      jti: "jti_2",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_1/connection/refresh", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        previousJti: "jti_1",
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      access: "cloud",
      backing: "cloud-vm",
      // The stream scope the sandbox's runtime composition serves — a client
      // cannot discover it, so the mint states it.
      sessionAuthority: "managed-private",
      workspaceId: "ws_1",
      hostId: "ws_1",
      relayUrl: "https://relay.example.test",
      runtimeAccessToken: "rat_456",
      tokenExpiresAt: 456_000,
      role: "owner",
    })
    expect(signer).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      actorPublicId: "usr_public_1",
      actorName: "Test User",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "ws_1",
      role: "owner",
    })
    expect(svc.authority?.recordRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        jti: "jti_2",
        workspaceId: "ws_1",
        hostId: "ws_1",
        actorId: "actor_1",
        actorKind: "human",
        role: "owner",
        expiresAt: 456_000,
      },
    )
    expect(svc.authority?.runtimeAccessTokenActive).toHaveBeenCalledWith({
      jti: "jti_1",
      workspaceId: "ws_1",
      hostId: "ws_1",
    })
    expect(svc.authority?.revokeRuntimeAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        jti: "jti_1",
        workspaceId: "ws_1",
      },
    )
  })

  test("signed cloud connection refresh rejects inactive previous Runtime Access Tokens", async () => {
    const svc = services()
    svc.sandbox.sandboxManager = readySandboxManager().manager
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_456",
      tokenExpiresAt: 456_000,
      jti: "jti_2",
    }))
    svc.authority!.runtimeAccessTokenActive = vi.fn(async () => ({
      active: false,
      code: "runtime_access_token_revoked",
      reason: "Runtime Access Token has been revoked",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
    })

    const res = await app.request("http://localhost/ws_1/connection/refresh", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        previousJti: "jti_revoked",
      }),
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "runtime_access_token_revoked",
        message: "Runtime Access Token has been revoked",
      },
    })
    expect(svc.authority?.runtimeAccessTokenActive).toHaveBeenCalledWith({
      jti: "jti_revoked",
      workspaceId: "ws_1",
      hostId: "ws_1",
    })
    expect(signer).not.toHaveBeenCalled()
    expect(svc.authority?.recordRuntimeAccessToken).not.toHaveBeenCalled()
    expect(svc.authority?.revokeRuntimeAccessToken).not.toHaveBeenCalled()
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        action: "runtime_access_token.refresh.denied",
        reason: "runtime_access_token_revoked",
        workspaceId: "ws_1",
        metadata: {
          jti: "jti_revoked",
          hostId: "ws_1",
        },
      },
    )
  })

  test("signed cloud connection refresh shares the same per user and workspace rate limit", async () => {
    const svc = services()
    svc.sandbox.sandboxManager = readySandboxManager().manager
    const signer = vi.fn(async () => ({
      runtimeAccessToken: "rat_456",
      tokenExpiresAt: 456_000,
      jti: "jti_2",
    }))
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      relayUrl: "https://relay.example.test",
      runtimeAccessTokenSigner: signer,
      connectionRateLimiter: createFixedWindowConnectionRateLimiter({
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    })

    const first = await app.request("http://localhost/ws_1/connection", {
      headers: {
        Authorization: "Bearer user_1",
      },
    })
    const refresh = await app.request("http://localhost/ws_1/connection/refresh", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        previousJti: "jti_1",
      }),
    })

    expect(first.status).toBe(200)
    expect(refresh.status).toBe(429)
    expect(signer).toHaveBeenCalledTimes(1)
    expect(svc.authority?.revokeRuntimeAccessToken).not.toHaveBeenCalled()
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        action: "runtime_access_token.denied",
        reason: "runtime_access_token_rate_limited",
        workspaceId: "ws_1",
        metadata: {
          retryAfterMs: 60_000,
        },
      },
    )
  })

  function localWorkspaceRow() {
    return {
      id: "ws_local",
      project_id: "project_1",
      project_name: "Local Project",
      workspace_name: "Local Main",
      directory: "/tmp/local",
      kind: "local",
      repo_url: "https://github.com/acme/local.git",
      repo_name: "local",
      git_branch: "dev",
      created_at: 1,
      updated_at: 1,
    }
  }

  function hostAssignments() {
    return {
      assignWorkspace: vi.fn(async (_auth: unknown, share: { workspaceId: string }) => ({
        assignment: { assigned: true as const, workspace_id: share.workspaceId, host_id: "host_machine" },
        hostTunnel: {
          hostTunnelToken: "htt_1",
          tokenExpiresAt: 456_000,
          jti: "htt_jti_1",
          relayUrl: "http://relay.test",
        },
      })),
      unassignWorkspace: vi.fn(async () => ({ unassigned: true })),
    }
  }

  test("signed local workspace share assigns this machine through the assignment service", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(localWorkspaceRow())
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, { authConfig, verifier, hostAssignments: assignments })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Yash's MacBook",
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      assignment: {
        assigned: true,
        workspace_id: "ws_local",
        host_id: "host_machine",
      },
      hostTunnel: {
        hostTunnelToken: "htt_1",
        tokenExpiresAt: 456_000,
        jti: "htt_jti_1",
        relayUrl: "http://relay.test",
      },
    })
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }))
    // The share carries the OWNER's workspace facts; the machine identity is
    // server-owned inside the assignment service.
    expect(assignments.assignWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      {
        workspaceId: "ws_local",
        displayName: "Yash's MacBook",
        projectId: "project_1",
        repoUrl: "https://github.com/acme/local.git",
        repoName: "local",
        gitBranch: "dev",
      },
    )
    expect(svc.authority?.auditAllow).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      action: "host_workspace_assignment.assigned",
      workspaceId: "ws_local",
      metadata: {
        hostId: "host_machine",
      },
    })
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_1", "host_workspace_assignment.assigned", {
      workspaceId: "ws_local",
      hostId: "host_machine",
    })
  })

  test("signed local workspace share defaults the display name from the workspace row", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(localWorkspaceRow())
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, { authConfig, verifier, hostAssignments: assignments })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    expect(assignments.assignWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      expect.objectContaining({
        workspaceId: "ws_local",
        displayName: "Local Main",
      }),
    )
  })

  test("unsigned local workspace share is refused without signed auth", async () => {
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, {
      authConfig: { enabled: false, mode: "local-only", reason: "local dev" },
      verifier,
      hostAssignments: assignments,
    })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "missing_bearer_token",
        message: "Authorization: Bearer token is required",
      },
    })
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled()
    expect(assignments.assignWorkspace).not.toHaveBeenCalled()
  })

  test("signed local workspace share rejects caller-supplied host identity", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(localWorkspaceRow())
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, { authConfig, verifier, hostAssignments: assignments })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hostId: "host_local",
      }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "host_assignment_identity_server_owned",
        message: "Host assignment machine identity is server-owned",
      },
    })
    expect(assignments.assignWorkspace).not.toHaveBeenCalled()
  })

  test("signed local workspace share requires a local workspace", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce({
      ...localWorkspaceRow(),
      kind: "cloud",
    })
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, { authConfig, verifier, hostAssignments: assignments })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "host_assignment_local_workspace_required",
        message: "Only local workspaces can be assigned for user-hosted sharing",
      },
    })
    expect(assignments.assignWorkspace).not.toHaveBeenCalled()
  })

  test("signed local workspace share answers 404 for an unknown workspace", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(undefined)
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, { authConfig, verifier, hostAssignments: assignments })

    const res = await app.request("http://localhost/ws_missing/host-assignment", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(404)
    expect(assignments.assignWorkspace).not.toHaveBeenCalled()
  })

  test("signed local workspace share answers 501 without an assignment service", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(localWorkspaceRow())
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(501)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "not_implemented",
        message: "This deployment does not support host assignments",
      },
    })
  })

  test("an unacked share surfaces the control-plane failure and skips the audit trail", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce(localWorkspaceRow())
    const svc = services()
    const assignments = hostAssignments()
    assignments.assignWorkspace = vi.fn(async () => {
      throw new ControlPlaneAuthError(
        503,
        "workspace_authority_unavailable",
        "The workspace assignment was not acknowledged by the control plane",
      )
    }) as never
    const app = WorkspaceRoutes(svc, { authConfig, verifier, hostAssignments: assignments })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "workspace_authority_unavailable",
        message: "The workspace assignment was not acknowledged by the control plane",
      },
    })
    expect(svc.authority?.auditAllow).not.toHaveBeenCalled()
    expect(svc.telemetry.capture).not.toHaveBeenCalledWith(
      "user_1",
      "host_workspace_assignment.assigned",
      expect.anything(),
    )
  })

  test("signed local workspace share is rate limited per workspace before delegation", async () => {
    mocks.resolveWorkspace.mockResolvedValue(localWorkspaceRow())
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, {
      authConfig,
      verifier,
      hostAssignments: assignments,
      controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({
        limit: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    })

    const request = () => app.request("http://localhost/ws_local/host-assignment", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
    const first = await request()
    const second = await request()

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    await expect(second.json()).resolves.toEqual({
      error: {
        code: "control_plane_rate_limited",
        message: "Control Plane request limit exceeded",
        retryAfterMs: 60_000,
      },
    })
    expect(assignments.assignWorkspace).toHaveBeenCalledTimes(1)
    expect(svc.authority?.auditDeny).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "signed", token: "user_1" }),
      {
        action: "host_workspace_assignment.assign.denied",
        reason: "control_plane_rate_limited",
        workspaceId: "ws_local",
        metadata: {
          retryAfterMs: 60_000,
        },
      },
    )
    mocks.resolveWorkspace.mockReset()
  })

  test("signed local workspace unshare unassigns through the assignment service and audits", async () => {
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, { authConfig, verifier, hostAssignments: assignments })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ unassigned: true })
    expect(assignments.unassignWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      "ws_local",
    )
    expect(svc.authority?.auditAllow).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      action: "host_workspace_assignment.unassigned",
      workspaceId: "ws_local",
      metadata: {},
    })
  })

  test("unsigned local workspace unshare is refused without signed auth", async () => {
    const svc = services()
    const assignments = hostAssignments()
    const app = WorkspaceRoutes(svc, {
      authConfig: { enabled: false, mode: "local-only", reason: "local dev" },
      verifier,
      hostAssignments: assignments,
    })

    const res = await app.request("http://localhost/ws_local/host-assignment", {
      method: "DELETE",
    })

    expect(res.status).toBe(401)
    expect(assignments.unassignWorkspace).not.toHaveBeenCalled()
  })

  test("unsigned local workspace delete remains local-only", async () => {
    mocks.resolveWorkspace.mockResolvedValueOnce({
      id: "ws_local",
      project_id: "project_local",
      workspace_name: "local-demo",
      directory: "/tmp/claxedo-workspace-route-test/local/ws_local",
      kind: "local",
      status: "ready",
      created_at: 1,
      updated_at: 1,
    })
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/ws_local", {
      method: "DELETE",
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(svc.authority?.deleteWorkspace).not.toHaveBeenCalled()
    expect(mocks.discardSupervisorSandbox).toHaveBeenCalledWith("ws_local", "workspace_deleted")
    expect(mocks.deleteWorkspace).toHaveBeenCalledWith("ws_local")
  })

  test("unsigned cloud workspace delete without cloud access remains local-only", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/ws_1", {
      method: "DELETE",
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(svc.authority?.deleteWorkspace).not.toHaveBeenCalled()
    expect(mocks.discardSupervisorSandbox).toHaveBeenCalledWith("ws_1", "workspace_deleted")
    expect(mocks.deleteWorkspace).toHaveBeenCalledWith("ws_1")
  })

  test("unsigned cloud access workspace delete requires signed Control Plane auth", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/ws_1?access=cloud", {
      method: "DELETE",
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "missing_bearer_token",
      },
    })
    expect(svc.authority?.usersMe).not.toHaveBeenCalled()
    expect(svc.authority?.deleteWorkspace).not.toHaveBeenCalled()
    expect(mocks.discardSupervisorSandbox).not.toHaveBeenCalled()
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled()
  })

  test("signed cloud workspace delete delegates authority before local cleanup", async () => {
    const svc = services()
    const destroy = vi.fn(async () => ({ ok: true as const, status: "destroyed" as const }))
    const release = vi.fn(async () => ({ released: true }))
    svc.sandbox.sandboxManager = { destroy, release } as never
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const res = await app.request("http://localhost/ws_1", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(svc.authority?.usersMe).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }))
    expect(svc.authority?.deleteWorkspace).toHaveBeenCalledWith(expect.objectContaining({ token: "user_1" }), {
      workspaceId: "ws_1",
    })
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_1", "workspace.delete", {
      workspaceId: "ws_1",
      access: "cloud",
      backing: "cloud-vm",
    })
    expect(destroy).toHaveBeenCalledWith("ws_1")
    expect(release).toHaveBeenCalledWith("ws_1")
    expect(mocks.discardSupervisorSandbox).toHaveBeenCalledWith("ws_1", "workspace_deleted")
    expect(mocks.deleteWorkspace).toHaveBeenCalledWith("ws_1")
  })

  test("signed workspace share grant and revoke delegate to Convex authority", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const grant = await app.request("http://localhost/ws_1/shares", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "viewer",
        target: { kind: "actor", actorId: "actor_2" },
      }),
    })
    const revoke = await app.request("http://localhost/ws_1/shares", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target: { kind: "actor", actorId: "actor_2" },
      }),
    })

    expect(grant.status).toBe(200)
    expect(revoke.status).toBe(200)
    expect(svc.authority?.grantWorkspaceShare).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      {
        workspaceId: "ws_1",
        role: "viewer",
        target: { kind: "actor", actorId: "actor_2" },
      },
    )
    expect(svc.authority?.revokeWorkspaceShare).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      {
        workspaceId: "ws_1",
        target: { kind: "actor", actorId: "actor_2" },
      },
    )
  })

  test("signed workspace share mutations reject oversized bodies before parsing", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })
    const response = await app.request("http://localhost/ws_1/shares", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
        "Content-Length": String(17 * 1024),
      },
      body: JSON.stringify({ role: "viewer", grantedToClerkSubject: "x".repeat(17 * 1024) }),
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_body_too_large" } })
    expect(svc.authority?.grantWorkspaceShare).not.toHaveBeenCalled()
  })

  test("signed workspace share grant and revoke accept provider-neutral org targets", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const grant = await app.request("http://localhost/ws_1/shares", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "viewer",
        target: { kind: "org", orgId: "org_1" },
      }),
    })
    const revoke = await app.request("http://localhost/ws_1/shares", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target: { kind: "org", orgId: "org_1" },
      }),
    })

    expect(grant.status).toBe(200)
    expect(revoke.status).toBe(200)
    expect(svc.authority?.grantWorkspaceShare).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      {
        workspaceId: "ws_1",
        role: "viewer",
        target: { kind: "org", orgId: "org_1" },
      },
    )
    expect(svc.authority?.revokeWorkspaceShare).toHaveBeenCalledWith(
      expect.objectContaining({ token: "user_1" }),
      {
        workspaceId: "ws_1",
        target: { kind: "org", orgId: "org_1" },
      },
    )
  })

  test("signed workspace share mutations reject legacy flat targets and ambiguous canonical targets", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const grant = await app.request("http://localhost/ws_1/shares", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "viewer",
        grantedToSubject: "user_2",
        grantedToOrgId: "org_1",
      }),
    })
    const revoke = await app.request("http://localhost/ws_1/shares", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grantId: "grant_1",
        target: { kind: "actor", actorId: "actor_2" },
      }),
    })

    expect(grant.status).toBe(400)
    expect(revoke.status).toBe(400)
    await expect(grant.json()).resolves.toEqual({
      error: {
        code: "workspace_share_target_invalid",
        message: "Share target is invalid",
      },
    })
    await expect(revoke.json()).resolves.toEqual({
      error: {
        code: "workspace_share_target_ambiguous",
        message: "Share revoke target must be exactly one grant or canonical target",
      },
    })
    expect(svc.authority?.grantWorkspaceShare).not.toHaveBeenCalled()
    expect(svc.authority?.revokeWorkspaceShare).not.toHaveBeenCalled()
  })

  test("signed workspace share mutations require a structured target", async () => {
    const svc = services()
    const app = WorkspaceRoutes(svc, { authConfig, verifier })

    const grant = await app.request("http://localhost/ws_1/shares", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "viewer" }),
    })
    const revoke = await app.request("http://localhost/ws_1/shares", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
    const blank = await app.request("http://localhost/ws_1/shares", {
      method: "POST",
      headers: {
        Authorization: "Bearer user_1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "viewer", target: { kind: "actor", actorId: "   " } }),
    })

    for (const res of [grant, revoke]) {
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "workspace_share_target_required",
          message: "Share target is required",
        },
      })
    }
    expect(blank.status).toBe(400)
    await expect(blank.json()).resolves.toEqual({
      error: {
        code: "workspace_share_target_invalid",
        message: "Share target is invalid",
      },
    })
    expect(svc.authority?.grantWorkspaceShare).not.toHaveBeenCalled()
    expect(svc.authority?.revokeWorkspaceShare).not.toHaveBeenCalled()
  })
})
