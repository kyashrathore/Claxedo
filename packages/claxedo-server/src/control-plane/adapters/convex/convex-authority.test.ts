import { afterEach, describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "../../auth"
import { convexAuthorityUrlFromEnv, createConvexAuthority } from "./convex-authority"

const auth: SignedControlPlaneAuth = {
  mode: "signed",
  token: "tok_123",
  user: {
    subject: "user_1",
    tokenIdentifier: "https://clerk.example.test|user_1",
    issuer: "https://clerk.example.test",
  },
}

const prevServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

describe("convex authority url from env", () => {
  test("reads the neutral env name", () => {
    expect(convexAuthorityUrlFromEnv({
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://authority.example.test",
    })).toBe("https://authority.example.test")
  })

  test("ignores the retired legacy Convex aliases", () => {
    expect(convexAuthorityUrlFromEnv({
      CONVEX_URL: "https://legacy.convex.test",
      CLAXEDO_CONVEX_URL: "https://legacy-claxedo.convex.test",
    })).toBeUndefined()
  })

  test("treats blank values as unset", () => {
    expect(convexAuthorityUrlFromEnv({})).toBeUndefined()
    expect(convexAuthorityUrlFromEnv({
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "   ",
    })).toBeUndefined()
  })
})

describe("convex authority", () => {
  afterEach(() => {
    if (prevServiceToken === undefined) {
      delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      return
    }
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevServiceToken
  })

  test("upserts the signed user through a Convex mutation", async () => {
    const mutation = vi.fn(async () => ({ user_id: "user_doc_1" }))
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(),
        mutation,
      },
    })

    await authority.usersMe(auth)

    expect(mutation).toHaveBeenCalledWith(expect.anything(), {})
  })

  test("requires Convex config when no executor is injected", async () => {
    const authority = createConvexAuthority({ url: "" })

    await expect(authority.authorizeSessionRead(auth, {
      sessionId: "session-1",
      workspaceId: "ws_1",
    })).rejects.toMatchObject({
      status: 503,
      code: "workspace_authority_unavailable",
    } satisfies Partial<ControlPlaneAuthError>)
  })

  test("authorizes session reads through the Convex sessions function", async () => {
    const query = vi.fn(async () => ({ allowed: true }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation: vi.fn(),
      },
    })

    await authority.authorizeSessionRead(auth, {
      sessionId: "session-1",
      workspaceId: "ws_1",
    })

    expect(query).toHaveBeenCalledWith(expect.anything(), {
      session_id: "session-1",
      workspace_id: "ws_1",
    })
  })

  test("turns Convex denials into uniform authorization errors", async () => {
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(async () => ({ allowed: false })),
        mutation: vi.fn(),
      },
    })

    await expect(authority.authorizeSessionRead(auth, {
      sessionId: "session-1",
      workspaceId: "ws_1",
    })).rejects.toMatchObject({
      status: 403,
      code: "workspace_authorization_denied",
    } satisfies Partial<ControlPlaneAuthError>)
  })

  test("creates signed cloud workspace metadata through Convex", async () => {
    const mutation = vi.fn(async () => ({ workspace_doc_id: "doc_1" }))
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(),
        mutation,
      },
    })

    await authority.createCloudWorkspace(auth, {
      workspaceId: "ws_1",
      projectId: "project_1",
      displayName: "Demo",
      repoUrl: "https://github.com/acme/demo.git",
      repoName: "demo",
      gitBranch: "main",
    })

    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_1",
      project_id: "project_1",
      display_name: "Demo",
      repo_url: "https://github.com/acme/demo.git",
      repo_name: "demo",
      git_branch: "main",
    })
  })

  test("lists signed cloud workspaces through Convex", async () => {
    const query = vi.fn(async () => [{ workspace_id: "ws_1" }])
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation: vi.fn(),
      },
    })

    await expect(authority.listWorkspaces(auth)).resolves.toEqual([{ workspace_id: "ws_1" }])
    expect(query).toHaveBeenCalledWith(expect.anything(), {})
  })

  test("opens a workspace through Convex and returns the authorized metadata", async () => {
    const query = vi.fn(async () => ({
      allowed: true,
      role: "viewer",
      workspace: {
        workspace_id: "ws_shared",
        backing: "local-worktree",
        access: "user-hosted",
      },
    }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation: vi.fn(),
      },
    })

    await expect(authority.openWorkspace(auth, { workspaceId: "ws_shared" })).resolves.toEqual({
      allowed: true,
      role: "viewer",
      workspace: {
        workspace_id: "ws_shared",
        backing: "local-worktree",
        access: "user-hosted",
      },
    })
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_shared",
    })
  })

  test("resolves the signed org through Convex", async () => {
    const mutation = vi.fn(async () => ({ org_id: "org_doc_1" }))
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(),
        mutation,
      },
    })

    await expect(authority.resolveOrgId({
      ...auth,
      user: {
        ...auth.user,
        orgId: "org_clerk_1",
      },
    })).resolves.toBe("org_doc_1")

    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      clerk_org_id: "org_clerk_1",
    })
  })

  test("authorizes projects through Convex", async () => {
    const query = vi.fn(async () => ({
      ok: true,
      role: "editor",
      orgId: "org_doc_1",
    }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation: vi.fn(),
      },
    })

    await expect(authority.authorizeProject(auth, {
      projectId: "project_1" as never,
      action: "read",
    })).resolves.toEqual({
      ok: true,
      role: "editor",
      orgId: "org_doc_1",
    })
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      project_id: "project_1",
      action: "read",
    })
  })

  test("registers user-hosted local workspace metadata through Convex", async () => {
    const mutation = vi.fn(async () => ({ workspace_doc_id: "doc_1" }))
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(),
        mutation,
      },
    })

    await authority.registerLocalForSharing(auth, {
      workspaceId: "ws_local",
      displayName: "Local Demo",
      projectId: "project_1",
      repoName: "demo",
    })

    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_local",
      display_name: "Local Demo",
      project_id: "project_1",
      repo_name: "demo",
    })
  })

  test("registers, heartbeats, pauses, and reads Local Host Link presence through Convex", async () => {
    const query = vi.fn(async () => ({
      active: true,
      host_id: "host_1",
      workspace_id: "ws_local",
      expires_at: 123,
      last_seen_at: 10,
    }))
    const mutation = vi.fn(async () => ({ ok: true }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation,
      },
    })

    await authority.createLocalHostLinkChallenge(auth, {
      workspaceId: "ws_local",
      hostId: "host_1",
    })
    await authority.registerLocalHostLink(auth, {
      workspaceId: "ws_local",
      hostId: "host_1",
      publicKey: "public-key",
      challengeId: "challenge_1",
      signature: "signature_1",
      displayName: "Yash's MacBook",
      ttlMs: 90_000,
    })
    await authority.heartbeatLocalHostLink(auth, {
      workspaceId: "ws_local",
      hostId: "host_1",
      signature: "signature_2",
      ttlMs: 60_000,
    })
    await authority.pauseLocalHostLink(auth, {
      workspaceId: "ws_local",
      hostId: "host_1",
      paused: true,
    })
    await expect(authority.activeLocalHostLink(auth, {
      workspaceId: "ws_local",
    })).resolves.toMatchObject({
      active: true,
      host_id: "host_1",
    })

    expect(mutation).toHaveBeenNthCalledWith(1, expect.anything(), {
      workspace_id: "ws_local",
      host_id: "host_1",
    })
    expect(mutation).toHaveBeenNthCalledWith(2, expect.anything(), {
      workspace_id: "ws_local",
      host_id: "host_1",
      public_key: "public-key",
      challenge_id: "challenge_1",
      signature: "signature_1",
      display_name: "Yash's MacBook",
      ttl_ms: 90_000,
    })
    expect(mutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      workspace_id: "ws_local",
      host_id: "host_1",
      signature: "signature_2",
      ttl_ms: 60_000,
    })
    expect(mutation).toHaveBeenNthCalledWith(4, expect.anything(), {
      workspace_id: "ws_local",
      host_id: "host_1",
      paused: true,
    })
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_local",
    })
  })

  test("grants and revokes workspace shares through Convex", async () => {
    const mutation = vi.fn(async () => ({ ok: true }))
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(),
        mutation,
      },
    })

    await authority.grantWorkspaceShare(auth, {
      workspaceId: "ws_1",
      role: "editor",
      grantedToClerkSubject: "user_2",
    })
    await authority.revokeWorkspaceShare(auth, {
      workspaceId: "ws_1",
      grantedToClerkSubject: "user_2",
    })

    expect(mutation).toHaveBeenNthCalledWith(1, expect.anything(), {
      workspace_id: "ws_1",
      role: "editor",
      granted_to_clerk_subject: "user_2",
    })
    expect(mutation).toHaveBeenNthCalledWith(2, expect.anything(), {
      workspace_id: "ws_1",
      granted_to_clerk_subject: "user_2",
    })
  })

  test("lists, reads, and syncs session history through Convex", async () => {
    const query = vi.fn(async () => ({ allowed: true, messages: [] }))
    const mutation = vi.fn(async () => ({ ok: true }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation,
      },
    })

    await authority.listSessions(auth, { workspaceId: "ws_1" })
    await authority.readSessionMessages(auth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })
    await authority.syncSessionMessages(auth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
      messages: [{
        info: { id: "msg-1", role: "user" },
        parts: [{ type: "text", text: "hello" }],
      }],
    })

    expect(query).toHaveBeenNthCalledWith(1, expect.anything(), {
      workspace_id: "ws_1",
    })
    expect(query).toHaveBeenNthCalledWith(2, expect.anything(), {
      workspace_id: "ws_1",
      session_id: "session-1",
    })
    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_1",
      session_id: "session-1",
      messages: [{
        info: { id: "msg-1", role: "user" },
        parts: [{ type: "text", text: "hello" }],
      }],
    })
  })

  test("writes session history visibility through Convex mutations", async () => {
    const mutation = vi.fn(async () => ({ ok: true }))
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(),
        mutation,
      },
    })

    await authority.upsertSessionVisibility(auth, {
      workspaceId: "ws_1",
      sessions: [{
        sessionId: "session-1",
        title: "Demo Session",
        createdAt: 10,
        updatedAt: 20,
      }],
    })
    await authority.replaceSessionVisibility(auth, {
      workspaceId: "ws_1",
      sessions: [{
        sessionId: "session-2",
      }],
    })
    await authority.deleteSessionVisibility(auth, {
      workspaceId: "ws_1",
      sessionId: "session-1",
    })

    expect(mutation).toHaveBeenNthCalledWith(1, expect.anything(), {
      workspace_id: "ws_1",
      sessions: [{
        session_id: "session-1",
        title: "Demo Session",
        created_at: 10,
        updated_at: 20,
      }],
    })
    expect(mutation).toHaveBeenNthCalledWith(2, expect.anything(), {
      workspace_id: "ws_1",
      sessions: [{
        session_id: "session-2",
      }],
    })
    expect(mutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      workspace_id: "ws_1",
      session_id: "session-1",
    })
  })

  test("records, checks, and revokes runtime access tokens through Convex", async () => {
    const query = vi.fn(async () => ({ active: true }))
    const mutation = vi.fn(async () => ({ ok: true }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation,
      },
    })

    await authority.recordRuntimeAccessToken(auth, {
      jti: "jti_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      expiresAt: 123,
    })
    await expect(authority.runtimeAccessTokenActive({
      jti: "jti_1",
      workspaceId: "ws_1",
      hostId: "host_1",
    })).resolves.toEqual({ active: true })
    await authority.revokeRuntimeAccessToken(auth, {
      jti: "jti_1",
      workspaceId: "ws_1",
    })
    await authority.revokeRuntimeAccessTokensForWorkspaceUser(auth, {
      workspaceId: "ws_1",
    })
    await authority.auditAllow(auth, {
      action: "runtime_access_token.minted",
      workspaceId: "ws_1",
      metadata: {
        jti: "jti_1",
      },
    })

    expect(mutation).toHaveBeenNthCalledWith(1, expect.anything(), {
      jti: "jti_1",
      workspace_id: "ws_1",
      host_id: "host_1",
      expires_at: 123,
    })
    expect(query).toHaveBeenCalledWith(expect.anything(), {
      jti: "jti_1",
      workspace_id: "ws_1",
      host_id: "host_1",
    })
    expect(mutation).toHaveBeenNthCalledWith(2, expect.anything(), {
      jti: "jti_1",
      workspace_id: "ws_1",
    })
    expect(mutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      workspace_id: "ws_1",
    })
    expect(mutation).toHaveBeenNthCalledWith(4, expect.anything(), {
      action: "runtime_access_token.minted",
      result: "allow",
      workspace_id: "ws_1",
      metadata: {
        jti: "jti_1",
      },
    })
  })

  test("stores workspace Agent Extension desired installs through Convex", async () => {
    const query = vi.fn(async () => [{ desired: { id: "review" }, lock: { resolved_sha: "abc" } }])
    const mutation = vi.fn(async () => ({ ok: true }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation,
      },
    })

    await expect(authority.listWorkspaceAgentExtensions(auth, {
      workspaceId: "ws_1",
    })).resolves.toEqual([{ desired: { id: "review" }, lock: { resolved_sha: "abc" } }])
    await authority.upsertWorkspaceAgentExtension(auth, {
      workspaceId: "ws_1",
      extensionId: "review",
      packageName: "review",
      desired: { id: "review", enabled: true },
      lock: { resolved_sha: "abc" },
    })
    await authority.setWorkspaceAgentExtensionEnabled(auth, {
      workspaceId: "ws_1",
      extensionId: "review",
      enabled: false,
    })
    await authority.deleteWorkspaceAgentExtension(auth, {
      workspaceId: "ws_1",
      extensionId: "review",
    })

    expect(query).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_1",
    })
    expect(mutation).toHaveBeenNthCalledWith(1, expect.anything(), {
      workspace_id: "ws_1",
      extension_id: "review",
      package_name: "review",
      desired: { id: "review", enabled: true },
      lock: { resolved_sha: "abc" },
    })
    expect(mutation).toHaveBeenNthCalledWith(2, expect.anything(), {
      workspace_id: "ws_1",
      extension_id: "review",
      enabled: false,
    })
    expect(mutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      workspace_id: "ws_1",
      extension_id: "review",
    })
  })

  test("preflights workspace Agent Extension admin authority through Convex", async () => {
    const query = vi.fn(async () => ({ allowed: true }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation: vi.fn(),
      },
    })

    await authority.authorizeWorkspaceAgentExtensionsAdmin(auth, {
      workspaceId: "ws_1",
    })

    expect(query).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_1",
    })
  })

  test("hydrates workspace Agent Extensions for runtime through service auth", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    const query = vi.fn(async () => [{ desired: { id: "review" }, lock: { resolved_sha: "abc" } }])
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation: vi.fn(),
      },
    })

    await expect(authority.listWorkspaceAgentExtensionsForRuntime({
      workspaceId: "ws_1",
    })).resolves.toEqual([{ desired: { id: "review" }, lock: { resolved_sha: "abc" } }])

    expect(query).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_1",
      service_token: "svc_secret",
    })
  })

  test("stores Agent Extension policy overrides through Convex", async () => {
    const query = vi.fn(async () => [{ id: "review", scope: "org", enabled: false, reason: "blocked" }])
    const mutation = vi.fn(async () => ({ ok: true }))
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation,
      },
    })

    await expect(authority.listAgentExtensionPolicyOverrides(auth, {
      workspaceId: "ws_1",
    })).resolves.toEqual([{ id: "review", scope: "org", enabled: false, reason: "blocked" }])
    await authority.setAgentExtensionPolicyOverride(auth, {
      workspaceId: "ws_1",
      extensionId: "review",
      scope: "org",
      enabled: false,
      reason: "blocked",
    })
    await authority.deleteAgentExtensionPolicyOverride(auth, {
      workspaceId: "ws_1",
      extensionId: "review",
      scope: "org",
    })

    expect(query).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_1",
    })
    expect(mutation).toHaveBeenNthCalledWith(1, expect.anything(), {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "org",
      enabled: false,
      reason: "blocked",
    })
    expect(mutation).toHaveBeenNthCalledWith(2, expect.anything(), {
      workspace_id: "ws_1",
      extension_id: "review",
      scope: "org",
    })
  })

  test("hydrates Agent Extension policy overrides for runtime through service auth", async () => {
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "svc_secret"
    const query = vi.fn(async () => [{ id: "review", scope: "workspace", enabled: false }])
    const authority = createConvexAuthority({
      executor: {
        query,
        mutation: vi.fn(),
      },
    })

    await expect(authority.listAgentExtensionPolicyOverridesForRuntime({
      workspaceId: "ws_1",
    })).resolves.toEqual([{ id: "review", scope: "workspace", enabled: false }])

    expect(query).toHaveBeenCalledWith(expect.anything(), {
      workspace_id: "ws_1",
      service_token: "svc_secret",
    })
  })

  test("requires a service token for runtime workspace Agent Extension hydration", async () => {
    delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    const authority = createConvexAuthority({
      executor: {
        query: vi.fn(),
        mutation: vi.fn(),
      },
    })

    await expect(authority.listWorkspaceAgentExtensionsForRuntime({
      workspaceId: "ws_1",
    })).rejects.toMatchObject({
      status: 503,
      code: "workspace_authority_unavailable",
    } satisfies Partial<ControlPlaneAuthError>)
  })
})
