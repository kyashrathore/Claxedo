import { describe, expect, test, vi } from "vitest"
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto"
import { createChallenge as convexCreateChallenge, register as convexRegister } from "../../../../../convex/localHostLinks"
import { registerLocalForSharing as convexRegisterLocalForSharing } from "../../../../../convex/workspaces"
import type { ClerkVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import type { HostTunnelTokenSigner, RuntimeAccessTokenSigner } from "../../platform/auth/runtime-access-token"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "./workspace"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"
import type { SandboxManager } from "@claxedo/sandbox-manager"

/**
 * Hosted user-hosted workspace routes. These prove the hosted control plane:
 *   - accepts a CLIENT-supplied host identity + signature (the CLI owns the key),
 *   - mints tokens via injected signers,
 *   - records link state in Convex,
 *   - and NEVER starts a tunnel / reads local host identity / hits the disk.
 *
 * The "no local-only" guarantee at the import-graph level is enforced separately
 * by `worker.import-graph.test.ts`; here we assert the request *behaviour*.
 */

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

function fakeConvexAuthority(overrides: Record<string, unknown> = {}) {
  return {
    usersMe: vi.fn(async () => ({ subject: "user_1" })),
    openWorkspace: vi.fn(async () => ({
      allowed: true,
      role: "owner",
      workspace: { workspace_id: "ws_1", access: "user-hosted", backing: "local-worktree" },
    })),
    activeLocalHostLink: vi.fn(async () => ({
      active: true,
      host_id: "host_1",
      workspace_id: "ws_1",
      expires_at: 9_999,
      last_seen_at: 1,
    })),
    recordRuntimeAccessToken: vi.fn(async () => ({})),
    revokeRuntimeAccessToken: vi.fn(async () => ({})),
    runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
    registerLocalForSharing: vi.fn(async () => ({
      workspace_id: "ws_1",
      display_name: "demo",
      home_region: "us-east",
    })),
    listWorkspaces: vi.fn(async () => [
      { workspace_id: "ws_user", access: "user-hosted" },
      { workspace_id: "ws_cloud", access: "cloud" },
    ]),
    createLocalHostLinkChallenge: vi.fn(async () => ({ challenge_id: "ch_1", nonce: "nonce_1", expires_at: 9_999 })),
    registerLocalHostLink: vi.fn(async () => ({ host_id: "host_1", workspace_id: "ws_1", expires_at: 9_999 })),
    heartbeatLocalHostLink: vi.fn(async () => ({
      host_id: "host_1",
      workspace_id: "ws_1",
      home_region: "us-east",
      expires_at: 9_999,
    })),
    pauseLocalHostLink: vi.fn(async () => ({ paused: true, count: 1 })),
    auditAllow: vi.fn(async () => ({})),
    auditDeny: vi.fn(async () => ({})),
    ...overrides,
  }
}

function fakeServices(authority: ReturnType<typeof fakeConvexAuthority> | undefined) {
  const capture = vi.fn()
  return {
    services: {
      authority,
      sandbox: {},
      telemetry: { capture },
    } as unknown as ControlPlaneServices,
    capture,
  }
}

const ratSigner: RuntimeAccessTokenSigner = vi.fn(async () => ({
  runtimeAccessToken: "rat-token",
  tokenExpiresAt: 1_000_000,
  jti: "jti_rat",
}))

const httSigner: HostTunnelTokenSigner = vi.fn(async (input) => ({
  hostTunnelToken: `htt-for-${input.hostId}`,
  tokenExpiresAt: 2_000_000,
  jti: "jti_htt",
}))

function buildApp(opts: {
  authority?: ReturnType<typeof fakeConvexAuthority>
  options?: Partial<HostedWorkspaceRouteOptions>
  sandboxManager?: SandboxManager
}) {
  const convex = "authority" in opts ? opts.authority : fakeConvexAuthority()
  const { services, capture } = fakeServices(convex)
  services.sandbox.sandboxManager = opts.sandboxManager
  const app = HostedWorkspaceRoutes(services, {
    authConfig,
    verifier,
    relayUrl: "https://relay.test",
    runtimeAccessTokenSigner: ratSigner,
    hostTunnelTokenSigner: httSigner,
    ...opts.options,
  })
  return { app, convex, capture }
}

// HostedWorkspaceRoutes mounts routes at the root of its own Hono (the hosted
// app mounts it under /api/workspace); fetch the sub-app directly here.
function post(path: string, body: unknown, token = "user_1") {
  return new Request(`http://cp.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function get(path: string, token = "user_1") {
  return new Request(`http://cp.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

describe("hosted register (client-owned host identity)", () => {
  test("records the CLIENT signature/public key and mints a host tunnel token, without starting a tunnel", async () => {
    const convex = fakeConvexAuthority({
      registerLocalForSharing: vi.fn(async () => ({
        workspace_id: "ws_1",
        display_name: "demo",
        home_region: "eu-west",
      })),
    })
    const { app } = buildApp({
      authority: convex,
      options: {
        defaultHomeRegion: "eu-west",
        relayUrls: {
          "eu-west": "https://relay.eu.test",
        },
      },
    })
    const res = await app.fetch(
      post("/ws_1/user-hosted/register", {
        hostId: "host_1",
        publicKey: "pub-key-jwk",
        challengeId: "ch_1",
        signature: "client-signature",
        displayName: "demo",
        repoName: "demo",
        gitBranch: "main",
      }),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, any>
    // Convex records the link with the CLIENT-supplied material (server holds no key).
    expect(convex!.registerLocalHostLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: "ws_1",
        hostId: "host_1",
        publicKey: "pub-key-jwk",
        challengeId: "ch_1",
        signature: "client-signature",
      }),
    )
    expect(convex!.registerLocalForSharing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ homeRegion: "eu-west" }),
    )
    // Workspace registration happens strictly AFTER the host signature was
    // verified (registerLocalHostLink verifies the signed challenge).
    expect(convex!.registerLocalHostLink.mock.invocationCallOrder[0]!).toBeLessThan(
      convex!.registerLocalForSharing.mock.invocationCallOrder[0]!,
    )
    // Host Tunnel Token is minted and returned for the CLI to start its own tunnel.
    expect(json.hostTunnel).toMatchObject({
      hostTunnelToken: "htt-for-host_1",
      homeRegion: "eu-west",
      relayUrl: "https://relay.eu.test",
    })
    expect(json.localHostLink.host_id).toBe("host_1")
  })

  test("rejects when the request omits the host signature (schema fail-closed, stable 400)", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(post("/ws_1/user-hosted/register", { hostId: "host_1", publicKey: "p" }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request_body" } })
    // Validation failure never reaches Convex — no partial link, no mutation.
    expect(convex!.registerLocalHostLink).not.toHaveBeenCalled()
    expect(convex!.registerLocalForSharing).not.toHaveBeenCalled()
  })

  test("a register whose host signature fails verification never mutates the workspace", async () => {
    const convex = fakeConvexAuthority({
      registerLocalHostLink: vi.fn(async () => {
        throw new Error("Invalid host attestation")
      }),
    })
    const { app } = buildApp({ authority: convex })
    await expect(
      app.fetch(
        post("/ws_1/user-hosted/register", {
          hostId: "host_1",
          publicKey: "pub-key-jwk",
          challengeId: "ch_1",
          signature: "forged-signature",
        }),
      ),
    ).resolves.toMatchObject({ status: 500 })
    // registerLocalForSharing runs strictly AFTER signature verification.
    expect(convex!.registerLocalForSharing).not.toHaveBeenCalled()
  })

  test("registering a cloud-backed workspace as user-hosted returns a 409 conflict", async () => {
    const convex = fakeConvexAuthority({
      registerLocalHostLink: vi.fn(async () => {
        throw new Error("workspace_backing_conflict: cannot attach a local host link to a cloud workspace")
      }),
    })
    const { app } = buildApp({ authority: convex })
    const res = await app.fetch(
      post("/ws_1/user-hosted/register", {
        hostId: "host_1",
        publicKey: "pub-key-jwk",
        challengeId: "ch_1",
        signature: "client-signature",
      }),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "workspace_backing_conflict" } })
    expect(convex!.registerLocalForSharing).not.toHaveBeenCalled()
  })

  test("fails closed (503) when no Convex authority is configured", async () => {
    const { app } = buildApp({ authority: undefined })
    const res = await app.fetch(
      post("/ws_1/user-hosted/register", {
        hostId: "host_1",
        publicKey: "p",
        challengeId: "ch_1",
        signature: "s",
      }),
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "workspace_authority_unavailable" } })
  })
})

// ——— Cold-path harness: the REAL Convex handlers behind a fake Convex db ———

type ConvexRow = Record<string, unknown> & { _id: string }

function fakeConvexDb(seed: Record<string, ConvexRow[]>) {
  const rows = Object.fromEntries(Object.entries(seed).map(([key, value]) => [key, [...value]]))
  return {
    rows,
    query(table: string) {
      const filters: Array<[string, unknown]> = []
      const query = {
        withIndex(_name: string, build: (q: { eq: (key: string, value: unknown) => unknown }) => unknown) {
          const index = {
            eq(key: string, value: unknown) {
              filters.push([key, value])
              return index
            },
          }
          build(index)
          return query
        },
        async collect() {
          return (rows[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value))
        },
        async unique() {
          return (await query.collect())[0]
        },
      }
      return query
    },
    async insert(table: string, row: Record<string, unknown>) {
      const id = `${table}:${(rows[table] ?? []).length + 1}`
      rows[table] ??= []
      rows[table].push({ _id: id, ...row })
      return id
    },
    async get(id: string) {
      for (const tableRows of Object.values(rows)) {
        const row = tableRows.find((item) => item._id === id)
        if (row) return row
      }
      return null
    },
    async patch(id: string, patch: Record<string, unknown>) {
      for (const table of Object.keys(rows)) {
        const index = rows[table]!.findIndex((row) => row._id === id)
        if (index === -1) continue
        rows[table]![index] = { ...rows[table]![index], ...patch }
        return
      }
      throw new Error(`Missing row ${id}`)
    },
  }
}

function hostKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const privateKey = pair.privateKey.export({ format: "jwk" })
  const publicKey = JSON.stringify(pair.publicKey.export({ format: "jwk" }))
  return {
    publicKey,
    sign(payload: string) {
      return sign("sha256", Buffer.from(payload), {
        key: createPrivateKey({ key: privateKey, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      }).toString("base64url")
    },
  }
}

function registrationPayload(input: { workspaceId: string; hostId: string; challengeId: string; nonce: string }) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `challenge_id=${input.challengeId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/**
 * A ConvexAuthority adapter that drives the REAL Convex mutation handlers
 * (localHostLinks.createChallenge/register + workspaces.registerLocalForSharing)
 * against an in-memory db — no mocks on the policy path.
 */
function realConvexAuthority() {
  const store = fakeConvexDb({
    users: [{ _id: "user_owner", token_identifier: "owner_token" }],
    workspaces: [],
    workspace_memberships: [],
    workspace_share_grants: [],
    org_memberships: [],
    local_host_links: [],
    host_attestation_challenges: [],
  })
  const ctx = {
    db: store,
    auth: { getUserIdentity: async () => ({ tokenIdentifier: "owner_token" }) },
  }
  const handler = (fn: unknown) =>
    (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
  const authority = {
    ...fakeConvexAuthority(),
    createLocalHostLinkChallenge: vi.fn(async (_auth: unknown, args: { workspaceId: string; hostId: string }) =>
      handler(convexCreateChallenge)(ctx, {
        workspace_id: args.workspaceId,
        host_id: args.hostId,
      }),
    ),
    registerLocalHostLink: vi.fn(
      async (
        _auth: unknown,
        args: {
          workspaceId: string
          hostId: string
          publicKey: string
          challengeId: string
          signature: string
          displayName?: string
          ttlMs?: number
        },
      ) =>
        handler(convexRegister)(ctx, {
          workspace_id: args.workspaceId,
          host_id: args.hostId,
          public_key: args.publicKey,
          challenge_id: args.challengeId,
          signature: args.signature,
          ...(args.displayName ? { display_name: args.displayName } : {}),
          ...(args.ttlMs === undefined ? {} : { ttl_ms: args.ttlMs }),
        }),
    ),
    registerLocalForSharing: vi.fn(
      async (
        _auth: unknown,
        args: {
          workspaceId: string
          displayName: string
          homeRegion?: string
          repoName?: string
          gitBranch?: string
        },
      ) =>
        handler(convexRegisterLocalForSharing)(ctx, {
          workspace_id: args.workspaceId,
          display_name: args.displayName,
          ...(args.homeRegion ? { home_region: args.homeRegion } : {}),
          ...(args.repoName ? { repo_name: args.repoName } : {}),
          ...(args.gitBranch ? { git_branch: args.gitBranch } : {}),
        }),
    ),
  } as ReturnType<typeof fakeConvexAuthority>
  return { store, authority }
}

describe("hosted cold path against the REAL Convex handlers", () => {
  test("a never-registered workspaceId completes challenge → signed register and ends owned + user-hosted", async () => {
    const { store, authority } = realConvexAuthority()
    const { app } = buildApp({ authority: authority })
    const key = hostKey()

    // 1. Challenge: must NOT 500 on the missing workspace doc and must not
    //    create one (challenge mutates nothing about workspaces).
    const challengeRes = await app.fetch(post("/ws_cold/user-hosted/challenge", { hostId: "host_1" }))
    expect(challengeRes.status).toBe(200)
    const { challenge } = (await challengeRes.json()) as {
      challenge: { challengeId: string; nonce: string }
    }
    expect(store.rows.workspaces).toHaveLength(0)

    // 2. CLI signs the challenge; register verifies the signature, creates the
    //    workspace doc with user-hosted backing owned by the caller, then the
    //    route's registerLocalForSharing patches metadata without conflict.
    const registerRes = await app.fetch(
      post("/ws_cold/user-hosted/register", {
        hostId: "host_1",
        publicKey: key.publicKey,
        challengeId: challenge.challengeId,
        signature: key.sign(
          registrationPayload({
            workspaceId: "ws_cold",
            hostId: "host_1",
            challengeId: challenge.challengeId,
            nonce: challenge.nonce,
          }),
        ),
        displayName: "demo",
        repoName: "demo",
      }),
    )
    expect(registerRes.status).toBe(200)
    const json = (await registerRes.json()) as Record<string, any>
    expect(json.localHostLink).toMatchObject({ host_id: "host_1", workspace_id: "ws_cold" })
    expect(json.hostTunnel).toMatchObject({ hostTunnelToken: "htt-for-host_1" })
    expect(store.rows.workspaces).toHaveLength(1)
    expect(store.rows.workspaces[0]).toMatchObject({
      workspace_id: "ws_cold",
      owner_user_id: "user_owner",
      backing: "local-worktree",
      access: "user-hosted",
      display_name: "demo",
      repo_name: "demo",
    })
    expect(json.workspace).toMatchObject({ workspace_doc_id: store.rows.workspaces[0]!._id })
    expect(store.rows.local_host_links).toHaveLength(1)
    expect(store.rows.local_host_links[0]).toMatchObject({
      workspace_id: store.rows.workspaces[0]!._id,
      host_id: "host_1",
      public_key: key.publicKey,
    })

    expect(store.rows.workspaces).toHaveLength(1)
    expect(store.rows.local_host_links).toHaveLength(1)
  })

  test("a forged signature on the cold path creates neither workspace nor link", async () => {
    const { store, authority } = realConvexAuthority()
    const { app } = buildApp({ authority: authority })
    const key = hostKey()
    const forgedKey = hostKey()

    const challengeRes = await app.fetch(post("/ws_cold/user-hosted/challenge", { hostId: "host_1" }))
    const { challenge } = (await challengeRes.json()) as {
      challenge: { challengeId: string; nonce: string }
    }

    const registerRes = await app.fetch(
      post("/ws_cold/user-hosted/register", {
        hostId: "host_1",
        publicKey: key.publicKey,
        challengeId: challenge.challengeId,
        signature: forgedKey.sign(
          registrationPayload({
            workspaceId: "ws_cold",
            hostId: "host_1",
            challengeId: challenge.challengeId,
            nonce: challenge.nonce,
          }),
        ),
      }),
    )
    expect(registerRes.status).toBe(500)
    expect(store.rows.workspaces).toHaveLength(0)
    expect(store.rows.local_host_links).toHaveLength(0)
    expect((authority as ReturnType<typeof fakeConvexAuthority>).registerLocalForSharing).not.toHaveBeenCalled()
  })
})

describe("hosted challenge", () => {
  test("returns a signing challenge WITHOUT mutating the workspace (no pre-proof registration)", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(post("/ws_1/user-hosted/challenge", { hostId: "host_1", displayName: "demo" }))
    expect(res.status).toBe(200)
    // Challenge issuance is read-plus-nonce only; registration for sharing
    // happens in /register, after the host proves its key.
    expect(convex!.registerLocalForSharing).not.toHaveBeenCalled()
    expect(convex!.createLocalHostLinkChallenge).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      hostId: "host_1",
    })
    expect(await res.json()).toMatchObject({ challenge: { challengeId: "ch_1", nonce: "nonce_1" } })
  })

  test("a challenge against a cloud-backed workspace conflicts (409) and never mutates it", async () => {
    const convex = fakeConvexAuthority({
      createLocalHostLinkChallenge: vi.fn(async () => {
        throw new Error("workspace_backing_conflict: cannot attach a local host link to a cloud workspace")
      }),
    })
    const { app } = buildApp({ authority: convex })
    const res = await app.fetch(post("/ws_1/user-hosted/challenge", { hostId: "host_1" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "workspace_backing_conflict" } })
    expect(convex!.registerLocalForSharing).not.toHaveBeenCalled()
  })
})

describe("hosted heartbeat (client-signed)", () => {
  test("forwards the client signature and re-mints the host tunnel token", async () => {
    const convex = fakeConvexAuthority({
      heartbeatLocalHostLink: vi.fn(async () => ({
        host_id: "host_1",
        workspace_id: "ws_1",
        home_region: "apac-south",
        expires_at: 9_999,
      })),
    })
    const { app } = buildApp({
      authority: convex,
      options: {
        relayUrls: {
          "apac-south": "https://relay.apac.test",
        },
      },
    })
    const res = await app.fetch(
      post("/ws_1/user-hosted/heartbeat", {
        hostId: "host_1",
        signature: "client-heartbeat-sig",
        ttlMs: 60_000,
      }),
    )
    expect(res.status).toBe(200)
    expect(convex!.heartbeatLocalHostLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hostId: "host_1", signature: "client-heartbeat-sig", ttlMs: 60_000 }),
    )
    expect(await res.json()).toMatchObject({
      hostTunnel: {
        hostTunnelToken: "htt-for-host_1",
        homeRegion: "apac-south",
        relayUrl: "https://relay.apac.test",
      },
    })
  })
})

describe("hosted pause", () => {
  test("pauses the link in Convex and audits local_host_link.disabled", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(post("/ws_1/user-hosted/pause", { hostId: "host_1", paused: true }))
    expect(res.status).toBe(200)
    expect(convex!.pauseLocalHostLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: "ws_1", hostId: "host_1", paused: true }),
    )
    expect(convex!.auditAllow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "local_host_link.disabled" }),
    )
  })
})

describe("hosted connection", () => {
  test("mints a Runtime Access Token for a user-hosted workspace", async () => {
    const { app, convex, capture } = buildApp({})
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(convex!.recordRuntimeAccessToken).toHaveBeenCalled()
    expect(await res.json()).toMatchObject({
      access: "user-hosted",
      backing: "local-worktree",
      relayUrl: "https://relay.test",
      runtimeAccessToken: "rat-token",
    })
    expect(capture).toHaveBeenCalledWith("user_1", "workspace.connection.requested", {
      workspaceId: "ws_1",
      access: "user-hosted",
      backing: "local-worktree",
      runtimeKind: "user-hosted",
      homeRegion: "us-east",
      relayRoom: "ws_1",
      hostId: "host_1",
    })
    expect(capture).toHaveBeenCalledWith(
      "user_1",
      "runtime_access_token.minted",
      expect.objectContaining({
        workspaceId: "ws_1",
        access: "user-hosted",
        relayRoom: "ws_1",
        relayUrl: "https://relay.test",
        jti: "jti_rat",
      }),
    )
    expect(JSON.stringify(capture.mock.calls)).not.toContain("rat-token")
  })

  test("uses the workspace home_region to choose the regional relay endpoint", async () => {
    const convex = fakeConvexAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: {
          workspace_id: "ws_1",
          access: "user-hosted",
          backing: "local-worktree",
          home_region: "eu-west",
        },
      })),
    })
    const { app } = buildApp({
      authority: convex,
      options: {
        relayUrls: {
          "us-east": "https://relay.us.test",
          "eu-west": "https://relay.eu.test",
        },
      },
    })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      access: "user-hosted",
      runtimeKind: "user-hosted",
      homeRegion: "eu-west",
      relayUrl: "https://relay.eu.test",
    })
  })

  test("supports the provider-neutral POST connection route", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(post("/ws_1/connection", {}))
    expect(res.status).toBe(200)
    expect(convex!.recordRuntimeAccessToken).toHaveBeenCalled()
    expect(await res.json()).toMatchObject({
      access: "user-hosted",
      backing: "local-worktree",
      workspaceId: "ws_1",
      relayUrl: "https://relay.test",
      runtimeAccessToken: "rat-token",
    })
  })

  test("returns provisioning metadata for a cloud workspace while ensure is still acquiring", async () => {
    const convex = fakeConvexAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "apac-south" },
      })),
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 3, homeRegion: "apac-south" })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: convex, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(sandboxManager.ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "apac-south" })
    expect(capture).toHaveBeenCalledWith("user_1", "workspace.connection.requested", {
      workspaceId: "ws_1",
      access: "cloud",
      backing: "cloud-vm",
      runtimeKind: "cloud",
      homeRegion: "apac-south",
      relayRoom: "ws_1",
    })
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.ensure", {
      workspaceId: "ws_1",
      status: "provisioning",
      homeRegion: "apac-south",
      relayRoom: "ws_1",
      leaseEpoch: 3,
      retryAfterMs: 2_000,
    })
    expect(await res.json()).toEqual({
      status: "provisioning",
      workspaceId: "ws_1",
      runtimeKind: "cloud",
      homeRegion: "apac-south",
      retryAfterMs: 2_000,
    })
  })

  test("mints a Runtime Access Token for a ready cloud workspace without driver internals", async () => {
    const convex = fakeConvexAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "editor",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "eu-west" },
      })),
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready",
        sandboxId: "sandbox_1",
        url: "https://runtime.test/ws_1",
        hostId: "host_cloud_1",
        driverResourceId: "driver-resource-secret-id",
        epoch: 8,
        homeRegion: "eu-west",
      })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: convex, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(200)
    expect(convex.recordRuntimeAccessToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: "ws_1", hostId: "host_cloud_1" }),
    )
    expect(convex.auditAllow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "runtime_access_token.minted",
        metadata: expect.objectContaining({
          jti: "jti_rat",
          hostId: "host_cloud_1",
          leaseEpoch: 8,
          driverResourceId: "driver-resource-secret-id",
          relayRoom: "ws_1",
          relayUrl: "https://relay.test",
        }),
      }),
    )
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.ensure", {
      workspaceId: "ws_1",
      status: "ready",
      homeRegion: "eu-west",
      relayRoom: "ws_1",
      hostId: "host_cloud_1",
      leaseEpoch: 8,
      driverResourceId: "driver-resource-secret-id",
    })
    expect(capture).toHaveBeenCalledWith(
      "user_1",
      "runtime_access_token.minted",
      expect.objectContaining({
        workspaceId: "ws_1",
        access: "cloud",
        backing: "cloud-vm",
        relayRoom: "ws_1",
        relayUrl: "https://relay.test",
        driverResourceId: "driver-resource-secret-id",
        jti: "jti_rat",
      }),
    )
    expect(JSON.stringify(capture.mock.calls)).not.toContain("rat-token")
    const body = await res.json()
    expect(body).toMatchObject({
      access: "cloud",
      backing: "cloud-vm",
      runtimeKind: "cloud",
      workspaceId: "ws_1",
      homeRegion: "eu-west",
      relayUrl: "https://relay.test",
      runtimeAccessToken: "rat-token",
      role: "editor",
      hostId: "host_cloud_1",
    })
    expect(body).not.toHaveProperty("sandboxId")
    expect(body).not.toHaveProperty("runtimeUrl")
    expect(body).not.toHaveProperty("driverResourceId")
  })

  test("emits structured telemetry when a cloud runtime is unavailable", async () => {
    const convex = fakeConvexAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "eu-west" },
      })),
    })
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "unavailable",
        retryAfterMs: 5_000,
        error: "retry cap reached",
        epoch: 9,
        homeRegion: "eu-west",
      })),
    } as unknown as SandboxManager
    const { app, capture } = buildApp({ authority: convex, sandboxManager })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: {
        code: "cloud_runtime_unavailable",
        retryAfterMs: 5_000,
      },
    })
    expect(capture).toHaveBeenCalledWith("user_1", "sandbox.ensure", {
      workspaceId: "ws_1",
      status: "unavailable",
      homeRegion: "eu-west",
      relayRoom: "ws_1",
      retryAfterMs: 5_000,
    })
    expect(capture).toHaveBeenCalledWith("user_1", "workspace.connection.unavailable", {
      workspaceId: "ws_1",
      runtimeKind: "cloud",
      homeRegion: "eu-west",
      relayRoom: "ws_1",
      retryAfterMs: 5_000,
    })
  })

  test("fails closed when a cloud workspace has no sandbox", async () => {
    const convex = fakeConvexAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm" },
      })),
    })
    const { app } = buildApp({ authority: convex })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "sandbox_unavailable" } })
  })

  test("fails closed (503) when the Runtime Access Token signer is missing", async () => {
    const { app } = buildApp({ options: { runtimeAccessTokenSigner: undefined } })
    const res = await app.fetch(get("/ws_1/connection"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "runtime_access_token_signer_unavailable" } })
  })

  test("rejects a request with no bearer token", async () => {
    const { app } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/ws_1/connection"))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
  })

  test("rejects a malformed refresh body with a stable 400 instead of a 500", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(post("/ws_1/connection/refresh", { previousJti: 42 }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request_body" } })
    expect(convex!.usersMe).not.toHaveBeenCalled()
  })
})

describe("hosted connection rate limiting (mint-only)", () => {
  function cloudWorkspaceConvex() {
    return fakeConvexAuthority({
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", access: "cloud", backing: "cloud-vm", home_region: "us-east" },
      })),
    })
  }

  test("10 consecutive provisioning polls never hit the Runtime Access Token mint limit", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" })),
    } as unknown as SandboxManager
    const { app } = buildApp({ authority: cloudWorkspaceConvex(), sandboxManager })

    // Default mint limit is 6/min; a 2s-poll cold start must survive far past it.
    for (let i = 0; i < 10; i++) {
      const res = await app.fetch(get("/ws_1/connection"))
      expect(res.status, `provisioning poll ${i + 1} must not be rate limited`).toBe(200)
      expect(await res.json()).toMatchObject({ status: "provisioning" })
    }
  })

  test("provisioning polls bypass the budget but actual mints still hit the cap", async () => {
    const ready = {
      status: "ready",
      sandboxId: "sandbox_1",
      url: "https://runtime.test/ws_1",
      hostId: "host_cloud_1",
      epoch: 2,
      homeRegion: "us-east",
    }
    const ensure = vi.fn(async () => ready as never)
    ensure
      .mockResolvedValueOnce({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" } as never)
      .mockResolvedValueOnce({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" } as never)
      .mockResolvedValueOnce({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" } as never)
    const sandboxManager = { ensure } as unknown as SandboxManager
    const { app, convex } = buildApp({
      authority: cloudWorkspaceConvex(),
      sandboxManager,
      options: {
        connectionRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 2, windowMs: 60_000 }),
      },
    })

    // Three provisioning polls — all bypass/refund the mint budget.
    for (let i = 0; i < 3; i++) {
      expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    }
    // Two real mints consume the budget…
    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    expect(convex!.recordRuntimeAccessToken).toHaveBeenCalledTimes(2)
    // …and the third mint attempt is rejected at the cap.
    const limited = await app.fetch(get("/ws_1/connection"))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "runtime_access_token_rate_limited" } })
  })

  test("provisioning polls beyond the control-plane request cap get 429 before any Convex read", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" })),
    } as unknown as SandboxManager
    const { app, convex } = buildApp({
      authority: cloudWorkspaceConvex(),
      sandboxManager,
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 3, windowMs: 60_000 }),
      },
    })

    // The mint budget is refunded for provisioning responses, so the
    // control-plane limiter is what caps a provisioning-poll flood.
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(get("/ws_1/connection"))
      expect(res.status, `poll ${i + 1} within the cap must pass`).toBe(200)
      expect(await res.json()).toMatchObject({ status: "provisioning" })
    }
    const convexReadsAtCap = convex!.usersMe.mock.calls.length

    for (let i = 0; i < 4; i++) {
      const limited = await app.fetch(get("/ws_1/connection"))
      expect(limited.status, `poll ${i + 4} past the cap must be rejected`).toBe(429)
      expect(await limited.json()).toMatchObject({ error: { code: "control_plane_rate_limited" } })
    }
    // Rejected polls never reached Convex reads.
    expect(convex!.usersMe.mock.calls.length).toBe(convexReadsAtCap)
    expect(sandboxManager.ensure).toHaveBeenCalledTimes(3)
  })

  test("repeated rate-limit rejections in one window audit to Convex exactly once", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" })),
    } as unknown as SandboxManager
    const { app, convex } = buildApp({
      authority: cloudWorkspaceConvex(),
      sandboxManager,
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
    })

    expect((await app.fetch(get("/ws_1/connection"))).status).toBe(200)
    for (let i = 0; i < 5; i++) {
      expect((await app.fetch(get("/ws_1/connection"))).status).toBe(429)
    }
    // A sustained flood produces ONE audit write per window, not one per request.
    expect(convex!.auditDeny).toHaveBeenCalledTimes(1)
    expect(convex!.auditDeny).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "workspace.connection.denied",
        reason: "control_plane_rate_limited",
        workspaceId: "ws_1",
      }),
    )
  })
})

describe("hosted heartbeat rate limiting", () => {
  test("is keyed on caller+workspace — rotating the client-supplied hostId cannot bypass it — and runs before any Convex call", async () => {
    const { app, convex } = buildApp({
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 2, windowMs: 60_000 }),
      },
    })

    const heartbeat = (hostId: string) => app.fetch(post("/ws_1/user-hosted/heartbeat", { hostId, signature: "sig" }))

    expect((await heartbeat("host_a")).status).toBe(200)
    expect((await heartbeat("host_b")).status).toBe(200)
    // Third request rotates the hostId again — still the same bucket.
    const limited = await heartbeat("host_c")
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "control_plane_rate_limited" } })
    // The denied request was rejected BEFORE reaching Convex user resolution.
    expect(convex!.usersMe).toHaveBeenCalledTimes(2)
    expect(convex!.heartbeatLocalHostLink).toHaveBeenCalledTimes(2)
  })
})

describe("hosted workspace list (GET /api/workspace)", () => {
  test("signed access=user-hosted returns only the caller's user-hosted workspaces", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(get("/?access=user-hosted"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { workspaces: Array<{ workspace_id: string }> }
    expect(json.workspaces).toEqual([{ workspace_id: "ws_user", access: "user-hosted" }])
    expect(convex!.usersMe).toHaveBeenCalledTimes(1)
    expect(convex!.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  test("signed access=cloud returns the full list (no user-hosted filter)", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(get("/?access=cloud"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { workspaces: Array<{ workspace_id: string }> }
    expect(json.workspaces).toEqual([
      { workspace_id: "ws_user", access: "user-hosted" },
      { workspace_id: "ws_cloud", access: "cloud" },
    ])
    expect(convex!.listWorkspaces).toHaveBeenCalledTimes(1)
  })

  test("unsigned (no access query) returns an empty list and never touches Convex", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspaces: [] })
    // Hosted has no local projects list — no Convex read on the unsigned path.
    expect(convex!.usersMe).not.toHaveBeenCalled()
    expect(convex!.listWorkspaces).not.toHaveBeenCalled()
  })

  test("access=user-hosted with no bearer token fails closed (signed required)", async () => {
    const { app, convex } = buildApp({})
    const res = await app.fetch(new Request("http://cp.test/?access=user-hosted"))
    expect(res.status).toBe(401)
    expect(convex!.listWorkspaces).not.toHaveBeenCalled()
  })

  test("honors the control-plane rate limiter", async () => {
    const { app, convex } = buildApp({
      options: {
        controlPlaneRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
    })
    expect((await app.fetch(get("/?access=user-hosted"))).status).toBe(200)
    const limited = await app.fetch(get("/?access=user-hosted"))
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: "control_plane_rate_limited" } })
    // The rate-limited request did not reach the workspace listing.
    expect(convex!.listWorkspaces).toHaveBeenCalledTimes(1)
  })
})

describe("hosted cloud workspace create (POST /create)", () => {
  test("503 sandbox_driver_unavailable when no sandbox driver is composed", async () => {
    const convex = fakeConvexAuthority()
    const { app } = buildApp({ authority: convex })
    const res = await app.fetch(post("/create", { projectId: "proj_1" }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "sandbox_driver_unavailable" } })
  })

  test("creates the cloud workspace doc and kicks off provisioning", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const convex = fakeConvexAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const sandboxManager = { ensure } as unknown as SandboxManager
    const { app } = buildApp({ authority: convex, sandboxManager })

    const res = await app.fetch(
      post("/create", { projectId: "proj_1", workspaceName: "Feature X", repoUrl: "https://github.com/a/b" }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workspaceId: string; directory: string }
    expect(body.workspaceId).toMatch(/^ws_/)
    expect(body.directory).toBe("/workspace")

    expect(createCloudWorkspace).toHaveBeenCalledTimes(1)
    const args = (createCloudWorkspace.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(args).toMatchObject({
      workspaceId: body.workspaceId,
      projectId: "proj_1",
      displayName: "Feature X",
      repoUrl: "https://github.com/a/b",
      homeRegion: "us-east",
    })
    // provisioning kicked off for the same workspace id (fire-and-forget)
    await Promise.resolve()
    expect(ensure).toHaveBeenCalledTimes(1)
    const [ensuredWorkspaceId, ensured] = ensure.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ]
    expect(ensuredWorkspaceId).toBe(body.workspaceId)
    expect(ensured).toMatchObject({
      homeRegion: "us-east",
      labels: {
        projectId: "proj_1",
      },
      workspaceRoot: "/workspace",
      source: {
        kind: "git",
        repoUrl: "https://github.com/a/b",
      },
    })
    // Hosted creates are always egress-contained (security review §6.14). The
    // allowlist contents are pinned in `hosted-workspace-egress.test.ts`; what
    // matters here is that this call site cannot go back to allow-all.
    expect(ensured.net).toMatchObject({ mode: "restricted" })
  })

  test("rejects hosted cloud create without a clone source", async () => {
    const createCloudWorkspace = vi.fn(async () => ({ workspace_id: "ignored" }))
    const convex = fakeConvexAuthority({ createCloudWorkspace })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({
      authority: convex,
      sandboxManager: { ensure } as unknown as SandboxManager,
    })

    const res = await app.fetch(post("/create", { projectId: "proj_1", workspaceName: "Feature X" }))

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "cloud_workspace_source_required" },
    })
    expect(createCloudWorkspace).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  test("requires a signed bearer token", async () => {
    const convex = fakeConvexAuthority({ createCloudWorkspace: vi.fn(async () => ({})) })
    const ensure = vi.fn(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east" }))
    const { app } = buildApp({
      authority: convex,
      sandboxManager: { ensure } as unknown as SandboxManager,
    })
    const res = await app.fetch(
      new Request("http://cp.test/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect([401, 403]).toContain(res.status)
  })
})
