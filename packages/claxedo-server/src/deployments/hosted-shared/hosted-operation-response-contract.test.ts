import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { SignJWT, exportJWK, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { createHostedApp } from "./hosted-app"
import { createCentralControlApp } from "../../central-runtime"
import { sandboxRelayTargetLookup, type HostedControlPlane } from "../../authority/hosted-services"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../../authority/services"
import type { ProjectionStore } from "../../authority/projection-store"
import type { RelayProvider } from "@claxedo/server-core/adapters/relay/index"
import type { WorkGraphConvexExecutor } from "../../hosts/workgraph/convex/store"
import type { DocumentsRouteBackend } from "../../documents/routes/index"
import type { DocumentIndexEntry } from "../../documents/index-store"
import type { DocumentHandle, DocumentVersion, SnapshotID } from "../../documents/port"
import type {
  HostEnrollment,
  OrgId,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { requirePiModel } from "@claxedo/agent-sdk-runtime/adapters"
import type { Attempts, IntegrationDeclaration, IntegrationImpl } from "@claxedo/connections"
import type { BillingStore } from "../../billing/store"
import type { PolarClientLike } from "../../billing/routes"
import { durableCliSessionTokenRegistry } from "../../test-support/cli-session-registry"
import {
  HOSTED_OPERATIONS as OPERATION_ROUTES,
  resolveHostedOperation,
  type HostedOperationName,
} from "../../../../claxedo-desktop/src/main/account/hosted-operations"
import {
  HOSTED_OPERATIONS as OPERATION_DECODERS,
  decodeHostedResult,
} from "../../../../claxedo-app/src/platform/account/hosted-operations"

/**
 * Hosted-operation RESPONSE contract.
 *
 * `hosted-product-contract.test.ts` states the route INVENTORY: which paths a
 * hosted app serves. That is the half that was checked. The half that was not
 * is what those paths ANSWER — and three of the desktop's typed decoders were
 * wrong about exactly that for as long as they existed, past 2,800 server tests
 * and 5,100 app tests, because every test that touched a decoder fed it a
 * hand-written fixture. A fixture copied from a reading of the route agrees
 * with that reading forever, including when the route stops agreeing.
 *
 * So this file writes no response fixtures. For every named
 * operations it takes the METHOD and PATH from the desktop's real table
 * (`claxedo-desktop/.../account/hosted-operations.ts`), drives the REAL hosted
 * app built by `createHostedApp`, and hands the body the route actually
 * produced to the app's real decoder
 * (`claxedo-app/.../account/hosted-operations.ts`). Nothing in between is
 * transcribed. Change what a route returns and the decoder for that operation
 * fails here, named.
 *
 * The three modules are the three sides of the closed set the operation matrix
 * describes, so binding them together is also the only place all three are held
 * equal at once against a running app.
 *
 * What is still faked is everything BELOW the route — the authority, the
 * sandbox manager, the relay signer — because those are ports with their own
 * contracts and their own tests. The fakes are typed against those ports, so a
 * port whose shape changes fails to compile here rather than silently feeding
 * this suite a shape the real adapter would never send.
 */

const SUBJECT = "user_1"
const WORKSPACE_ID = "ws_1"
/** A second workspace, of the OTHER access kind, so the list rows can be told apart. */
const USER_HOSTED_WORKSPACE_ID = "ws_2"
const CHECKPOINT_ID = "cp_1"
const ISSUER = "https://clerk.operation-contract.test"
const JWKS_URL = `${ISSUER}/jwks`

/**
 * A real signed bearer, verified by the real `verifyClerkBearer`.
 *
 * The alternative — injecting `services.auth.verifier` — is what the rest of
 * the hosted suite does, and it works for the routes that thread the composed
 * verifier through. The checkpoint and lifecycle routes do not: they build
 * their auth from `services.auth.config` alone, so an injected verifier never
 * runs and every call 401s. Signing a token the production verifier accepts
 * reaches every operation through the same door a browser uses, which is
 * the only door this file is allowed to care about.
 */
const signing = {
  bearer: "",
  jwks: { keys: [] as unknown[] },
  runtimeTokenKeys: { privatePem: "", publicPem: "" },
}

const originalFetch = globalThis.fetch

beforeAll(async () => {
  const clerk = await generateKeyPair("ES256", { extractable: true })
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  signing.jwks = { keys: [{ ...(await exportJWK(clerk.publicKey)), kid: "contract-key", alg: "ES256", use: "sig" }] }
  signing.bearer = await new SignJWT({ sub: SUBJECT, org_id: "org_1" })
    .setProtectedHeader({ alg: "ES256", kid: "contract-key" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(clerk.privateKey)
  signing.runtimeTokenKeys = {
    privatePem: await exportPKCS8(runtime.privateKey),
    publicPem: await exportSPKI(runtime.publicKey),
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Serve the JWKS, and swallow everything else.
 *
 * `createRemoteJWKSet` fetches the key set over the global fetch, and the
 * create route fires lease-tenant and lease-count writes it deliberately does
 * not await. Both must stay inside the process.
 */
function stubFetch() {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === JWKS_URL) return Response.json(signing.jwks)
    const parsed = new URL(url)
    if (parsed.origin === "https://relay.test") {
      if (parsed.pathname.endsWith("/global/health")) return Response.json({ workspaceId: WORKSPACE_ID })
      if (parsed.pathname.endsWith("/session/ses_1/message")) {
        return Response.json({ messages: [], session: { id: "ses_1" }, maxEventOrdinal: 0 })
      }
      if (parsed.pathname.endsWith("/session/status")) return Response.json({ ses_1: { type: "idle" } })
      if (parsed.pathname.endsWith("/session/ses_1")) {
        return Response.json({ id: "ses_1", title: "Contract session", time: { created: 1_000, updated: 2_000 } })
      }
    }
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch
}

/** The authority answers, typed by the port so a port change breaks the build. */
const ENROLLMENT: HostEnrollment = {
  enrollment_id: "enr_1",
  host_id: "host_1",
  display_name: "Yash laptop",
  expires_at: 9_999,
  last_seen_at: 1_000,
  created_at: 500,
}

function provisioningSandboxManager() {
  return {
    list: vi.fn(async () => []),
    ensure: vi.fn(async () => ({
      status: "provisioning" as const,
      workspaceId: WORKSPACE_ID,
      epoch: 1,
      retryAfterMs: 2_000,
      bootMode: "cold-start" as const,
      homeRegion: "us-east",
    })),
  } as unknown as SandboxManager
}

function contractAuthority(): WorkspaceAuthority {
  const orgId = "org_1" as OrgId
  return {
    usersMe: vi.fn(async () => ({
      id: SUBJECT,
      user_id: SUBJECT,
      actor_id: SUBJECT,
      actor_kind: "human",
      actor_public_id: "usr_public_1",
      actor_name: "Test User",
      subject: SUBJECT,
    })),
    listOrgs: vi.fn(async () => [{ org_id: orgId, name: "Acme" }]),
    resolveOrgId: vi.fn(async () => orgId),
    projectRole: vi.fn(async (_auth, args) => ({ ok: true as const, role: "owner" as const, orgId: args.orgId ?? orgId })),
    authorizeProject: vi.fn(async (_auth, args) => ({ ok: true as const, role: "owner" as const, orgId: args.orgId ?? orgId })),
    authorizeChannelProject: vi.fn(async () => ({ ok: true as const, role: "owner" as const, orgId })),
    authorizeChannelWorkspace: vi.fn(async () => ({ actorId: SUBJECT, actorKind: "human" as const })),
    authorizeWorkspaceOpen: vi.fn(async () => undefined),
    authorizeWorkspaceCreate: vi.fn(async () => undefined),
    openWorkspace: vi.fn(async () => ({
      allowed: true,
      role: "owner",
      workspace: {
        workspace_id: WORKSPACE_ID,
        org_id: orgId,
        project_id: "proj_1",
        access: "cloud",
        backing: "cloud-vm",
        home_region: "us-east",
      },
    })),
    listWorkspaces: vi.fn(async () => [
      {
        workspace_id: WORKSPACE_ID,
        org_id: orgId,
        project_id: "proj_1",
        access: "cloud",
        backing: "cloud-vm",
        display_name: "Widgets",
        remote_directory: "/workspace",
      },
      {
        workspace_id: USER_HOSTED_WORKSPACE_ID,
        org_id: orgId,
        project_id: "proj_2",
        access: "user-hosted",
        backing: "local-worktree",
        display_name: "Laptop",
        remote_directory: "/home/dev/widgets",
      },
    ]),
    registerLocalForSharing: vi.fn(async () => ({ workspace_id: WORKSPACE_ID })),
    createLocalHostLinkChallenge: vi.fn(async () => ({
      challenge_id: "challenge_1",
      nonce: "nonce_1",
      expires_at: 9_999,
    })),
    registerLocalHostLink: vi.fn(async () => ({ workspace_id: WORKSPACE_ID, host_id: "host_1" })),
    heartbeatLocalHostLink: vi.fn(async () => ({ expires_at: 9_999, last_seen_at: 1_000 })),
    pauseLocalHostLink: vi.fn(async () => ({ paused: true })),
    activeLocalHostLink: vi.fn(async () => ({
      active: true,
      host_id: "host_1",
      workspace_id: WORKSPACE_ID,
      expires_at: 9_999,
      last_seen_at: 1_000,
    })),
    createHostEnrollmentRequest: vi.fn(async () => ({ request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 })),
    enrollHost: vi.fn(async () => ENROLLMENT),
    heartbeatHostEnrollment: vi.fn(async () => ({ expires_at: 9_999, last_seen_at: 1_000 })),
    pauseHostEnrollment: vi.fn(async () => ({ paused: true })),
    activeHostEnrollment: vi.fn(async () => ({ active: true as const, ...ENROLLMENT })),
    markSecondDeviceOpen: vi.fn(async () => ({ recorded: true, second_device_open_at: 1_000 })),
    deleteWorkspace: vi.fn(async () => ({ deleted: true })),
    createCloudWorkspace: vi.fn(async () => ({ workspace_id: WORKSPACE_ID })),
    grantWorkspaceShare: vi.fn(async () => ({ granted: true })),
    revokeWorkspaceShare: vi.fn(async () => ({ revoked: true })),
    authorizeSessionRead: vi.fn(async () => undefined),
    authorizeSessionWrite: vi.fn(async () => undefined),
    authorizeRuntimeSession: vi.fn(async () => undefined),
    registerRuntimeSession: vi.fn(async () => ({ registered: true })),
    addSessionParticipant: vi.fn(async () => ({ added: true })),
    removeSessionParticipant: vi.fn(async () => ({ removed: true })),
    grantSessionShare: vi.fn(async () => ({ grant_id: "grant_1" })),
    revokeSessionShare: vi.fn(async () => ({
      revoked: true,
      revokedTargets: [{ grantedToTokenIdentifier: "token_bob" }],
    })),
    listSessionShares: vi.fn(async () => ({
      can_manage_shares: true,
      grants: [],
      participants: [],
      teams: [],
    })),
    createOrg: vi.fn(async (_auth, args) => ({ org_id: orgId, name: args.name })),
    listTeams: vi.fn(async () => [{ team_id: "team_1", name: "Engineering" }]),
    createTeamInOrg: vi.fn(async (_auth, args) => ({ team_id: "team_1", name: args.name })),
    addTeamMember: vi.fn(async () => ({ added: true })),
    removeTeamMember: vi.fn(async () => ({ removed: true })),
    listTeamMembers: vi.fn(async () => []),
    grantTeamProject: vi.fn(async () => ({ granted: true })),
    revokeTeamProject: vi.fn(async () => ({ revoked: true })),
    ensureDefaultTeam: vi.fn(async () => ({ team_id: "team_1" })),
    listSessions: vi.fn(async () => [{
      session_id: "ses_1",
      workspace_id: WORKSPACE_ID,
      project_id: "proj_1",
      title: "Contract session",
      time: { created: 1_000, updated: 2_000 },
    }]),
    resolveSession: vi.fn(async () => ({ session_id: "ses_1", workspace_id: WORKSPACE_ID })),
    readSessionMessages: vi.fn(async () => ({ allowed: true, messages: [] })),
    syncSessionMessages: vi.fn(async () => ({ synced: true })),
    upsertSessionVisibility: vi.fn(async () => ({ synced: true })),
    replaceSessionVisibility: vi.fn(async () => ({ synced: true })),
    deleteSessionVisibility: vi.fn(async () => ({ deleted: true })),
    recordRuntimeAccessToken: vi.fn(async () => ({ recorded: true })),
    recordRuntimeAccessTokenForService: vi.fn(async () => ({ recorded: true })),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
    revokeRuntimeAccessToken: vi.fn(async () => ({ revoked: true })),
    revokeRuntimeAccessTokensForWorkspaceUser: vi.fn(async () => ({ revoked: 1 })),
    listWorkspaceAgentExtensions: vi.fn(async () => [{
      desired: {
        id: "extension_1",
        package_name: "extension_1",
        source: { type: "github", owner: "acme", repo: "extension_1" },
        scope: "workspace",
        enabled: false,
        targets: ["codex"],
        installed_at: 1_000,
        updated_at: 1_000,
      },
      lock: {
        source: { type: "github", owner: "acme", repo: "extension_1" },
        resolved_sha: "abcdef1234567890",
        manifest_digests: { package: "sha256:contract" },
        component_digests: { package: "sha256:contract" },
        targets: ["codex"],
      },
    }]),
    listWorkspaceAgentExtensionsForRuntime: vi.fn(async () => []),
    authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => undefined),
    upsertWorkspaceAgentExtension: vi.fn(async () => ({ installed: true })),
    setWorkspaceAgentExtensionEnabled: vi.fn(async () => ({ updated: true })),
    deleteWorkspaceAgentExtension: vi.fn(async () => ({ deleted: true })),
    listAgentExtensionPolicyOverrides: vi.fn(async () => []),
    listAgentExtensionPolicyOverridesForRuntime: vi.fn(async () => []),
    setAgentExtensionPolicyOverride: vi.fn(async () => ({ updated: true })),
    deleteAgentExtensionPolicyOverride: vi.fn(async () => ({ deleted: true })),
    auditAllow: vi.fn(async () => undefined),
    auditDeny: vi.fn(async () => undefined),
  }
}

function fakeSandboxManager() {
  const lease = {
    workspaceId: WORKSPACE_ID,
    status: "ready" as const,
    sandboxId: "sandbox_1",
    url: "https://runtime.test/ws_1",
    hostId: "host_cloud_1",
    epoch: 1,
    homeRegion: "us-east",
    persistence: { resume: "same-sandbox", capture: "filesystem", clone: false },
    labels: { image: "runtime:1", runtimeVersion: "0.7.0" },
  }
  return {
    list: vi.fn(async () => [lease]),
    ensure: vi.fn(async () => lease),
    checkpoint: vi.fn(async () => ({ ok: true, lease: { ...lease, status: "stopped" } })),
    restore: vi.fn(async () => ({ ok: true, lease })),
    stop: vi.fn(async () => ({ ok: true, status: "stopped" })),
    destroy: vi.fn(async () => ({ ok: true })),
    release: vi.fn(async () => ({ released: true })),
    target: vi.fn(async () => lease),
  } as unknown as SandboxManager
}

/**
 * One hosted plane wired for every operation at once.
 *
 * Deliberately one plane rather than one per operation: a per-case plane is a per-case
 * opportunity to shape the world until the assertion passes, which is the
 * fixture problem again wearing a different hat.
 */
function contractPlane(sandboxManager: SandboxManager = fakeSandboxManager()): HostedControlPlane {
  const authority = contractAuthority()
  type ContractSessionMeta = NonNullable<Awaited<ReturnType<ProjectionStore["session_meta"]>>>
  const sessionMeta = new Map<string, ContractSessionMeta>()
  sessionMeta.set("ses_1", {
    sessionID: "ses_1",
    host: "central",
    workspaceID: WORKSPACE_ID,
    directory: "/repo",
    title: "Contract session",
    createdAt: 1_000,
    updatedAt: 2_000,
    tags: [],
    attachments: [],
  })
  const projectionStore = {
    sync_session_meta: vi.fn(async () => undefined),
    sync_session_metas: vi.fn(async () => undefined),
    sync_session_messages: vi.fn(async () => undefined),
    put_session_meta: vi.fn(async (id: string, input) => {
      sessionMeta.set(id, {
        sessionID: id,
        host: input.host ?? "central",
        ...(typeof input.workspaceID === "string" ? { workspaceID: input.workspaceID } : {}),
        ...(typeof input.directory === "string" ? { directory: input.directory } : {}),
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(input.model ? { model: input.model } : {}),
        createdAt: 1_000,
        updatedAt: 2_000,
        tags: input.tags ?? [],
        attachments: [],
      })
    }),
    delete_session_meta: vi.fn(async (id: string) => { sessionMeta.delete(id) }),
    session_meta: vi.fn(async (id: string) => sessionMeta.get(id)),
    session_metas: vi.fn(async (ids: string[]) =>
      new Map(ids.flatMap((id) => sessionMeta.has(id) ? [[id, sessionMeta.get(id)!]] : []))),
    list_session_metas: vi.fn(async () => [...sessionMeta.values()]),
    list_session_navigation_metas: vi.fn(async () => [...sessionMeta.values()]),
    tagged_session_metas: vi.fn(async () => []),
    read_session_messages: vi.fn(() => []),
    read_session_message_page: vi.fn(() => ({ messages: [] })),
    read_session_max_event_ordinal: vi.fn(() => 0),
  } satisfies ProjectionStore
  const relayProvider = {
    getRelayEndpoint: vi.fn(async () => "https://relay.test"),
    mintHostTunnelToken: vi.fn(async () => ({ token: "host-token", expiresAt: 1_000_000, jti: "host-jti" })),
    mintRuntimeAccessToken: vi.fn(async () => ({ token: "runtime-token", expiresAt: 1_000_000, jti: "runtime-jti" })),
    resolveTarget: vi.fn(async () => ({
      workspaceId: WORKSPACE_ID,
      hostId: "host_cloud_1",
      baseUrl: "https://runtime.test/ws_1",
      access: "cloud" as const,
      backing: "cloud-vm" as const,
    })),
    drainWorkspace: vi.fn(async () => undefined),
  } satisfies RelayProvider
  const services = {
    // No injected verifier on purpose — see `signing`.
    auth: { config: { enabled: true, issuer: ISSUER, jwksUrl: JWKS_URL } },
    relay: {
      relayUrl: "https://relay.test",
      resolverToken: "resolver-token",
      provider: relayProvider,
      runtimeAccessTokenSigner: vi.fn(async () => ({
        runtimeAccessToken: "rat-token",
        tokenExpiresAt: 1_000_000,
        jti: "jti_1",
      })),
      hostTunnelTokenSigner: vi.fn(),
    },
    sandbox: { sandboxManager },
    authority,
    projectionStore,
    durableSessionLog: {
      persist_message_event: vi.fn(),
      subscribe_message_replay: vi.fn(() => () => undefined),
    },
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices

  return {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 1_000,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 1_000,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 10_000,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({
      sandboxManager: services.sandbox.sandboxManager!,
      telemetry: services.telemetry,
    }),
    cliSessionTokenRegistry: durableCliSessionTokenRegistry().registry,
    env: {
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      // `account.cliExchange` mints a real CLI session token; without a signing
      // key the route answers 503 and the operation could never be bound.
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: signing.runtimeTokenKeys.privatePem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: signing.runtimeTokenKeys.publicPem,
      CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS: "600",
      CLAXEDO_POLAR_PRODUCT_MONTHLY: "product_monthly",
    },
  } as unknown as HostedControlPlane
}

function contractWorkGraphExecutor(): WorkGraphConvexExecutor {
  return {
    query: vi.fn(async (_fn, args) => {
      if ("clerk_subject" in args || "clerk_org_id" in args) {
        return { member: true, org_id: "org_1", user_id: SUBJECT }
      }
      if ("ownerUserId" in args && "orgId" in args && !("query" in args)) {
        return [{
          id: "connection_1",
          integrationId: "github",
          capabilities: ["code-host", "work-source"],
          status: "connected",
          fields: {},
          tokenType: "bearer",
        }]
      }
      if ("query" in args) {
        return { snapshotCursor: "0", records: [], references: [], hasMore: false, capturedAt: 1 }
      }
      return null
    }),
    mutation: vi.fn(async (_fn, args) => {
      if ("clerk_subject" in args && !("actor_type" in args)) {
        return { member: true, org_id: "org_1", user_id: SUBJECT }
      }
      if ("actor_type" in args) {
        return { ok: true, operationId: args.operation_id, cursor: "1", value: { streamId: "stream_1" } }
      }
      if ("connectionId" in args && "ownerUserId" in args) {
        return { deleted: true, updated: true }
      }
      return { ok: true }
    }),
  }
}

function contractConnections() {
  const declaration: IntegrationDeclaration = {
    id: "github",
    name: "GitHub",
    methods: ["oauth", "key"],
    capabilities: ["code-host", "work-source"],
    keyTokenType: "bearer",
  }
  const implementation: IntegrationImpl = {
    verify: async () => ({ ok: true, accountLabel: "acme" }),
    listRepositories: async () => [{
      id: "repo_1",
      name: "widgets",
      fullName: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      private: true,
      permissions: { read: true, write: true },
    }],
    device: {
      start: async () => ({
        deviceCode: "device_1",
        userCode: "CONTRACT",
        verificationUri: "https://github.com/login/device",
        intervalMs: 1_000,
        expiresAt: Date.now() + 60_000,
      }),
      poll: async () => ({ status: "complete", tokens: { accessToken: "github-token" } }),
    },
  }
  const attempts: Attempts = {
    create: async () => ({ state: "attempt_1", verifier: "verifier_1" }),
    consume: async () => undefined,
    peek: async () => undefined,
    settle: async () => undefined,
    expire: async () => undefined,
    status: async () => ({ status: "complete", integrationId: "github", scope: "team" }),
    sweep: async () => undefined,
    dispose: () => undefined,
  }
  const secrets = new Map([["integration:connection_1", "github-token"]])
  const credentials: ControlPlaneCredentials = {
    listCredentials: async () => [],
    getCredentialByProvider: async (providerId) => {
      if (!secrets.has(providerId)) return undefined
      return {
        id: providerId,
        provider_id: providerId,
        kind: "api_key",
        source: "managed",
        label: null,
        account_id: null,
        secure_ref: `contract:${providerId}`,
        status: "available",
        expires_at: null,
        last_validated_at: null,
        last_error: null,
        created_at: 1,
        updated_at: 1,
      }
    },
    resolveCredentialSecret: async (providerId) => secrets.get(providerId) ?? null,
    putCredential: async (value) => {
      secrets.set(value.provider_id, value.secret)
      return (await credentials.getCredentialByProvider(value.provider_id))!
    },
    deleteCredential: async (id) => secrets.delete(id),
    deleteCredentialsByProvider: async (providerId) => secrets.delete(providerId) ? 1 : 0,
    updateCredentialStatus: async () => undefined,
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
  return {
    integrations: [{ decl: declaration, impl: implementation }],
    credentials: () => credentials,
    attempts,
  }
}

function contractBilling(): { store: BillingStore; polar: PolarClientLike } {
  return {
    store: {
      entitlementState: async () => ({ found: false }),
      applyPolarState: async () => ({ results: [], unresolved: [] }),
      checkoutContext: async () => ({
        org_id: "org_1",
        clerk_org_id: "org_1",
        role: "owner",
        member_count: 1,
      }),
      listReconcileFlagged: async () => [],
      listDeletedWithSubscription: async () => [],
    },
    polar: {
      checkouts: {
        create: async () => ({ id: "checkout_1", url: "https://billing.test/checkout_1" }),
      },
      customerSessions: {
        create: async () => ({ token: "portal_1", customerPortalUrl: "https://billing.test/portal_1" }),
      },
      customers: {
        getState: async () => ({ id: "customer_1", activeSubscriptions: [] }),
      },
      subscriptions: {
        revoke: async () => ({ revoked: true }),
      },
    },
  }
}

type ContractDocumentHandle = DocumentHandle & { documentId: string }

function contractDocumentsBackend(): DocumentsRouteBackend<ContractDocumentHandle> {
  const version = (value: string) => value as DocumentVersion
  const snapshotId = (value: string) => value as SnapshotID
  const stamp = "2026-08-30T00:00:00.000Z"
  const entries = new Map<string, DocumentIndexEntry>()
  const content = new Map<string, { markdown: string; version: DocumentVersion }>()
  const snapshots = new Map<string, Array<{
    id: SnapshotID
    sha256: string
    size: number
    reason: string
    actor: { type: "user" | "agent" | "system"; id: string }
    createdAt: number
    pins: string[]
  }>>()
  const initial: DocumentIndexEntry = {
    id: "doc_1",
    org_id: "org_1",
    project_id: "proj_1",
    display_name: "Contract",
    origin_kind: "managed",
    placement_kind: "hosted",
    placement_id: "hosted",
    managed_relative_path: "documents/doc_1.md",
    repository_id: null,
    workspace_id: null,
    repository_relative_path: null,
    branch: null,
    status: "draft",
    session_id: "ses_1",
    archived_at: null,
    created_at: stamp,
    updated_at: stamp,
    last_opened_at: null,
    last_known_file_version: version("revision_1"),
  }
  entries.set(initial.id, initial)
  content.set(initial.id, { markdown: "# Contract", version: version("revision_1") })

  const hash = async (markdown: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  const handle = (documentId: string): ContractDocumentHandle => ({
    origin: entries.get(documentId)?.origin_kind ?? "managed",
    placement: "hosted",
    projectId: entries.get(documentId)?.project_id ?? "proj_1",
    documentId,
  })
  const requireEntry = (documentId: string) => {
    const entry = entries.get(documentId)
    if (!entry) throw new Error(`missing contract document ${documentId}`)
    return entry
  }
  const requireContent = (documentId: string) => {
    const value = content.get(documentId)
    if (!value) throw new Error(`missing contract document content ${documentId}`)
    return value
  }
  const nextVersion = (current: DocumentVersion) => version(`${current}:next`)
  const snapshot = async (documentId: string, id: SnapshotID, pins: string[] = []) => {
    const current = requireContent(documentId)
    return {
      id,
      sha256: await hash(current.markdown),
      size: new TextEncoder().encode(current.markdown).byteLength,
      reason: "contract",
      actor: { type: "user" as const, id: SUBJECT },
      createdAt: 1_000,
      pins,
    }
  }
  return {
    index: {
      list: async (scope) => [...entries.values()].filter((entry) =>
        entry.org_id === scope.orgId && entry.project_id === scope.projectId),
      find: async (orgId, documentId) => {
        const entry = entries.get(documentId)
        return entry?.org_id === orgId ? entry : undefined
      },
      findRepository: async (_scope, repositoryId) =>
        [...entries.values()].find((entry) => entry.repository_id === repositoryId),
      create: async (entry) => { entries.set(entry.id, entry); return entry },
      remove: async (_scope, documentId) => { entries.delete(documentId); content.delete(documentId) },
      update: async (_scope, documentId, input) => {
        const updated = { ...requireEntry(documentId), ...input, updated_at: stamp }
        entries.set(documentId, updated)
        return updated
      },
      relocate: async (_scope, documentId, input) => {
        const current = requireEntry(documentId)
        if (current.origin_kind !== "repository") throw new Error(`contract document ${documentId} is not repository-backed`)
        const updated: DocumentIndexEntry = { ...current, ...input, updated_at: stamp }
        entries.set(documentId, updated)
        return updated
      },
      archive: async (_scope, documentId) => {
        const updated = { ...requireEntry(documentId), archived_at: stamp }
        entries.set(documentId, updated)
        return updated
      },
      restore: async (_scope, documentId) => {
        const updated = { ...requireEntry(documentId), archived_at: null }
        entries.set(documentId, updated)
        return updated
      },
      listStatuses: async () => [{ id: "draft", name: "Draft", color: "gray", position: 0, transitions: [] }],
      resolveLocalProjectId: async () => "proj_1",
    },
    workspace: {
      resolve: async (entry) => handle(entry.documentId),
      create: async (entry, request) => {
        const created = { markdown: request.markdown, version: version("revision_1"), modifiedAt: 1_000 }
        content.set(entry.documentId, created)
        return created
      },
      read: async (value) => ({ ...requireContent(value.documentId), modifiedAt: 1_000 }),
      write: async (value, request) => {
        const next = { markdown: request.markdown, version: nextVersion(requireContent(value.documentId).version), modifiedAt: 2_000 }
        content.set(value.documentId, next)
        return next
      },
      snapshot: async (value) => {
        const item = await snapshot(value.documentId, snapshotId("snapshot_1"))
        snapshots.set(value.documentId, [item])
        return item
      },
      listSnapshots: async (value) => {
        if (!snapshots.has(value.documentId)) snapshots.set(value.documentId, [await snapshot(value.documentId, snapshotId("snapshot_1"))])
        return snapshots.get(value.documentId)!
      },
      readSnapshot: async (value) => ({ ...requireContent(value.documentId), modifiedAt: 1_000 }),
      restore: async (value) => ({ ...requireContent(value.documentId), modifiedAt: 2_000 }),
      pinSnapshot: async (value, id, pin) => {
        const existing = (snapshots.get(value.documentId) ?? [await snapshot(value.documentId, id)])
          .find((item) => item.id === id) ?? await snapshot(value.documentId, id)
        const pinned = { ...existing, pins: [...new Set([...existing.pins, pin])] }
        snapshots.set(value.documentId, [pinned])
        return pinned
      },
      unpinSnapshot: async (value, id, pin) => {
        const existing = (snapshots.get(value.documentId) ?? [await snapshot(value.documentId, id)])
          .find((item) => item.id === id) ?? await snapshot(value.documentId, id)
        const unpinned = { ...existing, pins: existing.pins.filter((value) => value !== pin) }
        snapshots.set(value.documentId, [unpinned])
        return unpinned
      },
      collectSnapshots: async () => undefined,
    },
    managedRelativePath: ({ documentId }) => `documents/${documentId}.md`,
    placement: "hosted",
    placementId: "hosted",
    repository: {
      inspect: async (entry) => ({
        identityKey: `repo:${entry.documentId}`,
        relativePath: entry.relativePath,
        availability: { state: "available", version: version("revision_1") },
      }),
      availability: async () => ({ state: "available", version: version("revision_1") }),
      relocate: async (_entry, relativePath) => ({
        identityKey: `repo:${relativePath}`,
        relativePath,
        version: version("revision_2"),
      }),
      gitSnapshot: async () => ({
        repoRoot: "/repo", head: "abc", branch: "main", blobSha: "blob", tracked: true, dirty: false,
      }),
      commit: async () => ({ commit: "def", blobSha: "blob2", version: version("revision_2") }),
    },
    agentOpen: async () => ({ path: "/repo/Contract.md" }),
    runtimeResolve: async () => ({ path: "/repo/Contract.md", version: "revision_1" }),
    moveToRepository: async (entry, destination) => {
      const moved: DocumentIndexEntry = {
        ...entry,
        origin_kind: "repository",
        placement_id: destination.workspaceId,
        managed_relative_path: null,
        repository_id: `repo:${destination.relativePath}`,
        workspace_id: destination.workspaceId,
        repository_relative_path: destination.relativePath,
        last_known_file_version: version("revision_2"),
      }
      entries.set(entry.id, moved)
      return moved
    },
  }
}

/**
 * The parameters each operation needs, and nothing else.
 *
 * These are the caller's PARAMETERS, not a request: `resolveHostedOperation`
 * turns them into the method, path, and body the desktop table declares, so an
 * operation whose declared body the route rejects fails here on status long
 * before its decoder is reached. Three did.
 */
const OPERATION_INPUT: Record<HostedOperationName, Record<string, unknown>> = {
  "account.get": {},
  "account.mode": {},
  "account.compatibility": {},
  "account.cliExchange": { code: "device_code_1" },
  // No parameters: the access kind each of these lists is fixed in its path.
  "workspace.list.cloud": {},
  "workspace.list.userHosted": {},
  "workspace.resolve": {},
  "workspace.create": {
    projectId: "proj_1",
    projectName: "Widgets",
    workspaceName: "main",
    repoUrl: "https://github.com/acme/widgets.git",
    connectionId: "connection_1",
    repoFullName: "acme/widgets",
  },
  // `replace` rather than `stop`: the operation that needs the approval field,
  // so the declared body has to carry it.
  "workspace.lifecycle": { id: WORKSPACE_ID, operation: "replace", approved: true, checkpointId: CHECKPOINT_ID },
  "workspace.checkpoints.list": { id: WORKSPACE_ID },
  "workspace.checkpoints.create": { id: WORKSPACE_ID, policy: "drain" },
  "workspace.checkpoints.restore": { id: WORKSPACE_ID, checkpointId: CHECKPOINT_ID, approved: true },
  "workspace.connection.mint": { id: WORKSPACE_ID },
  "workspace.connection.refresh": { id: WORKSPACE_ID, previousJti: "jti_previous" },
  "host.enrollCurrentMachine": {
    hostId: "host_1",
    publicKey: "-----BEGIN PUBLIC KEY-----",
    requestId: "req_1",
    signature: "sig",
    displayName: "Yash laptop",
  },
  "host.enrollmentNonce": { hostId: "host_1" },
  "host.enrollmentHeartbeat": { hostId: "host_1", signature: "sig", ttlMs: 60_000 },
  "session.list": { workspaceId: WORKSPACE_ID },
  "session.navigationList": { scope: "workspace", limit: 50, workspaceId: WORKSPACE_ID },
  "session.projection.register": {
    workspaceId: WORKSPACE_ID,
    sessionId: "ses_1",
    idempotencyKey: "register_1",
    reason: "contract",
    expectedEventOrdinal: 0,
  },
  "session.projection.checkpoint": {
    workspaceId: WORKSPACE_ID,
    sessionId: "ses_1",
    idempotencyKey: "checkpoint_1",
    reason: "contract",
    expectedEventOrdinal: 0,
  },
  "session.projection.repair": {
    workspaceId: WORKSPACE_ID,
    sessionId: "ses_1",
    idempotencyKey: "repair_1",
    reason: "contract",
    expectedEventOrdinal: 0,
  },
  "session.events": {},
  "session.runtimeEvents": { sessionId: "ses_1", parentSessionId: "ses_1" },
  "session.shares.list": { sessionId: "ses_1", workspaceId: WORKSPACE_ID },
  "session.shares.grant": {
    sessionId: "ses_1",
    workspaceId: WORKSPACE_ID,
    grantedToTokenIdentifier: "token_bob",
    grantedToTeamPublicId: "team_1",
    grantedToOrgId: "org_1",
  },
  "session.shares.revoke": {
    sessionId: "ses_1",
    workspaceId: WORKSPACE_ID,
    grantId: "grant_1",
    grantedToTokenIdentifier: "token_bob",
    grantedToTeamPublicId: "team_1",
  },
  "session.participants.add": {
    sessionId: "ses_1",
    workspaceId: WORKSPACE_ID,
    participantTokenIdentifier: "token_bob",
  },
  "org.list": {},
  "org.create": { name: "Acme" },
  "org.teams.list": { orgId: "org_1" },
  "org.teams.create": { orgId: "org_1", name: "Engineering" },
  "org.ensureDefaultTeam": { orgId: "org_1" },
  "team.members.list": { teamId: "team_1" },
  "team.members.add": {
    teamId: "team_1",
    tokenIdentifier: "token_bob",
    clerkSubject: "user_bob",
    userPublicId: "usr_bob",
    role: "member",
  },
  "team.members.remove": { teamId: "team_1", tokenIdentifier: "token_bob", userPublicId: "usr_bob" },
  "team.projects.grant": { teamId: "team_1", projectId: "proj_1", role: "editor" },
  "connections.list": {},
  "connections.connect": {
    id: "github",
    method: "oauth",
    fields: {},
    secret: "secret",
    confirmReplace: true,
    scope: "team",
  },
  "connections.attempt": { state: "attempt_1" },
  "connections.repositories": { id: "connection_1" },
  "connections.disconnect": { id: "connection_1" },
  "connections.reverify": { id: "connection_1" },
  "documents.list": { project_id: "proj_1" },
  "documents.get": { id: "doc_1" },
  "documents.create": {
    project_id: "proj_1",
    directory: "/repo",
    display_name: "Contract",
    markdown: "# Contract",
  },
  "documents.update": { id: "doc_1", display_name: "Updated", session_id: "ses_1", ifMatch: "revision_1" },
  "documents.content.get": { id: "doc_1" },
  "documents.content.put": {
    id: "doc_1",
    display_name: "Updated",
    markdown: "# Updated",
    ifMatch: "revision_1",
  },
  "documents.snapshots": { id: "doc_1" },
  "documents.snapshots.restore": { id: "doc_1", snapshotId: "snapshot_1", ifMatch: "revision_1" },
  "documents.workSource": {
    id: "doc_1",
    target_stream_id: "stream_1",
    directory: "/repo",
    repository_url: "https://github.com/acme/widgets.git",
  },
  "documents.workSourcePin": {
    id: "doc_1",
    snapshotId: "snapshot_1",
    work_source_id: "source_1",
    revision_id: "revision_1",
  },
  "documents.statuses": { project_id: "proj_1" },
  "documents.export": { id: "doc_1" },
  "documents.agentOpen": { id: "doc_1", session_id: "ses_1" },
  "documents.runtimeConflictResolve": { id: "doc_1", session_id: "ses_1", choice: "durable" },
  "documents.moveToRepository": { id: "doc_1", workspace_id: WORKSPACE_ID, path: "docs/contract.md" },
  "documents.fromRepo": {
    project_id: "proj_1",
    directory: "/repo",
    workspace_id: WORKSPACE_ID,
    path: "docs/contract.md",
    display_name: "Contract",
    status: "draft",
    session_id: "ses_1",
  },
  "agentConfig.extensions.read": { subpath: "" },
  "agentConfig.extensions.write": {
    subpath: "extension_1/enable",
    httpMethod: "POST",
    payload: {},
    scope: "workspace",
    workspaceId: WORKSPACE_ID,
  },
  "workgraph.snapshot": {},
  "workgraph.command": {
    operationId: "operation_1",
    command: { version: 1, type: "create_stream", title: "Contract stream" },
  },
  "workgraph.read": { subpath: "snapshot" },
  "workgraph.write": {
    subpath: "commands",
    httpMethod: "POST",
    payload: {
      operationId: "operation_2",
      command: { version: 1, type: "create_stream", title: "Contract stream" },
    },
  },
  "session.create": {
    mode: "hybrid",
    workspaceId: WORKSPACE_ID,
    title: "Contract",
    directory: "/repo",
    harness: "pi",
    model: { providerID: "openai", modelID: "gpt-5" },
    toolSandbox: { kind: "virtual" },
  },
  "session.messages": { sessionId: "ses_1", workspaceId: WORKSPACE_ID },
  "session.gateway": { sessionId: "ses_1", workspaceId: WORKSPACE_ID },
  "billing.checkout": { plan: "monthly" },
  "billing.portal": {},
  "hostLink.register": {
    id: WORKSPACE_ID,
    hostId: "host_1",
    publicKey: "-----BEGIN PUBLIC KEY-----",
    challengeId: "challenge_1",
    signature: "sig",
    displayName: "Host",
    ttlMs: 60_000,
  },
  "usage.get": { since: 1_700_000_000_000, until: 1_700_086_400_000, timezone: "UTC", view: "quota" },
  "usage.sync": {},
}

/**
 * Send exactly what the desktop table resolves, and nothing more.
 *
 * No per-operation body patching. A test that quietly adds the field a route
 * demands is a test that makes an operation look reachable when main could
 * never send it — which is how `workspace.checkpoints.restore` and
 * `workspace.lifecycle` sat declaring no body against routes that answer 409
 * without one.
 */
async function callRequest(
  request: { method: string; path: string; body?: Record<string, unknown>; headers?: Record<string, string> },
  sandboxManager?: SandboxManager,
) {
  stubFetch()
  const plane = contractPlane(sandboxManager)
  const central = createCentralControlApp(plane.services, {
    authConfig: plane.services.auth.config,
    usageLedger: {
      recordLlmTurn: vi.fn(async () => ({ activated: false })),
      usageDashboard: vi.fn(async () => ({ totals: {}, daily: [] })),
    },
    productDeploymentMode: "cloud",
    modelBackend: (input) => input.model
      ? { model: requirePiModel(input.model), getApiKey: () => "contract-model-key" }
      : undefined,
  })
  central.runtime.eventHub.publishRuntime({
    directory: "ses_1",
    sessionId: "ses_1",
    payload: { type: "session-status", status: "idle" },
  })
  const app = createHostedApp(plane, {
    centralSessionRuntime: true,
    entitlementGate: async () => undefined,
    connections: contractConnections(),
    billing: contractBilling(),
    workGraphExecutor: contractWorkGraphExecutor(),
    documentsBackend: contractDocumentsBackend(),
  })
  app.route("/", central.app)
  const response = await app.fetch(
    new Request(`http://cp.test${request.path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${signing.bearer}`,
        "content-type": "application/json",
        ...request.headers,
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    }),
  )
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    const reader = response.body!.getReader()
    const chunk = await reader.read()
    await reader.cancel()
    const text = new TextDecoder().decode(chunk.value)
    const data = text.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length).trim()
    const parsed: unknown = data ? JSON.parse(data) : { type: "heartbeat" }
    return { response, text, parsed }
  }
  const text = await response.text()
  const parsed: unknown = text === "" || !contentType.includes("json") ? undefined : JSON.parse(text)
  return { response, text, parsed }
}

function expectedSuccessStatus(name: HostedOperationName) {
  switch (name) {
    case "workspace.checkpoints.create":
    case "documents.create":
    case "documents.fromRepo":
    case "session.create":
      return 201
    default:
      return 200
  }
}

async function callOperation(name: HostedOperationName, sandboxManager?: SandboxManager) {
  const result = await callRequest(resolveHostedOperation(name, OPERATION_INPUT[name]), sandboxManager)
  if (name !== "documents.export") return result
  const bytes = new TextEncoder().encode(result.text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { ...result, parsed: { bytesBase64: btoa(binary), contentType: result.response.headers.get("content-type") } }
}

/** The `workspaces` envelope this route answers, as rows. */
function listedWorkspaces(parsed: unknown) {
  const rows = (parsed as { workspaces?: unknown[] } | undefined)?.workspaces
  return (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]
}

describe("hosted operation response contract", () => {
  test("binds every named operation, with no exemptions", () => {
    // The closed set, held equal across all three sides at once. An operation
    // added to any one of them without the other two fails here, and an
    // operation quietly dropped from this file's coverage fails here too —
    // there is no exemption list to add a name to.
    expect(Object.keys(OPERATION_INPUT).toSorted()).toEqual(Object.keys(OPERATION_ROUTES).toSorted())
    expect(Object.keys(OPERATION_DECODERS).toSorted()).toEqual(Object.keys(OPERATION_ROUTES).toSorted())
  })

  test("exercises every field each operation declares", () => {
    // Without this, a declared field the route would reject stays invisible:
    // `resolveHostedOperation` drops a parameter the caller did not pass, so an
    // input that happens to omit it produces a request the route accepts and
    // the whole call looks fine. `workspace.create` declared `displayName`
    // against a strict schema for exactly that reason. Every declared field
    // must therefore reach a real route below.
    const missing = (Object.keys(OPERATION_ROUTES) as HostedOperationName[]).flatMap((name) => {
      const declared = (OPERATION_ROUTES[name] as { body?: readonly string[] }).body ?? []
      return declared
        .filter((field) => OPERATION_INPUT[name][field] === undefined)
        .map((field) => `${name}.${field}`)
    })

    expect(missing).toEqual([])
  })

  test("every query a path declares changes what the route answers", async () => {
    // The counterpart to the check above, for the other kind of declared thing,
    // and it has to ask a different question. A declared body field can fail to
    // REACH the route; a query written into the path always reaches it. What a
    // query can do instead is nothing at all — and an ignored query is
    // invisible, because the answer still decodes.
    //
    // The workspace list shipped the mirror image of that: no query where the
    // route required one, so it answered `{ workspaces: [] }` for its whole
    // life and every decoder was happy. So each declared query must be
    // load-bearing — strip it, and the route must answer something else.
    const withQuery = (Object.keys(OPERATION_ROUTES) as HostedOperationName[]).filter((name) =>
      OPERATION_ROUTES[name].path.includes("?"),
    )

    expect(withQuery.length, "no operation declares a query, so this check holds nothing").toBeGreaterThan(0)

    for (const name of withQuery) {
      const declared = resolveHostedOperation(name, OPERATION_INPUT[name])
      const answered = await callRequest(declared)
      const stripped = await callRequest({ ...declared, path: declared.path.split("?")[0]! })

      expect(answered.response.status, `${name} -> ${answered.text.slice(0, 400)}`).toBe(200)
      expect(stripped.text, `${name}: the declared query changes nothing about the answer`).not.toBe(answered.text)
    }
  })

  for (const name of Object.keys(OPERATION_ROUTES) as HostedOperationName[]) {
    test(`${name} answers a body its decoder accepts`, async () => {
      const { response, text, parsed } = await callOperation(name)
      expect(response.status, `${name} -> ${text.slice(0, 400)}`).toBe(expectedSuccessStatus(name))
      expect(() => decodeHostedResult(name, parsed)).not.toThrow()
    })
  }

  test("the workspace list answers ROWS, one operation per access kind", async () => {
    // The assertion the empty list survived. "Decodes without throwing" is
    // satisfied by `{ workspaces: [] }`, which is what `GET /api/workspace`
    // answers to any caller that does not name an access kind — so the old
    // single access-less operation passed the case above while never once
    // returning a workspace. Only a non-empty list can tell the two apart.
    const cloud = await callOperation("workspace.list.cloud")
    expect(cloud.response.status, cloud.text.slice(0, 400)).toBe(200)
    expect(listedWorkspaces(cloud.parsed).length).toBeGreaterThan(0)
    expect(listedWorkspaces(cloud.parsed).map((row) => row["workspace_id"])).toContain(WORKSPACE_ID)

    // And the other kind is a different answer, not the same one twice: this
    // route filters to user-hosted rows for this access kind, which is the only
    // reason two operations are worth having.
    const userHosted = await callOperation("workspace.list.userHosted")
    expect(userHosted.response.status, userHosted.text.slice(0, 400)).toBe(200)
    expect(listedWorkspaces(userHosted.parsed).length).toBeGreaterThan(0)
    expect(listedWorkspaces(userHosted.parsed).map((row) => row["workspace_id"])).toEqual([USER_HOSTED_WORKSPACE_ID])
  })

  for (const name of ["workspace.connection.mint", "workspace.connection.refresh"] as const) {
    test(`${name} accepts the cold start, not just the settled connection`, async () => {
      // The route answers 200 twice with different bodies: `provisioning` while
      // the sandbox comes up, then the mint. A ready-only fake never produces
      // the first, so a decoder that rejected every cold start would still pass
      // the case above — it did.
      const { response, text, parsed } = await callOperation(name, provisioningSandboxManager())

      expect(response.status, `${name} -> ${text.slice(0, 400)}`).toBe(200)
      expect(parsed).toMatchObject({ status: "provisioning" })
      expect(() => decodeHostedResult(name, parsed)).not.toThrow()
    })
  }

  test("a decoder that stops matching its route fails", async () => {
    // Mutation check on the binding itself. Every assertion above is a
    // NEGATIVE — "does not throw" — and a decoder set that accepted anything
    // would satisfy every case. So take a real route body and hand it to a
    // different operation's decoder: if the bodies were not really reaching the
    // decoders, this would pass too.
    const { parsed } = await callOperation("workspace.list.cloud")
    expect(() => decodeHostedResult("workspace.checkpoints.list", parsed)).not.toThrow()
    expect(() => decodeHostedResult("workspace.connection.mint", parsed)).toThrow(/relayUrl/)
    expect(() => decodeHostedResult("host.enrollCurrentMachine", parsed)).toThrow(/enrollment/)
  })
})
