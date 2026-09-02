import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"

import { D1WorkspaceAuthority } from "./workspace-authority"
import {
  D1HostAccessAuthority,
  hostEnrollmentHeartbeatPayloadV2,
  hostEnrollmentPayload,
} from "./host-access-authority"

const MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0012_cold_local_host_challenges.sql",
  "0013_org_team_session_sharing.sql",
  "0014_host_workspace_assignments.sql",
  "0015_drop_local_host_links.sql",
].map((name) => fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url)))

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function setup() {
  const { database } = await emptyDatabase()
  for (const path of MIGRATIONS) await applyMigration(database, path)
  let clock = 1_800_000_000_000
  let sequence = 0
  const now = () => clock
  const workspace = new D1WorkspaceAuthority(database, {
    deploymentId: "deployment-a",
    product: { kind: "claxedo-hosted" },
    now,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  const hostAccess = new D1HostAccessAuthority(database, {
    deploymentId: "deployment-a",
    now,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
    randomNonce: () => `nonce_${String(++sequence).padStart(4, "0")}`,
    registerLocalForSharing: (auth, input) => workspace.registerLocalForSharing(auth, input),
  })
  return {
    database,
    workspace,
    hostAccess,
    advance(milliseconds: number) {
      clock += milliseconds
    },
  }
}

async function emptyDatabase() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  return { database }
}

async function applyMigration(database: Awaited<ReturnType<Miniflare["getD1Database"]>>, path: string) {
  const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
    await database.prepare(statement).run()
  }
}

function identity(subject: string): AuthIdentity {
  return { adapter: "better-auth", issuer: "https://auth.example.test", subject }
}

async function signed(authority: D1WorkspaceAuthority, subject: string): Promise<SignedControlPlaneAuth> {
  const applicationIdentity = identity(subject)
  const result = await authority.ensureApplicationIdentity(applicationIdentity)
  if (result.state !== "active") throw new Error(`identity did not become active: ${result.state}`)
  const principal: ControlPlanePrincipal = {
    userId: result.userId,
    actorId: result.actorId,
    actorKind: "human",
    deploymentId: "deployment-a",
    sessionId: `auth:${subject}`,
    authenticatedAt: 1_800_000_000_000,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: {
      kind: "browser",
      tokenKind: "browser-session",
      id: "browser",
      resource: "https://api.example.test",
      scopes: ["openid"],
      origin: "https://app.example.test",
    },
    identity: applicationIdentity,
  }
  return {
    mode: "signed",
    principal,
    user: {
      subject,
      tokenIdentifier: `${applicationIdentity.issuer}|${subject}`,
      issuer: applicationIdentity.issuer,
    },
  }
}

async function fixture(input: Awaited<ReturnType<typeof setup>>) {
  const alice = await signed(input.workspace, "alice")
  const bob = await signed(input.workspace, "bob")
  const admin = await signed(input.workspace, "admin")
  const outsider = await signed(input.workspace, "outsider")
  await input.workspace.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  await input.workspace.addOrganizationMember(alice, {
    orgId: "org_acme",
    userId: bob.principal!.userId,
    role: "member",
  })
  await input.workspace.addOrganizationMember(alice, {
    orgId: "org_acme",
    userId: admin.principal!.userId,
    role: "admin",
  })
  const local = await input.workspace.createWorkspace(alice, {
    workspaceId: "ws_local",
    orgId: "org_acme",
    displayName: "local",
    repoUrl: "https://github.com/acme/local.git",
    backing: "local-worktree",
    access: "user-hosted",
  })
  await input.workspace.createWorkspace(alice, {
    workspaceId: "ws_cloud",
    orgId: "org_acme",
    displayName: "cloud",
    repoUrl: "https://github.com/acme/cloud.git",
    backing: "cloud-vm",
    access: "cloud",
  })
  return { alice, bob, admin, outsider, local }
}

async function hostKey() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )
  return {
    publicKey: JSON.stringify(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
    async sign(payload: string) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        new TextEncoder().encode(payload),
      )
      return base64Url(new Uint8Array(signature))
    },
  }
}

function base64Url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url")
}

describe("D1 host access and workspace sharing authority", () => {
  test("preserves direct membership data while replacing the legacy table with the grant-aware view", async () => {
    const { database } = await emptyDatabase()
    await applyMigration(database, MIGRATIONS[0]!)
    await applyMigration(database, MIGRATIONS[1]!)
    await database.batch([
      database.prepare(`insert into users values ('user-owner', 'active', 1, 1, null, null)`),
      database.prepare(`insert into users values ('user-member', 'active', 1, 1, null, null)`),
      database.prepare(`
        insert into orgs values ('org-upgrade', 'Upgrade', 'team', 'user-owner', null, 1, 1, null)
      `),
      database.prepare(`
        insert into org_memberships values ('org-upgrade', 'user-owner', 'owner', 1, 1, null)
      `),
      database.prepare(`
        insert into org_memberships values ('org-upgrade', 'user-member', 'member', 1, 1, null)
      `),
      database.prepare(`
        insert into projects values ('project-upgrade', 'org-upgrade', 'github.com/acme/upgrade', 'user-owner', 1, 1, null)
      `),
      database.prepare(`
        insert into workspaces values (
          'workspace-upgrade', 'org-upgrade', 'project-upgrade', 'user-owner',
          'local-worktree', 'user-hosted', 'Upgrade', null, null, null, null, null, 1, 1, null
        )
      `),
      database.prepare(`
        insert into workspace_memberships values ('workspace-upgrade', 'user-member', 'editor', 1, 1, null)
      `),
    ])
    await applyMigration(database, MIGRATIONS[2]!)
    await applyMigration(database, MIGRATIONS[3]!)

    expect(await database.prepare(`
      select role from workspace_direct_memberships
      where workspace_id = 'workspace-upgrade' and user_id = 'user-member'
    `).first()).toEqual({ role: "editor" })
    expect(await database.prepare(`
      select role from workspace_memberships
      where workspace_id = 'workspace-upgrade' and user_id = 'user-member'
    `).first()).toEqual({ role: "editor" })
    expect(await database.prepare(`
      select name from sqlite_master where type = 'index' and name = 'workspace_direct_memberships_by_user'
    `).first()).toEqual({ name: "workspace_direct_memberships_by_user" })
  })

  test("cold-registers a user-hosted workspace the first time an owner assigns it to an enrolled host", async () => {
    const input = await setup()
    const alice = await signed(input.workspace, "cold-owner")
    const key = await hostKey()
    const request = await input.hostAccess.createHostEnrollmentRequest(alice, { hostId: "host-cold" })
    await input.hostAccess.enrollHost(alice, {
      hostId: "host-cold",
      publicKey: key.publicKey,
      requestId: request.request_id,
      signature: await key.sign(hostEnrollmentPayload({
        hostId: "host-cold",
        requestId: request.request_id,
        nonce: request.nonce,
      })),
    })

    // Enrolling a machine creates nothing to own: the workspace row appears
    // only when the owner assigns the workspace to it.
    expect(await input.database.prepare(
      "select 1 from workspaces where workspace_id = 'ws_cold'",
    ).first()).toBeNull()

    await expect(input.hostAccess.assignWorkspaceHost(alice, {
      workspaceId: "ws_cold",
      hostId: "host-cold",
      displayName: "Cold workspace",
      repoUrl: "https://github.com/acme/cold.git",
      remoteDirectory: "/workspace/cold",
      homeRegion: "apac-south",
    })).resolves.toMatchObject({ assigned: true, workspace_id: "ws_cold", host_id: "host-cold" })

    await expect(input.workspace.openWorkspace(alice, { workspaceId: "ws_cold" })).resolves.toMatchObject({
      workspace: {
        backing: "local-worktree",
        access: "user-hosted",
        display_name: "Cold workspace",
        repo_url: "https://github.com/acme/cold.git",
        remote_directory: "/workspace/cold",
        home_region: "apac-south",
      },
    })

    // An assignment against a machine this owner never enrolled is refused,
    // which is what keeps the cold-registration path from minting workspaces
    // for an unattested host id.
    await expect(input.hostAccess.assignWorkspaceHost(alice, {
      workspaceId: "ws_colder",
      hostId: "host-unknown",
    })).rejects.toMatchObject({ code: "host_attestation_denied" })
    expect(await input.database.prepare(
      "select 1 from workspaces where workspace_id = 'ws_colder'",
    ).first()).toBeNull()
  })

  /**
   * A machine assigns a workspace it serves and says what it is — name,
   * repository, branch, directory — and every client reads that description.
   */
  test("assigning an existing workspace records the machine's description of it", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const key = await hostKey()
    const request = await input.hostAccess.createHostEnrollmentRequest(alice, { hostId: "machine-d" })
    await input.hostAccess.enrollHost(alice, {
      hostId: "machine-d",
      publicKey: key.publicKey,
      requestId: request.request_id,
      signature: await key.sign(hostEnrollmentPayload({
        hostId: "machine-d",
        requestId: request.request_id,
        nonce: request.nonce,
      })),
      ttlMs: 8_000,
    })
    await input.hostAccess.assignWorkspaceHost(alice, {
      workspaceId: "ws_local",
      hostId: "machine-d",
      displayName: "Claxedo",
      repoName: "Claxedo",
      gitBranch: "dev",
      remoteDirectory: "/Users/me/test/opencode",
    })
    expect(await input.database.prepare(
      "select display_name, repo_name, git_branch, remote_directory from workspaces where workspace_id = 'ws_local'",
    ).first()).toEqual({
      display_name: "Claxedo",
      repo_name: "Claxedo",
      git_branch: "dev",
      remote_directory: "/Users/me/test/opencode",
    })
    // A later assignment that says nothing leaves the description alone.
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-d" })
    expect(await input.database.prepare(
      "select display_name, remote_directory from workspaces where workspace_id = 'ws_local'",
    ).first()).toEqual({ display_name: "Claxedo", remote_directory: "/Users/me/test/opencode" })
  })

  /**
   * A user-hosted workspace is the share itself: unsharing retires it from the
   * inventory, revoking the machine retires everything it served, and sharing
   * again revives the same record instead of colliding with it.
   */
  test("a user-hosted workspace lives exactly as long as its host assignment", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const key = await hostKey()
    const request = await input.hostAccess.createHostEnrollmentRequest(alice, { hostId: "machine-l" })
    await input.hostAccess.enrollHost(alice, {
      hostId: "machine-l",
      publicKey: key.publicKey,
      requestId: request.request_id,
      signature: await key.sign(hostEnrollmentPayload({
        hostId: "machine-l",
        requestId: request.request_id,
        nonce: request.nonce,
      })),
    })
    const listed = async () => (await input.workspace.listWorkspaces(alice) as Array<{ workspace_id: string }>)
      .map((row) => row.workspace_id).sort()

    await input.workspace.createWorkspace(alice, {
      workspaceId: "ws_shared",
      orgId: "org_acme",
      displayName: "Shared",
      backing: "local-worktree",
      access: "user-hosted",
    })
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_shared", hostId: "machine-l" })
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-l" })
    expect(await listed()).toEqual(["ws_cloud", "ws_local", "ws_shared"])

    // Unsharing one retires exactly that one.
    await expect(input.hostAccess.unassignWorkspaceHost(alice, { workspaceId: "ws_shared" })).resolves.toEqual({ unassigned: true })
    expect(await listed()).toEqual(["ws_cloud", "ws_local"])
    await expect(input.workspace.openWorkspace(alice, { workspaceId: "ws_shared" })).rejects.toBeDefined()

    // Sharing it again revives the same record, description intact.
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_shared", hostId: "machine-l" })
    expect(await listed()).toEqual(["ws_cloud", "ws_local", "ws_shared"])
    await expect(input.workspace.openWorkspace(alice, { workspaceId: "ws_shared" })).resolves.toMatchObject({
      workspace: { access: "user-hosted", display_name: "Shared" },
    })

    // Revoking the machine retires everything it served; the fixture's cloud row is untouched.
    await input.hostAccess.revokeHostEnrollment(alice, { hostId: "machine-l" })
    expect(await listed()).toEqual(["ws_cloud"])
  })

  test("routes a workspace through owner assignment AND the machine's acked set on a live lease", async () => {
    const input = await setup()
    const { alice, outsider } = await fixture(input)
    const key = await hostKey()
    const request = await input.hostAccess.createHostEnrollmentRequest(alice, { hostId: "machine-b" })
    await input.hostAccess.enrollHost(alice, {
      hostId: "machine-b",
      publicKey: key.publicKey,
      requestId: request.request_id,
      signature: await key.sign(hostEnrollmentPayload({
        hostId: "machine-b",
        requestId: request.request_id,
        nonce: request.nonce,
      })),
      displayName: "Laptop B",
      ttlMs: 8_000,
    })

    // Owner intent alone is not routable: no ack yet.
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-b" })
    expect(await input.hostAccess.activeWorkspaceHost(alice, { workspaceId: "ws_local" }))
      .toEqual({ active: false })

    // A signature over a DIFFERENT set than the one claimed is rejected.
    await expect(input.hostAccess.heartbeatHostEnrollment(alice, {
      hostId: "machine-b",
      signature: await key.sign(hostEnrollmentHeartbeatPayloadV2({
        hostId: "machine-b",
        ttlMs: 8_000,
        workspaceIds: [],
      })),
      ttlMs: 8_000,
      workspaceIds: ["ws_local"],
    })).rejects.toMatchObject({ code: "host_attestation_denied" })

    // Ack the set: now routable, and the response reconciles owner intent.
    const beat = await input.hostAccess.heartbeatHostEnrollment(alice, {
      hostId: "machine-b",
      signature: await key.sign(hostEnrollmentHeartbeatPayloadV2({
        hostId: "machine-b",
        ttlMs: 8_000,
        workspaceIds: ["ws_local"],
      })),
      ttlMs: 8_000,
      workspaceIds: ["ws_local"],
    })
    expect(beat.assigned_workspace_ids).toEqual(["ws_local"])
    expect(await input.hostAccess.activeWorkspaceHost(alice, { workspaceId: "ws_local" }))
      .toMatchObject({ active: true, host_id: "machine-b", workspace_id: "ws_local", display_name: "Laptop B" })
    expect(await input.hostAccess.listHostAssignments(alice)).toMatchObject([
      { host_id: "machine-b", display_name: "Laptop B", workspace_ids: ["ws_local"], acked_workspace_ids: ["ws_local"] },
    ])

    // A second local workspace on the same host groups into one device row.
    await input.workspace.createWorkspace(alice, {
      workspaceId: "ws_local_2",
      orgId: "org_acme",
      displayName: "local-2",
      backing: "local-worktree",
      access: "user-hosted",
    })
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local_2", hostId: "machine-b" })
    expect(await input.hostAccess.listHostAssignments(alice)).toMatchObject([
      { host_id: "machine-b", workspace_ids: ["ws_local", "ws_local_2"] },
    ])

    // An outsider can neither assign nor read the routable host.
    await expect(input.hostAccess.assignWorkspaceHost(outsider, { workspaceId: "ws_local", hostId: "machine-b" }))
      .rejects.toMatchObject({ code: "host_attestation_denied" })

    // Unsharing retires the workspace: nothing is routable because nothing is listed.
    await input.hostAccess.unassignWorkspaceHost(alice, { workspaceId: "ws_local" })
    await expect(input.hostAccess.activeWorkspaceHost(alice, { workspaceId: "ws_local" }))
      .rejects.toMatchObject({ code: "workspace_authorization_denied" })

    // The lease expiring makes everything inert without touching assignments.
    input.advance(8_001)
    expect(await input.hostAccess.activeWorkspaceHost(alice, { workspaceId: "ws_local_2" }))
      .toEqual({ active: false })
    expect(await input.hostAccess.listHostAssignments(alice)).toEqual([])

    // Revoke cascades the remaining assignments away entirely.
    await input.hostAccess.revokeHostEnrollment(alice, { hostId: "machine-b" })
    const dangling = await input.database
      .prepare("select count(*) as n from host_workspace_assignments")
      .first<{ n: number }>()
    expect(dangling?.n).toBe(0)
    // The machine's workspaces go with it; the fixture's cloud row stays.
    expect((await input.workspace.listWorkspaces(alice) as Array<{ workspace_id: string }>).map((row) => row.workspace_id))
      .toEqual(["ws_cloud"])
  })

  /**
   * The rail must be able to say "host offline" for a shared workspace before
   * any pane opens it, so reachability rides the workspace LIST rather than a
   * per-workspace probe. It is the same lease `activeWorkspaceHost` routes on.
   */
  test("stamps host reachability on every user-hosted row of the workspace list", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const key = await hostKey()
    const request = await input.hostAccess.createHostEnrollmentRequest(alice, { hostId: "machine-c" })
    await input.hostAccess.enrollHost(alice, {
      hostId: "machine-c",
      publicKey: key.publicKey,
      requestId: request.request_id,
      signature: await key.sign(hostEnrollmentPayload({
        hostId: "machine-c",
        requestId: request.request_id,
        nonce: request.nonce,
      })),
      ttlMs: 8_000,
    })
    const listed = async () =>
      Object.fromEntries(
        (await input.workspace.listWorkspaces(alice) as Array<{ workspace_id: string; host_online?: boolean }>)
          .map((row) => [row.workspace_id, row.host_online]),
      )

    // Assigned but never acked: listed, and honestly offline.
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-c" })
    expect(await listed()).toEqual({ ws_cloud: undefined, ws_local: false })

    await input.hostAccess.heartbeatHostEnrollment(alice, {
      hostId: "machine-c",
      signature: await key.sign(hostEnrollmentHeartbeatPayloadV2({
        hostId: "machine-c",
        ttlMs: 8_000,
        workspaceIds: ["ws_local"],
      })),
      ttlMs: 8_000,
      workspaceIds: ["ws_local"],
    })
    expect(await listed()).toEqual({ ws_cloud: undefined, ws_local: true })

    // The lease expiring is what makes it unreachable — no revoke, no unassign.
    input.advance(8_001)
    expect(await listed()).toEqual({ ws_cloud: undefined, ws_local: false })
    expect(await input.hostAccess.activeWorkspaceHost(alice, { workspaceId: "ws_local" })).toEqual({ active: false })
  })

  test("enrolls a machine once per canonical owner with expiry, pause, revoke, and replay resistance", async () => {
    const input = await setup()
    const { alice, outsider } = await fixture(input)
    const key = await hostKey()
    const request = await input.hostAccess.createHostEnrollmentRequest(alice, { hostId: "machine-a" })
    const signature = await key.sign(hostEnrollmentPayload({
      hostId: "machine-a",
      requestId: request.request_id,
      nonce: request.nonce,
    }))
    await expect(input.hostAccess.enrollHost(outsider, {
      hostId: "machine-a",
      publicKey: key.publicKey,
      requestId: request.request_id,
      signature,
    })).rejects.toMatchObject({ code: "host_attestation_denied" })
    const enrolled = await input.hostAccess.enrollHost(alice, {
      hostId: "machine-a",
      publicKey: key.publicKey,
      requestId: request.request_id,
      signature,
      displayName: "Laptop",
      ttlMs: 8_000,
    })
    expect(enrolled).toMatchObject({ host_id: "machine-a", display_name: "Laptop" })
    await expect(input.hostAccess.enrollHost(alice, {
      hostId: "machine-a",
      publicKey: key.publicKey,
      requestId: request.request_id,
      signature,
    })).rejects.toMatchObject({ code: "host_attestation_denied" })
    expect(await input.hostAccess.activeHostEnrollment(alice)).toMatchObject({ active: true, host_id: "machine-a" })

    const heartbeat = await key.sign(
      hostEnrollmentHeartbeatPayloadV2({ hostId: "machine-a", ttlMs: 8_000, workspaceIds: [] }),
    )
    await input.hostAccess.heartbeatHostEnrollment(alice, {
      hostId: "machine-a",
      signature: heartbeat,
      ttlMs: 8_000,
      workspaceIds: [],
    })
    await expect(input.hostAccess.heartbeatHostEnrollment(alice, {
      hostId: "machine-a",
      signature: heartbeat,
      ttlMs: 8_000,
      workspaceIds: [],
    })).rejects.toMatchObject({ code: "signature_replayed" })

    await input.hostAccess.pauseHostEnrollment(alice, { hostId: "machine-a", paused: true })
    expect(await input.hostAccess.activeHostEnrollment(alice)).toEqual({ active: false, reason: "paused" })
    await input.hostAccess.pauseHostEnrollment(alice, { hostId: "machine-a", paused: false })
    input.advance(8_001)
    expect(await input.hostAccess.activeHostEnrollment(alice)).toEqual({ active: false, reason: "expired" })
    await input.hostAccess.recordRuntimeAccessToken(alice, {
      jti: "jti-machine",
      workspaceId: "ws_local",
      hostId: "machine-a",
      expiresAt: 1_800_000_100_000,
    })
    expect(await input.hostAccess.revokeHostEnrollment(alice, {
      hostId: "machine-a",
    })).toMatchObject({ revoked: 1, runtime_tokens_revoked: 1 })
    expect(await input.hostAccess.activeHostEnrollment(alice)).toEqual({ active: false, reason: "revoked" })
    expect(await input.hostAccess.runtimeAccessTokenActive({
      jti: "jti-machine",
      workspaceId: "ws_local",
      hostId: "machine-a",
    })).toMatchObject({ active: false, code: "runtime_access_token_revoked" })
    input.advance(10 * 60_000)
    await input.hostAccess.createHostEnrollmentRequest(alice, { hostId: "machine-next" })
    expect(await input.database.prepare(`
      select 1 from host_enrollment_requests where request_id = ?
    `).bind(request.request_id).first()).toBeNull()
  })

  test("uses canonical share targets and revokes their runtime tokens without crossing tenants", async () => {
    const input = await setup()
    const { alice, bob, outsider } = await fixture(input)
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_local" })).toMatchObject({ role: "viewer" })
    await expect(input.hostAccess.grantWorkspaceShare(alice, {
      workspaceId: "ws_local",
      role: "editor",
      target: { kind: "actor", actorId: outsider.principal!.actorId },
    })).rejects.toMatchObject({ status: 403 })

    const grant = await input.hostAccess.grantWorkspaceShare(alice, {
      workspaceId: "ws_local",
      role: "editor",
      target: { kind: "actor", actorId: bob.principal!.actorId },
    })
    expect(grant).toMatchObject({ created: true, grantId: expect.any(String) })
    expect(await input.hostAccess.grantWorkspaceShare(alice, {
      workspaceId: "ws_local",
      role: "editor",
      target: { kind: "actor", actorId: bob.principal!.actorId },
    })).toEqual({ created: false, grantId: grant.grantId })
    await expect(input.hostAccess.revokeWorkspaceShare(alice, {
      workspaceId: "ws_local",
      grantId: { id: grant.grantId } as never,
    })).rejects.toMatchObject({ code: "invalid_input" })
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_local" })).toMatchObject({ role: "editor" })
    await expect(input.hostAccess.grantWorkspaceShare(alice, {
      workspaceId: "ws_local",
      role: "admin",
      target: { kind: "actor", actorId: bob.principal!.actorId },
    })).rejects.toMatchObject({ code: "resource_conflict" })

    await input.hostAccess.recordRuntimeAccessToken(bob, {
      jti: "jti-bob",
      workspaceId: "ws_local",
      hostId: "host-a",
      expiresAt: 1_800_000_100_000,
    })
    expect(await input.hostAccess.runtimeAccessTokenActive({
      jti: "jti-bob",
      workspaceId: "ws_local",
      hostId: "host-a",
    })).toEqual({ active: true })
    await expect(input.hostAccess.recordRuntimeAccessToken(bob, {
      jti: "jti-bob",
      workspaceId: "ws_local",
      hostId: "host-other",
      expiresAt: 1_800_000_100_000,
    })).rejects.toMatchObject({ code: "resource_conflict" })
    await expect(input.hostAccess.recordRuntimeAccessTokenForActor({
      jti: "jti-provider-subject",
      workspaceId: "ws_local",
      hostId: "host-a",
      actorId: bob.user.subject,
      expiresAt: 1_800_000_100_000,
    })).rejects.toMatchObject({ status: 403 })
    await input.hostAccess.recordRuntimeAccessTokenForActor({
      jti: "jti-canonical-service",
      workspaceId: "ws_local",
      hostId: "host-a",
      actorId: bob.principal!.actorId,
      expiresAt: 1_800_000_100_000,
    })

    expect(await input.hostAccess.revokeWorkspaceShare(alice, {
      workspaceId: "ws_local",
      grantId: grant.grantId,
    })).toMatchObject({ revoked: true, runtime_tokens_revoked: 2 })
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_local" })).toMatchObject({ role: "viewer" })
    expect(await input.hostAccess.runtimeAccessTokenActive({
      jti: "jti-bob",
      workspaceId: "ws_local",
      hostId: "host-a",
    })).toMatchObject({ active: false, code: "runtime_access_token_revoked" })

    const userGrant = await input.hostAccess.grantWorkspaceShare(alice, {
      workspaceId: "ws_local",
      role: "admin",
      target: { kind: "user", userId: bob.principal!.userId },
    })
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_local" })).toMatchObject({ role: "admin" })
    await input.hostAccess.revokeWorkspaceShare(alice, {
      workspaceId: "ws_local",
      grantId: userGrant.grantId,
    })
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_local" })).toMatchObject({ role: "viewer" })

    await input.hostAccess.recordRuntimeAccessToken(bob, {
      jti: "jti-current-authority",
      workspaceId: "ws_local",
      hostId: "host-a",
      expiresAt: 1_800_000_100_000,
    })
    await input.database.prepare(`
      update org_memberships set revoked_at = ?, updated_at = ?
      where org_id = 'org_acme' and user_id = ?
    `).bind(1_800_000_000_001, 1_800_000_000_001, bob.principal!.userId).run()
    expect(await input.hostAccess.runtimeAccessTokenActive({
      jti: "jti-current-authority",
      workspaceId: "ws_local",
      hostId: "host-a",
    })).toMatchObject({ active: false, code: "runtime_access_token_revoked" })

    await input.hostAccess.recordRuntimeAccessToken(alice, {
      jti: "jti-alice",
      workspaceId: "ws_local",
      hostId: "host-a",
      expiresAt: 1_800_000_100_000,
    })
    expect(await input.hostAccess.runtimeAccessTokenActive({
      jti: "jti-alice",
      workspaceId: "ws_cloud",
      hostId: "host-a",
    })).toMatchObject({ active: false, code: "runtime_access_token_mismatch" })
    await expect(input.hostAccess.revokeRuntimeAccessToken(outsider, {
      jti: "jti-alice",
      workspaceId: "ws_local",
    })).rejects.toMatchObject({ status: 403 })
    expect(await input.hostAccess.runtimeAccessTokenActive({
      jti: "jti-alice",
      workspaceId: "ws_local",
      hostId: "host-a",
    })).toEqual({ active: true })
    await input.hostAccess.revokeRuntimeAccessToken(alice, { jti: "jti-alice", workspaceId: "ws_local" })
    expect(await input.hostAccess.runtimeAccessTokenActive({
      jti: "jti-alice",
      workspaceId: "ws_local",
      hostId: "host-a",
    })).toMatchObject({ active: false, code: "runtime_access_token_revoked" })

    await input.hostAccess.recordRuntimeAccessToken(alice, {
      jti: "jti-expiring",
      workspaceId: "ws_local",
      hostId: "host-a",
      expiresAt: 1_800_000_000_100,
    })
    input.advance(101)
    expect(await input.hostAccess.runtimeAccessTokenActive({
      jti: "jti-expiring",
      workspaceId: "ws_local",
      hostId: "host-a",
    })).toMatchObject({ active: false, code: "runtime_access_token_expired" })

    await expect(input.database.prepare(`
      update runtime_access_tokens set workspace_id = 'ws_cloud' where jti = 'jti-alice'
    `).run()).rejects.toThrow(/runtime access token intent is immutable/)
  })
})

function malleateP256Signature(input: string) {
  const value = Buffer.from(input, "base64url")
  if (value.byteLength !== 64) throw new Error("expected a raw P-256 signature")
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
  const s = BigInt(`0x${value.subarray(32).toString("hex")}`)
  const replacement = (order - s).toString(16).padStart(64, "0")
  Buffer.from(replacement, "hex").copy(value, 32)
  return value.toString("base64url")
}
