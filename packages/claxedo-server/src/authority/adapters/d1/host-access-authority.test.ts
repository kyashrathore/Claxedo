import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"

import type { D1PreparedStatement } from "@cloudflare/workers-types"
import type { MachinePrincipal } from "@claxedo/server-core/platform/auth/authority"
import {
  invitationRedeemPayload,
  invitationTokenParts,
  publicKeyFingerprint,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { sha256Hex } from "@claxedo/helpers/crypto"

import { D1WorkspaceAuthority } from "./workspace-authority"
import { createD1UserHostedTargetResolver } from "./user-hosted-relay-target"
import { D1HostAccessAuthority, hostEnrollmentPayload } from "./host-access-authority"

const MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0005_agent_extensions_and_audit.sql",
  "0012_cold_local_host_challenges.sql",
  "0013_org_team_session_sharing.sql",
  "0014_host_workspace_assignments.sql",
  "0015_drop_local_host_links.sql",
  "0016_host_session_authority.sql",
  "0028_workspace_org_member_visible.sql",
  "0029_host_connect.sql",
  "0030_workspace_host_assignment_revision.sql",
  "0031_normalize_user_hosted_directories.sql",
  "0034_drop_workspace_access.sql",
  "0035_session_share_level.sql",
  "0036_drop_workspace_share_role.sql",
  "0037_host_provider_config.sql",
].map(migrationPath)

function migrationPath(name: string) {
  return fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url))
}

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function setup() {
  const { database: raw } = await emptyDatabase()
  for (const path of MIGRATIONS) await applyMigration(raw, path)
  // A step run between a method's reads and its batch, which is where a
  // concurrent writer lands in production. Miniflare's D1 handle is a Proxy
  // that drops property sets, so the interception lives in a wrapper.
  let beforeBatch: (() => Promise<void>) | undefined
  const database = new Proxy(raw, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const step = beforeBatch
          beforeBatch = undefined
          if (step) await step()
          return await target.batch(statements)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
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
    localWorkspaceRegistration: (auth, input) => workspace.localWorkspaceRegistration(auth, input),
    resolveOrgId: (auth) => workspace.resolveOrgId(auth),
  })
  // No deployment pin: the fixture's organizations are team orgs, which carry
  // no deployment id, and the predicate under test is the serving one.
  const relayTarget = createD1UserHostedTargetResolver(database, { now })
  return {
    database,
    workspace,
    hostAccess,
    relayTarget,
    now,
    applyMigration: (name: string) => applyMigration(raw, migrationPath(name)),
    advance(milliseconds: number) {
      clock += milliseconds
    },
    beforeNextBatch(step: () => Promise<void>) {
      beforeBatch = step
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

async function signed(authority: D1WorkspaceAuthority, subject: string, orgId?: string): Promise<SignedControlPlaneAuth> {
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
      ...(orgId ? { orgId } : {}),
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
  })
  await input.workspace.createWorkspace(alice, {
    workspaceId: "ws_cloud",
    orgId: "org_acme",
    displayName: "cloud",
    repoUrl: "https://github.com/acme/cloud.git",
    backing: "cloud-vm",
  })
  return { alice, bob, admin, outsider, local }
}

async function hostKey() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey)
  return {
    publicKey: JSON.stringify(jwk),
    fingerprint: await publicKeyFingerprint(jwk),
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

type Input = Awaited<ReturnType<typeof setup>>

async function enrollAccountMachine(
  input: Input,
  owner: SignedControlPlaneAuth,
  hostId: string,
  options: { ttlMs?: number; displayName?: string } = {},
) {
  const key = await hostKey()
  const request = await input.hostAccess.createHostEnrollmentRequest(owner, { hostId })
  const enrollment = await input.hostAccess.enrollHost(owner, {
    hostId,
    publicKey: key.publicKey,
    requestId: request.request_id,
    signature: await key.sign(hostEnrollmentPayload({ hostId, requestId: request.request_id, nonce: request.nonce })),
    ttlMs: options.ttlMs ?? 8_000,
    ...(options.displayName ? { displayName: options.displayName } : {}),
  })
  return { key, enrollmentId: enrollment.enrollment_id, enrollment }
}

/** What the verifier hands the authority after admitting a signed request. */
async function principal(input: Input, enrollmentId: string): Promise<MachinePrincipal> {
  const row = await input.hostAccess.machineAuth.lookupEnrollment(enrollmentId)
  if (!row) throw new Error(`no enrollment ${enrollmentId}`)
  return {
    enrollmentId: row.enrollment_id,
    hostId: row.host_id,
    ownerUserId: row.owner_user_id,
    ownerActorId: row.owner_actor_id,
    scope: row.scope,
    keyVersion: row.key_version,
    generation: row.serving_generation,
  }
}

async function machineBeat(
  input: Input,
  enrollmentId: string,
  acks: Array<{ workspaceId: string; revision: number }>,
  overrides: Partial<MachinePrincipal> & {
    generation?: number
    sessionAuthority?: "local" | "managed-private"
    sealingPublicKey?: string
    providerConfigRevision?: number
  } = {},
) {
  const { sessionAuthority, sealingPublicKey, providerConfigRevision, ...principalOverrides } = overrides
  const machine = { ...(await principal(input, enrollmentId)), ...principalOverrides }
  return await input.hostAccess.heartbeatHostEnrollmentByMachine(machine, {
    enrollmentId: machine.enrollmentId,
    hostId: machine.hostId,
    generation: overrides.generation ?? machine.generation,
    acks,
    ttlMs: 8_000,
    ...(sessionAuthority ? { sessionAuthority } : {}),
    ...(sealingPublicKey ? { sealingPublicKey } : {}),
    ...(providerConfigRevision === undefined ? {} : { providerConfigAckedRevision: providerConfigRevision }),
  })
}

/** The ECDH key a machine declares on its beat, and the four-member text the row stores it as. */
async function sealingKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return {
    publicKey: JSON.stringify(jwk),
    stored: JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }),
  }
}

describe("D1 host access authority", () => {
  test("drops the membership union, its triggers and the table behind it, populated or not", async () => {
    const { database } = await emptyDatabase()
    await applyMigration(database, MIGRATIONS[0])
    await applyMigration(database, MIGRATIONS[1])
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
    for (const path of MIGRATIONS.slice(2)) await applyMigration(database, path)

    expect(await database.prepare(`
      select type, name from sqlite_master
      where name in ('workspace_memberships', 'workspace_direct_memberships', 'workspace_share_grants')
    `).all().then((result) => result.results)).toEqual([])
    expect(await database.prepare(`
      select name from sqlite_master where type = 'index' and name like 'workspace_%memberships_by_user'
    `).all().then((result) => result.results)).toEqual([])
    // The org membership seeded beside it is untouched: what the rank is
    // composed from now is the organization, the project and a team's grant.
    expect(await database.prepare(`
      select role from org_memberships where org_id = 'org-upgrade' and user_id = 'user-member'
    `).first()).toEqual({ role: "member" })
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
        placement: { directory: "/workspace/cold" },
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
      workspace: { backing: "local-worktree", display_name: "Shared" },
    })

    // Revoking the machine retires everything it served; the fixture's cloud row is untouched.
    await input.hostAccess.revokeHostEnrollment(alice, { hostId: "machine-l" })
    expect(await listed()).toEqual(["ws_cloud"])
  })

  test("routes a workspace through owner assignment AND the machine's acked set on a live lease", async () => {
    const input = await setup()
    const { alice, outsider } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-b", { displayName: "Laptop B" })

    // Owner intent alone is not routable: no ack yet.
    await input.hostAccess.assignWorkspaceHost(alice, {
      workspaceId: "ws_local",
      hostId: "machine-b",
      remoteDirectory: "/srv/local",
    })
    expect(await input.hostAccess.activeWorkspaceHost(alice, { workspaceId: "ws_local" }))
      .toEqual({ active: false })

    // An ack at a revision the assignment does not hold is consent to
    // something the owner has moved on from, and earns no readiness.
    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 99 }])
    expect(await input.hostAccess.activeWorkspaceHost(alice, { workspaceId: "ws_local" }))
      .toEqual({ active: false })

    // Ack the set: now routable, and the response reconciles owner intent.
    const beat = await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }])
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
  test("routes with the session composition the machine declared, and with none when it declared none", async () => {
    // The control plane does not know how a host composed its runtime and must
    // not derive it: the same product builds either flavour depending on
    // whether a session authority was injected. So the machine declares on the
    // beat and the routing answer carries that back verbatim — both values,
    // because a passthrough hard-coding one would still pass a single-value
    // test — while a beat that declared nothing leaves the answer with no
    // composition at all rather than a default.
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-d")
    await input.hostAccess.assignWorkspaceHost(alice, {
      workspaceId: "ws_local",
      hostId: "machine-d",
      remoteDirectory: "/srv/local",
    })

    const beat = async (sessionAuthority?: "local" | "managed-private") => {
      input.advance(1)
      await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }], sessionAuthority ? { sessionAuthority } : {})
      return await input.hostAccess.activeWorkspaceHost(alice, { workspaceId: "ws_local" })
    }

    expect(await beat("managed-private")).toMatchObject({ active: true, session_authority: "managed-private" })
    // A restart into a different composition replaces the declaration; it does
    // not accumulate one.
    expect(await beat("local")).toMatchObject({ active: true, session_authority: "local" })
    const undeclared = await beat()
    expect(undeclared).toMatchObject({ active: true })
    expect(undeclared).not.toHaveProperty("session_authority")
  })

  test("stamps host reachability on every user-hosted row of the workspace list", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-c")
    const listed = async () =>
      Object.fromEntries(
        (await input.workspace.listWorkspaces(alice) as Array<{ workspace_id: string; host_online?: boolean }>)
          .map((row) => [row.workspace_id, row.host_online]),
      )

    // Assigned but never acked: listed, and honestly offline.
    await input.hostAccess.assignWorkspaceHost(alice, {
      workspaceId: "ws_local",
      hostId: "machine-c",
      remoteDirectory: "/srv/local",
    })
    expect(await listed()).toEqual({ ws_cloud: undefined, ws_local: false })

    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }])
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

    const enrolledMachine = await principal(input, enrolled.enrollment_id)
    await input.hostAccess.heartbeatHostEnrollmentByMachine(enrolledMachine, {
      enrollmentId: enrolled.enrollment_id,
      hostId: "machine-a",
      generation: enrolledMachine.generation,
      acks: [],
      ttlMs: 8_000,
    })

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

  test("records runtime tokens for canonical actors only and revokes them without crossing tenants", async () => {
    const input = await setup()
    const { alice, bob, outsider } = await fixture(input)
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_local" })).toMatchObject({ role: "viewer" })

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

/**
 * Host-connect scenarios (P1.1–P1.6). The SQLite adapter mirrors this list
 * one for one; keep the test names stable and the shapes plain so the mirror
 * stays a mirror.
 */
describe("host-connect: machine heartbeat, readiness, invitations, scope", () => {
  async function invite(input: Input, owner: SignedControlPlaneAuth, roots: string[], visibility: "owner" | "org" = "owner") {
    const created = await input.hostAccess.createHostInvitation(owner, { scope: { allowed_roots: roots, visibility } })
    const parts = invitationTokenParts(created.token)
    if (!parts) throw new Error(`token not parseable: ${created.token}`)
    return { ...created, ...parts }
  }

  async function redeem(
    input: Input,
    invitation: { invitationId: string; secret: string },
    hostId: string,
    key: Awaited<ReturnType<typeof hostKey>>,
  ) {
    return await input.hostAccess.redeemHostInvitation({
      invitationId: invitation.invitationId,
      secret: invitation.secret,
      hostId,
      publicKey: key.publicKey,
      signature: await key.sign(
        invitationRedeemPayload({ invitationId: invitation.invitationId, hostId, publicKeySha256: key.fingerprint }),
      ),
    })
  }

  /** The four routability readers, which must always agree. */
  async function routable(input: Input, owner: SignedControlPlaneAuth, workspaceId: string) {
    const active = await input.hostAccess.activeWorkspaceHost(owner, { workspaceId })
    const listed = (await input.workspace.listWorkspaces(owner) as Array<{ workspace_id: string; host_online?: boolean }>)
      .find((row) => row.workspace_id === workspaceId)
    const target = await input.relayTarget(workspaceId)
    return { active: active.active, host_online: listed?.host_online, relay: target.active }
  }

  async function readiness(input: Input, workspaceId: string) {
    return await input.database.prepare(
      "select enrollment_id, generation, revision from host_assignment_readiness where workspace_id = ?",
    ).bind(workspaceId).first<{ enrollment_id: string; generation: number; revision: number }>()
  }

  test("machine beat renews the lease with the owner from the row and returns descriptions with revisions and the versioned scope", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-m")
    await input.hostAccess.assignWorkspaceHost(alice, {
      workspaceId: "ws_local",
      hostId: "machine-m",
      displayName: "Local",
      remoteDirectory: "/srv/local",
    })
    input.advance(1_000)
    const beat = await machineBeat(input, enrollmentId, [])
    expect(beat).toEqual({
      expires_at: input.now() + 8_000,
      last_seen_at: input.now(),
      assignments: [{ workspace_id: "ws_local", remote_directory: "/srv/local", display_name: "Local", revision: 1 }],
      scope: undefined,
      assigned_workspace_ids: ["ws_local"],
    })
    expect(await input.hostAccess.activeHostEnrollment(alice)).toMatchObject({ active: true, expires_at: input.now() + 8_000 })
    // No account beat ever happened, so nothing is ready yet.
    expect(await routable(input, alice, "ws_local")).toEqual({ active: false, host_online: false, relay: false })

    const acked = await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }])
    expect(acked.assigned_workspace_ids).toEqual(["ws_local"])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: true, host_online: true, relay: true })
    expect(await readiness(input, "ws_local")).toEqual({ enrollment_id: enrollmentId, generation: 0, revision: 1 })

    await machineBeat(input, enrollmentId, [])
    expect(await readiness(input, "ws_local")).toBeNull()
    expect(await routable(input, alice, "ws_local")).toEqual({ active: false, host_online: false, relay: false })
  })

  test("descriptions and scope are returned only for this enrollment", async () => {
    const input = await setup()
    const { alice, bob } = await fixture(input)
    const mine = await enrollAccountMachine(input, alice, "machine-mine")
    const other = await enrollAccountMachine(input, alice, "machine-other")
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-mine", remoteDirectory: "/srv/a" })
    await input.workspace.createWorkspace(alice, {
      workspaceId: "ws_other",
      orgId: "org_acme",
      displayName: "other",
      backing: "local-worktree",
    })
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_other", hostId: "machine-other", remoteDirectory: "/srv/b" })
    // Bob enrolls a machine with the SAME host id: host ids are per owner.
    const bobs = await enrollAccountMachine(input, bob, "machine-mine")

    expect((await machineBeat(input, mine.enrollmentId, [])).assignments.map((a) => a.workspace_id)).toEqual(["ws_local"])
    expect((await machineBeat(input, other.enrollmentId, [])).assignments.map((a) => a.workspace_id)).toEqual(["ws_other"])
    expect((await machineBeat(input, bobs.enrollmentId, [])).assignments).toEqual([])
    // An assignment without a directory is not a description a machine can serve.
    await input.workspace.createWorkspace(alice, {
      workspaceId: "ws_nodir",
      orgId: "org_acme",
      displayName: "nodir",
      backing: "local-worktree",
    })
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_nodir", hostId: "machine-mine" })
    const beat = await machineBeat(input, mine.enrollmentId, [])
    expect(beat.assignments.map((a) => a.workspace_id)).toEqual(["ws_local"])
    expect(beat.assigned_workspace_ids).toEqual(["ws_local", "ws_nodir"])
  })

  test("re-pointing a directory bumps the revision atomically with the directory, and the predicate is false until the new revision is acked", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-r")
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-r", remoteDirectory: "/srv/one" })
    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: true, host_online: true, relay: true })

    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-r", remoteDirectory: "/srv/two" })
    expect(await input.database.prepare(
      "select w.remote_directory, a.revision from workspaces w join host_workspace_assignments a using (workspace_id) where w.workspace_id = 'ws_local'",
    ).first()).toEqual({ remote_directory: "/srv/two", revision: 2 })
    // Every reader turns false on the next read, before any new beat.
    expect(await routable(input, alice, "ws_local")).toEqual({ active: false, host_online: false, relay: false })
    // The machines list still shows what the host last said — revision 1 —
    // which is how the panel can tell a stale ack from a fresh one.
    expect((await input.hostAccess.listHostEnrollments(alice))[0]?.acked).toEqual([{ workspaceId: "ws_local", revision: 1 }])

    // A stale ack (old revision) renews the lease but does not make it ready.
    const stale = await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }])
    expect(stale.assignments).toEqual([{ workspace_id: "ws_local", remote_directory: "/srv/two", display_name: "local", revision: 2 }])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: false, host_online: false, relay: false })

    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 2 }])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: true, host_online: true, relay: true })
    expect((await input.hostAccess.listHostEnrollments(alice))[0]?.acked).toEqual([{ workspaceId: "ws_local", revision: 2 }])
  })

  test("acquire increments the generation, deletes prior readiness, records an audit row and refuses the older generation's beat as superseded", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-g")
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-g", remoteDirectory: "/srv/g" })
    const first = await principal(input, enrollmentId)
    expect(await input.hostAccess.acquireHostServingGeneration(first)).toEqual({ generation: 1, generation_acquired_at: input.now() })
    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: true, host_online: true, relay: true })

    // A second instance of the same key acquires: readiness of generation 1 is gone.
    const second = await principal(input, enrollmentId)
    expect(second.generation).toBe(1)
    expect(await input.hostAccess.acquireHostServingGeneration(second)).toMatchObject({ generation: 2 })
    expect(await readiness(input, "ws_local")).toBeNull()
    expect(await routable(input, alice, "ws_local")).toEqual({ active: false, host_online: false, relay: false })
    expect((await input.hostAccess.listHostEnrollments(alice))[0]).toMatchObject({
      serving_generation: 2,
      generation_acquired_at: input.now(),
    })
    const audit = await input.database.prepare(
      "select action, user_id, metadata_json from authority_audit_events where action = 'host_enrollment.generation_acquired' order by created_at",
    ).all<{ action: string; user_id: string; metadata_json: string }>()
    expect(audit.results.map((row) => JSON.parse(row.metadata_json).generation)).toEqual([1, 2])
    expect(audit.results[0]?.user_id).toBe(alice.principal!.userId)

    // The first instance's beat carries generation 1: refused, lease untouched.
    const before = await input.hostAccess.activeHostEnrollment(alice)
    input.advance(1_000)
    await expect(machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }], { generation: 1 }))
      .rejects.toMatchObject({ code: "enrollment_generation_superseded", status: 409, details: { serving_generation: 2 } })
    expect(await input.hostAccess.activeHostEnrollment(alice)).toEqual(before)
    // A stale principal (verified before the second acquire) is refused inside the batch too.
    await expect(input.hostAccess.acquireHostServingGeneration(second))
      .rejects.toMatchObject({ code: "enrollment_generation_superseded", status: 409 })
    // The current instance keeps serving after re-acking.
    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 1 }])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: true, host_online: true, relay: true })
  })

  test("a beat verified against a replaced key or an ineligible owner writes nothing", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-k")
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-k", remoteDirectory: "/srv/k" })
    const stale = await principal(input, enrollmentId)

    // The account re-enrolls with a NEW key: key_version 2.
    const replaced = await enrollAccountMachine(input, alice, "machine-k")
    expect(replaced.enrollmentId).toBe(enrollmentId)
    expect((await input.hostAccess.machineAuth.lookupEnrollment(enrollmentId))?.key_version).toBe(2)
    const before = await input.hostAccess.activeHostEnrollment(alice)
    input.advance(1_000)
    await expect(input.hostAccess.heartbeatHostEnrollmentByMachine(stale, {
      enrollmentId,
      hostId: "machine-k",
      generation: 0,
      acks: [{ workspaceId: "ws_local", revision: 1 }],
      ttlMs: 8_000,
    })).rejects.toMatchObject({ code: "enrollment_key_version_mismatch", status: 403 })
    expect(await input.hostAccess.activeHostEnrollment(alice)).toEqual(before)
    expect(await readiness(input, "ws_local")).toBeNull()
    await expect(input.hostAccess.acquireHostServingGeneration(stale))
      .rejects.toMatchObject({ code: "enrollment_key_version_mismatch" })

    // Re-enrolling with the SAME key does not bump the version.
    const current = await principal(input, enrollmentId)
    expect(current.keyVersion).toBe(2)

    // The owner is suspended between verification and the write.
    await input.database.prepare(
      "update users set state = 'suspended', suspended_at = ? where user_id = ?",
    ).bind(input.now(), alice.principal!.userId).run()
    await expect(input.hostAccess.heartbeatHostEnrollmentByMachine(current, {
      enrollmentId,
      hostId: "machine-k",
      generation: 0,
      acks: [],
      ttlMs: 8_000,
    })).rejects.toMatchObject({ code: "enrollment_owner_ineligible", status: 403 })
    expect((await input.hostAccess.machineAuth.lookupEnrollment(enrollmentId))?.ownerEligible).toBe(false)
  })

  test("nonces are consumed insert-or-fail and the heartbeat sweeps expired ones by exact row", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-n")
    const other = await enrollAccountMachine(input, alice, "machine-n2")
    const consume = (id: string, nonce: string, expiresAt: number) =>
      input.hostAccess.machineAuth.consumeNonce({ enrollmentId: id, nonce, expiresAt })
    expect(await consume(enrollmentId, "nonce-a", input.now() + 120_000)).toBe(true)
    expect(await consume(enrollmentId, "nonce-a", input.now() + 120_000)).toBe(false)
    // The same nonce under another enrollment is a different key.
    expect(await consume(other.enrollmentId, "nonce-a", input.now() + 120_000)).toBe(true)
    expect(await consume(enrollmentId, "nonce-old", input.now() - 1)).toBe(true)
    expect(await consume(enrollmentId, "nonce-live", input.now() + 60_000)).toBe(true)

    await machineBeat(input, enrollmentId, [])
    const rows = await input.database.prepare(
      "select enrollment_id, nonce from host_request_nonces order by enrollment_id, nonce",
    ).all<{ enrollment_id: string; nonce: string }>()
    // Only the expired row went; the other enrollment's rows are untouched.
    expect(rows.results).toEqual([
      { enrollment_id: enrollmentId, nonce: "nonce-a" },
      { enrollment_id: enrollmentId, nonce: "nonce-live" },
      { enrollment_id: other.enrollmentId, nonce: "nonce-a" },
    ])
  })

  test("a fresh redeem creates an enrollment owned by the inviter with the invitation's scope and org, and stores only the secret's hash", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const invitation = await invite(input, owner, ["/srv"], "owner")
    expect(invitation.token.startsWith(`chx_inv_1.${invitation.invitationId}.`)).toBe(true)
    expect(invitation.expiresAt).toBe(input.now() + 60 * 60_000)
    const stored = await input.database.prepare("select secret_hash, org_id from host_invitations where invitation_id = ?")
      .bind(invitation.invitationId).first<{ secret_hash: string; org_id: string }>()
    expect(stored).toEqual({ secret_hash: await sha256Hex(invitation.secret), org_id: "org_acme" })
    expect(JSON.stringify(await input.database.prepare("select * from host_invitations").all())).not.toContain(invitation.secret)

    const key = await hostKey()
    const result = await redeem(input, invitation, "vps-1", key)
    expect(result).toMatchObject({
      resumed: false,
      enrollment: { host_id: "vps-1" },
      owner_user_id: alice.principal!.userId,
      owner_actor_id: alice.principal!.actorId,
      org_id: "org_acme",
      key_version: 1,
      serving_generation: 0,
      scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
    })
    const machine = await principal(input, result.enrollment.enrollment_id)
    expect(machine).toMatchObject({ hostId: "vps-1", ownerUserId: alice.principal!.userId, keyVersion: 1, generation: 0 })
    expect((await input.hostAccess.listHostEnrollments(owner)).map((row) => [row.host_id, row.enrolled_via, row.public_key_fingerprint]))
      .toEqual([["vps-1", "invitation", key.fingerprint]])
    expect(await input.hostAccess.listHostInvitations(owner)).toMatchObject([
      { invitation_id: invitation.invitationId, redeemed_host_id: "vps-1", redeemed_enrollment_id: result.enrollment.enrollment_id },
    ])
    // The redeemed machine can beat by itself; the owner is the inviter.
    expect(await machineBeat(input, result.enrollment.enrollment_id, [])).toMatchObject({
      assignments: [],
      scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
    })
  })

  test("a wrong secret or an unknown id is invitation_invalid with no redeemed-by detail", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const invitation = await invite(input, owner, ["/srv"])
    const key = await hostKey()
    await redeem(input, invitation, "vps-1", key)
    for (const attempt of [
      { invitationId: invitation.invitationId, secret: "not-the-secret" },
      { invitationId: "invitation_nope", secret: invitation.secret },
    ]) {
      await expect(redeem(input, attempt, "vps-2", await hostKey())).rejects.toSatisfy((error: unknown) => {
        const err = error as { code: string; status: number; details?: unknown }
        return err.code === "invitation_invalid" && err.status === 403 && err.details === undefined
      })
    }
    // A bad signature over the right secret is an attestation failure, not a hint about the invitation.
    const forger = await hostKey()
    await expect(input.hostAccess.redeemHostInvitation({
      invitationId: invitation.invitationId,
      secret: invitation.secret,
      hostId: "vps-2",
      publicKey: forger.publicKey,
      signature: await forger.sign("something else"),
    })).rejects.toMatchObject({ code: "host_attestation_denied" })
  })

  test("redeeming again with the same key and host id resumes the same enrollment; a different key or host id is invitation_redeemed", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const invitation = await invite(input, owner, ["/srv"])
    const key = await hostKey()
    const first = await redeem(input, invitation, "vps-1", key)
    input.advance(2 * 60 * 60_000)
    // Past the invitation's own expiry: recovery of a lost response still works.
    const again = await redeem(input, invitation, "vps-1", key)
    expect(again).toMatchObject({ resumed: true, enrollment: { enrollment_id: first.enrollment.enrollment_id } })
    expect(await input.database.prepare("select count(*) as n from host_enrollments").first<{ n: number }>()).toEqual({ n: 1 })

    await expect(redeem(input, invitation, "vps-1", await hostKey())).rejects.toMatchObject({
      code: "invitation_redeemed",
      status: 409,
      details: { redeemed_host_id: "vps-1", redeemed_at: first.enrollment.created_at },
    })
    await expect(redeem(input, invitation, "vps-other", key)).rejects.toMatchObject({ code: "invitation_redeemed" })
    // Once the owner revokes the machine, the invitation cannot resurrect it.
    await input.hostAccess.revokeHostEnrollment(owner, { hostId: "vps-1" })
    await expect(redeem(input, invitation, "vps-1", key)).rejects.toMatchObject({ code: "invitation_redeemed" })
  })

  test("two concurrent redeems with distinct keys produce exactly one enrollment", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const invitation = await invite(input, owner, ["/srv"])
    const outcomes = await Promise.allSettled([
      redeem(input, invitation, "vps-a", await hostKey()),
      redeem(input, invitation, "vps-b", await hostKey()),
    ])
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled")
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: "invitation_redeemed" })
    expect(await input.database.prepare("select count(*) as n from host_enrollments").first<{ n: number }>()).toEqual({ n: 1 })
  })

  test("revoke racing redeem: at most one wins, and the loser is told which", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const invitation = await invite(input, owner, ["/srv"])
    const [redeemed, revoked] = await Promise.allSettled([
      redeem(input, invitation, "vps-a", await hostKey()),
      input.hostAccess.revokeHostInvitation(owner, { invitationId: invitation.invitationId }),
    ])
    const enrollments = await input.database.prepare("select count(*) as n from host_enrollments").first<{ n: number }>()
    if (redeemed.status === "fulfilled") {
      expect(revoked).toMatchObject({ status: "fulfilled", value: { revoked: false } })
      expect(enrollments).toEqual({ n: 1 })
    } else {
      expect(redeemed.reason).toMatchObject({ code: "invitation_revoked", status: 410 })
      expect(revoked).toMatchObject({ status: "fulfilled", value: { revoked: true } })
      expect(enrollments).toEqual({ n: 0 })
    }
    // A revoked invitation stays revoked; an expired one says so.
    const expired = await invite(input, owner, ["/srv"])
    input.advance(60 * 60_000 + 1)
    await expect(redeem(input, expired, "vps-c", await hostKey())).rejects.toMatchObject({ code: "invitation_expired", status: 410 })
  })

  test("host id collision with a live or revoked enrollment is invitation_host_conflict and writes nothing", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    await enrollAccountMachine(input, alice, "laptop")
    const live = await invite(input, owner, ["/srv"])
    await expect(redeem(input, live, "laptop", await hostKey())).rejects.toMatchObject({ code: "invitation_host_conflict", status: 409 })
    expect((await input.hostAccess.listHostInvitations(owner))[0]).not.toHaveProperty("redeemed_at")

    await input.hostAccess.revokeHostEnrollment(owner, { hostId: "laptop" })
    await expect(redeem(input, live, "laptop", await hostKey())).rejects.toMatchObject({ code: "invitation_host_conflict" })
    expect(await input.database.prepare("select count(*) as n from host_enrollments").first<{ n: number }>()).toEqual({ n: 1 })

    // The same key redeeming a DIFFERENT invitation while the pair is occupied is a conflict, not a resume.
    const key = await hostKey()
    const first = await invite(input, owner, ["/srv"])
    await redeem(input, first, "vps-1", key)
    const second = await invite(input, owner, ["/srv"])
    await expect(redeem(input, second, "vps-1", key)).rejects.toMatchObject({ code: "invitation_host_conflict" })
    expect((await input.hostAccess.listHostInvitations(owner)).find((row) => row.invitation_id === second.invitationId))
      .not.toHaveProperty("redeemed_at")
  })

  test("invitation expiry is clamped to [5 min, 24 h] and revoke only touches an unredeemed, unrevoked row of the caller", async () => {
    const input = await setup()
    const { bob } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const short = await input.hostAccess.createHostInvitation(owner, { scope: { allowed_roots: ["/srv"], visibility: "org" }, expiresInMs: 1_000 })
    input.advance(1)
    const long = await input.hostAccess.createHostInvitation(owner, { scope: { allowed_roots: ["/srv"], visibility: "org" }, expiresInMs: 7 * 24 * 60 * 60_000 })
    expect(long.expiresAt).toBe(input.now() + 24 * 60 * 60_000)
    expect(short.expiresAt).toBe(input.now() - 1 + 5 * 60_000)
    await expect(input.hostAccess.createHostInvitation(owner, { scope: { allowed_roots: ["relative"], visibility: "org" } }))
      .rejects.toMatchObject({ code: "invalid_input" })
    // Another member of the org cannot revoke the owner's invitation.
    expect(await input.hostAccess.revokeHostInvitation(bob, { invitationId: short.invitationId })).toEqual({ revoked: false })
    expect(await input.hostAccess.revokeHostInvitation(owner, { invitationId: short.invitationId })).toEqual({ revoked: true })
    expect(await input.hostAccess.revokeHostInvitation(owner, { invitationId: short.invitationId })).toEqual({ revoked: false })
    expect((await input.hostAccess.listHostInvitations(owner)).map((row) => [row.invitation_id, row.revoked_at !== undefined]))
      .toEqual([[long.invitationId, false], [short.invitationId, true]])
    // An org the caller does not belong to cannot be claimed.
    const outsider = await signed(input.workspace, "outsider", "org_acme")
    await expect(input.hostAccess.createHostInvitation(outsider, { scope: { allowed_roots: ["/srv"], visibility: "org" } }))
      .rejects.toMatchObject({ status: 403 })
  })

  test("assignment outside the roots is refused and inside accepted, segment-aware with .. and trailing slashes", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const key = await hostKey()
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv/", "/home/deploy/apps"]), "vps-s", key)
    const assign = (workspaceId: string, remoteDirectory: string) =>
      input.hostAccess.assignWorkspaceHost(owner, { workspaceId, hostId: enrollment.host_id, remoteDirectory })
    await expect(assign("ws_a", "/srv/api")).resolves.toMatchObject({ assigned: true })
    await expect(assign("ws_b", "/srv")).resolves.toMatchObject({ assigned: true })
    await expect(assign("ws_c", "/home/deploy/apps/../apps/one/")).resolves.toMatchObject({ assigned: true })
    for (const outside of ["/srvx", "/srv/../etc", "/home/deploy", "srv/api", "/"]) {
      await expect(assign(`ws_${outside}`, outside)).rejects.toMatchObject({ code: "host_assignment_outside_scope", status: 400 })
    }
    // A scoped machine cannot be pointed at a workspace with no directory at all.
    await expect(input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_none", hostId: enrollment.host_id }))
      .rejects.toMatchObject({ code: "host_assignment_outside_scope" })
    // Empty roots admit nothing; an account machine (no scope) is unrestricted.
    const denyAll = await redeem(input, await invite(input, owner, []), "vps-none", await hostKey())
    await expect(input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_d", hostId: denyAll.enrollment.host_id, remoteDirectory: "/srv" }))
      .rejects.toMatchObject({ code: "host_assignment_outside_scope" })
    expect((await input.workspace.listWorkspaces(owner) as Array<{ workspace_id: string }>).map((row) => row.workspace_id).sort())
      .toEqual(["ws_a", "ws_b", "ws_c", "ws_cloud", "ws_local"])
  })

  test("an invitation enrollment refuses assignment of a workspace in another organization", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    await input.workspace.createHostedOrganization(alice, { name: "Beta", orgId: "org_beta" })
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"]), "vps-o", await hostKey())
    await input.workspace.createWorkspace(alice, {
      workspaceId: "ws_beta",
      orgId: "org_beta",
      displayName: "beta",
      backing: "local-worktree",
    })
    await expect(input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_beta", hostId: enrollment.host_id, remoteDirectory: "/srv/beta" }))
      .rejects.toMatchObject({ code: "host_assignment_outside_scope" })
    await expect(input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_cold", hostId: enrollment.host_id, orgId: "org_beta", remoteDirectory: "/srv/cold" }))
      .rejects.toMatchObject({ code: "host_assignment_outside_scope" })
    // Cold registration with no org named lands in the invitation's org even when the caller's token names another.
    const betaCaller = await signed(input.workspace, "alice", "org_beta")
    await input.hostAccess.assignWorkspaceHost(betaCaller, { workspaceId: "ws_cold", hostId: enrollment.host_id, remoteDirectory: "/srv/cold" })
    expect(await input.database.prepare("select org_id from workspaces where workspace_id = 'ws_cold'").first()).toEqual({ org_id: "org_acme" })
  })

  test("an ordinary org member cannot open an owner-visibility workspace but a direct member, a project member and an org admin can", async () => {
    const input = await setup()
    const { alice, bob, admin } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"], "owner"), "vps-v", await hostKey())
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_local", hostId: enrollment.host_id, remoteDirectory: "/srv/local" })
    expect(await input.database.prepare("select org_member_visible from workspaces where workspace_id = 'ws_local'").first())
      .toEqual({ org_member_visible: 0 })
    const listed = async (who: SignedControlPlaneAuth) =>
      (await input.workspace.listWorkspaces(who) as Array<{ workspace_id: string }>).map((row) => row.workspace_id)

    // workspace-authority rank
    await expect(input.workspace.openWorkspace(bob, { workspaceId: "ws_local" })).rejects.toMatchObject({ status: 403 })
    expect(await listed(bob)).toEqual(["ws_cloud"])
    expect(await input.workspace.openWorkspace(admin, { workspaceId: "ws_local" })).toMatchObject({ role: "admin" })
    expect(await input.workspace.openWorkspace(alice, { workspaceId: "ws_local" })).toMatchObject({ role: "owner" })
    // host-access rank (the same fragment)
    await expect(input.hostAccess.activeWorkspaceHost(bob, { workspaceId: "ws_local" })).rejects.toMatchObject({ status: 403 })
    expect(await input.hostAccess.activeWorkspaceHost(admin, { workspaceId: "ws_local" })).toEqual({ active: false })

    const localProject = await input.database
      .prepare("select project_id from workspaces where workspace_id = 'ws_local'")
      .first<{ project_id: string }>()
    await input.database.prepare(
      "insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at) values (?, ?, 'editor', 1, 1, null)",
    ).bind(localProject!.project_id, bob.principal!.userId).run()
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_local" })).toMatchObject({ role: "editor" })
    expect(await input.hostAccess.activeWorkspaceHost(bob, { workspaceId: "ws_local" })).toEqual({ active: false })
    const carol = await signed(input.workspace, "carol")
    await input.workspace.addOrganizationMember(alice, { orgId: "org_acme", userId: carol.principal!.userId, role: "member" })
    await expect(input.workspace.openWorkspace(carol, { workspaceId: "ws_local" })).rejects.toMatchObject({ status: 403 })
    const project = await input.database.prepare("select project_id from workspaces where workspace_id = 'ws_local'").first<{ project_id: string }>()
    await input.database.prepare(
      "insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at) values (?, ?, 'viewer', 1, 1, null)",
    ).bind(project!.project_id, carol.principal!.userId).run()
    expect(await input.workspace.openWorkspace(carol, { workspaceId: "ws_local" })).toMatchObject({ role: "viewer" })

    // The cloud workspace and an org-visibility assignment are untouched.
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_cloud" })).toMatchObject({ role: "viewer" })
    const laptop = await enrollAccountMachine(input, alice, "laptop")
    void laptop
    await input.workspace.createWorkspace(alice, {
      workspaceId: "ws_open",
      orgId: "org_acme",
      displayName: "open",
      backing: "local-worktree",
    })
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_open", hostId: "laptop" })
    expect(await input.workspace.openWorkspace(carol, { workspaceId: "ws_open" })).toMatchObject({ role: "viewer" })
  })

  test("the owner renames a machine, the name reaches the fleet listing, and nobody else can rename it", async () => {
    const input = await setup()
    const { bob } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"], "org"), "vps-t", await hostKey())

    await expect(input.hostAccess.renameHostEnrollment(bob, {
      enrollmentId: enrollment.enrollment_id,
      displayName: "bob's box",
    })).rejects.toMatchObject({ code: "host_enrollment_not_found", status: 404 })

    expect(await input.hostAccess.renameHostEnrollment(owner, {
      enrollmentId: enrollment.enrollment_id,
      displayName: "  Build box  ",
    })).toEqual({ enrollment_id: enrollment.enrollment_id, display_name: "Build box" })

    const machines = await input.hostAccess.listHostEnrollments(owner)
    expect(machines.map((machine) => machine.display_name)).toEqual(["Build box"])
    expect(await input.database.prepare(
      "select count(*) as n from authority_audit_events where action = 'host_enrollment.renamed'",
    ).first()).toEqual({ n: 1 })

    await expect(input.hostAccess.renameHostEnrollment(owner, {
      enrollmentId: enrollment.enrollment_id,
      displayName: "   ",
    })).rejects.toMatchObject({ code: "invalid_input", status: 400 })
  })

  test("tightening the roots retires the outside assignment transactionally, re-applies visibility to the rest, and the catalog drops it", async () => {
    const input = await setup()
    const { bob } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"], "org"), "vps-t", await hostKey())
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_api", hostId: enrollment.host_id, remoteDirectory: "/srv/api" })
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_web", hostId: enrollment.host_id, remoteDirectory: "/srv/web" })
    await machineBeat(input, enrollment.enrollment_id, [{ workspaceId: "ws_api", revision: 1 }, { workspaceId: "ws_web", revision: 1 }])
    expect(await routable(input, owner, "ws_api")).toEqual({ active: true, host_online: true, relay: true })
    expect(await input.workspace.openWorkspace(bob, { workspaceId: "ws_web" })).toMatchObject({ role: "viewer" })

    await expect(input.hostAccess.updateHostEnrollmentScope(bob, {
      enrollmentId: enrollment.enrollment_id,
      scope: { allowed_roots: ["/srv/web"], visibility: "owner" },
    })).rejects.toMatchObject({ code: "host_enrollment_not_found", status: 404 })

    const updated = await input.hostAccess.updateHostEnrollmentScope(owner, {
      enrollmentId: enrollment.enrollment_id,
      scope: { allowed_roots: ["/srv/web/"], visibility: "owner" },
    })
    expect(updated).toEqual({ scope: { allowed_roots: ["/srv/web"], visibility: "owner", revision: 2 }, retired_workspace_ids: ["ws_api"] })
    expect(await input.database.prepare("select count(*) as n from host_workspace_assignments where workspace_id = 'ws_api'").first())
      .toEqual({ n: 0 })
    expect(await readiness(input, "ws_api")).toBeNull()
    expect(await input.database.prepare("select deleted_at is not null as retired from workspaces where workspace_id = 'ws_api'").first())
      .toEqual({ retired: 1 })
    expect((await input.workspace.listWorkspaces(owner) as Array<{ workspace_id: string }>).map((row) => row.workspace_id).sort())
      .toEqual(["ws_cloud", "ws_local", "ws_web"])
    await expect(input.relayTarget("ws_api")).resolves.toEqual({ active: false })
    // The surviving assignment is still served and now owner-only.
    expect(await routable(input, owner, "ws_web")).toEqual({ active: true, host_online: true, relay: true })
    await expect(input.workspace.openWorkspace(bob, { workspaceId: "ws_web" })).rejects.toMatchObject({ status: 403 })
    // The next beat carries the new scope revision and omits the retired row.
    const beat = await machineBeat(input, enrollment.enrollment_id, [{ workspaceId: "ws_web", revision: 1 }])
    expect(beat.scope).toEqual({ allowed_roots: ["/srv/web"], visibility: "owner", revision: 2 })
    expect(beat.assignments.map((a) => a.workspace_id)).toEqual(["ws_web"])
    expect(await input.database.prepare(
      "select metadata_json from authority_audit_events where action = 'host_enrollment.scope_updated'",
    ).first<{ metadata_json: string }>()).toMatchObject({ metadata_json: expect.stringContaining('"retiredWorkspaceIds":["ws_api"]') })
    // Assigning outside the tightened roots is now refused.
    await expect(input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_api", hostId: enrollment.host_id, remoteDirectory: "/srv/api" }))
      .rejects.toMatchObject({ code: "host_assignment_outside_scope" })
  })

  test("listHostEnrollments lists every non-revoked enrollment of the owner with fingerprint, key version, enrolled_via, generation and acked", async () => {
    const input = await setup()
    const { alice, bob } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const laptop = await enrollAccountMachine(input, alice, "laptop")
    const vpsKey = await hostKey()
    const vps = await redeem(input, await invite(input, owner, ["/srv"]), "vps", vpsKey)
    await enrollAccountMachine(input, alice, "gone")
    await input.hostAccess.revokeHostEnrollment(alice, { hostId: "gone" })
    await enrollAccountMachine(input, bob, "bobs")
    await input.hostAccess.acquireHostServingGeneration(await principal(input, vps.enrollment.enrollment_id))
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_api", hostId: "vps", remoteDirectory: "/srv/api" })
    // The owner's declaration is listed before the machine has acked anything.
    expect((await input.hostAccess.listHostEnrollments(alice)).find((row) => row.host_id === "vps")).toMatchObject({
      assignments: [{ workspace_id: "ws_api", remote_directory: "/srv/api", revision: 1 }],
      acked: [],
    })
    await machineBeat(input, vps.enrollment.enrollment_id, [{ workspaceId: "ws_api", revision: 1 }])

    const machines = await input.hostAccess.listHostEnrollments(alice)
    expect(machines.map((row) => row.host_id).sort()).toEqual(["laptop", "vps"])
    expect(machines.find((row) => row.host_id === "vps")).toEqual({
      enrollment_id: vps.enrollment.enrollment_id,
      host_id: "vps",
      public_key_fingerprint: vpsKey.fingerprint,
      key_version: 1,
      enrolled_via: "invitation",
      last_seen_at: input.now(),
      expires_at: input.now() + 8_000,
      serving_generation: 1,
      generation_acquired_at: input.now(),
      assignments: [{ workspace_id: "ws_api", remote_directory: "/srv/api", display_name: "ws_api", revision: 1 }],
      acked: [{ workspaceId: "ws_api", revision: 1 }],
      scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
      provider_config_revision: 0,
      provider_config_acked_revision: 0,
      sealing_key_declared: false,
      provider_config_providers: [],
      provider_config_rekeyed: false,
    })
    expect(machines.find((row) => row.host_id === "laptop")).toMatchObject({
      enrollment_id: laptop.enrollmentId,
      enrolled_via: "account",
      key_version: 1,
      serving_generation: 0,
      assignments: [],
      acked: [],
      scope: undefined,
    })
    // The desktop's single-row view is unchanged beside it.
    expect(await input.hostAccess.activeHostEnrollment(alice)).toMatchObject({ active: true })
    // A paused machine says so; an unpaused one carries no paused_at at all.
    await input.hostAccess.pauseHostEnrollment(alice, { hostId: "laptop", paused: true })
    const paused = await input.hostAccess.listHostEnrollments(alice)
    expect(paused.find((row) => row.host_id === "laptop")).toMatchObject({ paused_at: input.now() })
    expect(paused.find((row) => row.host_id === "vps")).not.toHaveProperty("paused_at")
  })

  test("a refused assignment of a retired workspace leaves it retired", async () => {
    const input = await setup()
    const { alice, bob } = await fixture(input)
    await enrollAccountMachine(input, alice, "laptop")
    await enrollAccountMachine(input, bob, "bobs")
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "laptop", remoteDirectory: "/srv/local" })
    await input.hostAccess.unassignWorkspaceHost(alice, { workspaceId: "ws_local" })
    const retired = async () => (await input.database.prepare(
      "select deleted_at is not null as retired from workspaces where workspace_id = 'ws_local'",
    ).first<{ retired: number }>())!.retired === 1
    expect(await retired()).toBe(true)

    // Bob is an org member with his own machine, not an admin of the workspace.
    await expect(input.hostAccess.assignWorkspaceHost(bob, { workspaceId: "ws_local", hostId: "bobs" }))
      .rejects.toMatchObject({ status: 403 })
    expect(await retired()).toBe(true)
    expect(await input.database.prepare("select count(*) as n from host_workspace_assignments where workspace_id = 'ws_local'").first())
      .toEqual({ n: 0 })

    // The owner's scoped machine may not serve the retired row's directory either.
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv/api"]), "vps-r", await hostKey())
    await expect(input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_local", hostId: enrollment.host_id }))
      .rejects.toMatchObject({ code: "host_assignment_outside_scope" })
    expect(await retired()).toBe(true)

    // The owner assigning it again is what revives it.
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "laptop" })
    expect(await retired()).toBe(false)
  })

  test("assignment revisions never restart: unassign, reassign and a move to another host continue the counter", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-one")
    await enrollAccountMachine(input, alice, "machine-two")
    const revision = async () => (await input.database.prepare(
      "select a.revision, w.host_assignment_revision as counter from host_workspace_assignments a join workspaces w using (workspace_id) where w.workspace_id = 'ws_local'",
    ).first<{ revision: number; counter: number }>())
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-one", remoteDirectory: "/srv/one" })
    expect(await revision()).toEqual({ revision: 1, counter: 1 })
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-one", remoteDirectory: "/srv/two" })
    expect(await revision()).toEqual({ revision: 2, counter: 2 })
    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 2 }])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: true, host_online: true, relay: true })

    await input.hostAccess.unassignWorkspaceHost(alice, { workspaceId: "ws_local" })
    expect(await input.database.prepare("select host_assignment_revision from workspaces where workspace_id = 'ws_local'").first())
      .toEqual({ host_assignment_revision: 2 })
    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-one", remoteDirectory: "/srv/two" })
    expect(await revision()).toEqual({ revision: 3, counter: 3 })
    // The machine's last ack named revision 2, which no longer routes anything.
    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 2 }])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: false, host_online: false, relay: false })
    await machineBeat(input, enrollmentId, [{ workspaceId: "ws_local", revision: 3 }])
    expect(await routable(input, alice, "ws_local")).toEqual({ active: true, host_online: true, relay: true })

    await input.hostAccess.assignWorkspaceHost(alice, { workspaceId: "ws_local", hostId: "machine-two" })
    expect(await revision()).toEqual({ revision: 4, counter: 4 })
  })

  test("two acquires of the same generation in one millisecond hand it to exactly one instance", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-race")
    const stale = await principal(input, enrollmentId)
    const settled = await Promise.allSettled([
      input.hostAccess.acquireHostServingGeneration(stale),
      input.hostAccess.acquireHostServingGeneration(stale),
    ])
    const won = settled.filter((entry) => entry.status === "fulfilled")
    const lost = settled.filter((entry) => entry.status === "rejected")
    expect(won.map((entry) => entry.value.generation)).toEqual([1])
    expect(lost).toHaveLength(1)
    expect(lost[0]?.reason).toMatchObject({ code: "enrollment_generation_superseded", details: { serving_generation: 1 } })
    expect((await input.hostAccess.listHostEnrollments(alice))[0]).toMatchObject({ serving_generation: 1 })
    const audit = await input.database.prepare(
      "select count(*) as n from authority_audit_events where action = 'host_enrollment.generation_acquired'",
    ).first()
    expect(audit).toEqual({ n: 1 })
  })

  test("scope tightening retires exactly the assignments this host holds outside the new roots when the batch commits", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    await enrollAccountMachine(input, owner, "laptop")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"], "org"), "vps-m", await hostKey())
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_api", hostId: enrollment.host_id, remoteDirectory: "/srv/api" })
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_web", hostId: enrollment.host_id, remoteDirectory: "/srv/web" })

    // Between the PATCH's read and its batch, ws_api moves to the laptop and
    // ws_new is assigned to the vps outside the roots the PATCH is about to set.
    input.beforeNextBatch(async () => {
      await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_api", hostId: "laptop", remoteDirectory: "/srv/api" })
      await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_new", hostId: enrollment.host_id, remoteDirectory: "/srv/new" })
    })
    const updated = await input.hostAccess.updateHostEnrollmentScope(owner, {
      enrollmentId: enrollment.enrollment_id,
      scope: { allowed_roots: ["/srv/web"], visibility: "org" },
    })
    expect(updated.retired_workspace_ids).toEqual(["ws_new"])
    const assignments = await input.database.prepare(
      "select workspace_id, host_id from host_workspace_assignments order by workspace_id",
    ).all<{ workspace_id: string; host_id: string }>()
    expect(assignments.results).toEqual([
      { workspace_id: "ws_api", host_id: "laptop" },
      { workspace_id: "ws_web", host_id: enrollment.host_id },
    ])
    expect(await input.database.prepare(
      "select workspace_id from workspaces where deleted_at is not null order by workspace_id",
    ).all()).toMatchObject({ results: [{ workspace_id: "ws_new" }] })
  })

  test("of two scope PATCHes from the same revision exactly one wins, and an assignment validated against a scope that moved writes nothing", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"], "org"), "vps-c", await hostKey())
    const patch = (root: string) => input.hostAccess.updateHostEnrollmentScope(owner, {
      enrollmentId: enrollment.enrollment_id,
      scope: { allowed_roots: [root], visibility: "org" },
    })
    const settled = await Promise.allSettled([patch("/srv/a"), patch("/srv/b")])
    const won = settled.filter((entry) => entry.status === "fulfilled")
    const lost = settled.filter((entry) => entry.status === "rejected")
    expect(won).toHaveLength(1)
    expect(lost[0]?.reason).toMatchObject({ code: "resource_conflict" })
    const stored = await input.database.prepare("select scope_json, scope_revision from host_enrollments where enrollment_id = ?")
      .bind(enrollment.enrollment_id).first<{ scope_json: string; scope_revision: number }>()
    const { revision: _, ...winner } = won[0]?.value.scope ?? { allowed_roots: [], visibility: "org" as const, revision: 0 }
    expect(stored).toEqual({ scope_json: JSON.stringify(winner), scope_revision: 2 })

    // An assignment that validated /srv/x against the current scope, then
    // loses the race to a PATCH that excludes it, lands nothing.
    input.beforeNextBatch(async () => {
      await patch("/srv/elsewhere")
    })
    const root = winner.allowed_roots[0] ?? ""
    const projectsBefore = await input.database.prepare("select count(*) as n from projects").first()
    await expect(input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_x", hostId: enrollment.host_id, remoteDirectory: `${root}/x` }))
      .rejects.toMatchObject({ code: "resource_conflict" })
    expect(await input.database.prepare("select count(*) as n from host_workspace_assignments where workspace_id = 'ws_x'").first())
      .toEqual({ n: 0 })
    // The cold registration rode in the same batch: no workspace row — which
    // `visibility: "org"` would have shown to every member — and no project.
    expect(await input.database.prepare("select count(*) as n from workspaces where workspace_id = 'ws_x'").first())
      .toEqual({ n: 0 })
    expect(await input.database.prepare("select count(*) as n from projects").first()).toEqual(projectsBefore)
  })

  test("a legacy row stored with .. or a trailing slash is retired or kept by what it resolves to once migration 0029 has normalized it", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"], "org"), "vps-l", await hostKey())
    const assign = (workspaceId: string, remoteDirectory: string) =>
      input.hostAccess.assignWorkspaceHost(owner, { workspaceId, hostId: enrollment.host_id, remoteDirectory })
    await assign("ws_escape", "/srv/allowed/api")
    await assign("ws_slash", "/srv/allowed/web")
    await assign("ws_dot", "/srv/allowed/dot")
    await assign("ws_sibling", "/srv/allowedx")
    await assign("ws_root", "/srv/allowed")
    // What the desktop's registration and the pre-normalization writers left behind.
    const legacy: Record<string, string> = {
      ws_escape: "/srv/allowed/../secret",
      ws_slash: "/srv/allowed/web/",
      ws_dot: "/srv/./allowed//dot/./",
      ws_sibling: "/srv/allowedx/",
      ws_root: "/srv/allowed/",
    }
    for (const [workspaceId, directory] of Object.entries(legacy)) {
      await input.database.prepare("update workspaces set remote_directory = ? where workspace_id = ?").bind(directory, workspaceId).run()
    }
    await input.applyMigration("0031_normalize_user_hosted_directories.sql")
    const stored = await input.database.prepare(
      "select workspace_id, remote_directory from workspaces where workspace_id in (select workspace_id from host_workspace_assignments) order by workspace_id",
    ).all<{ workspace_id: string; remote_directory: string }>()
    expect(stored.results).toEqual([
      { workspace_id: "ws_dot", remote_directory: "/srv/allowed/dot" },
      { workspace_id: "ws_escape", remote_directory: "/srv/secret" },
      { workspace_id: "ws_root", remote_directory: "/srv/allowed" },
      { workspace_id: "ws_sibling", remote_directory: "/srv/allowedx" },
      { workspace_id: "ws_slash", remote_directory: "/srv/allowed/web" },
    ])

    const updated = await input.hostAccess.updateHostEnrollmentScope(owner, {
      enrollmentId: enrollment.enrollment_id,
      scope: { allowed_roots: ["/srv/allowed"], visibility: "org" },
    })
    expect(updated.retired_workspace_ids).toEqual(["ws_escape", "ws_sibling"])
    expect((await input.database.prepare("select workspace_id from host_workspace_assignments order by workspace_id").all()).results)
      .toEqual([{ workspace_id: "ws_dot" }, { workspace_id: "ws_root" }, { workspace_id: "ws_slash" }])
  })

  test("a trailing slash an un-normalized writer leaves behind is still classified by the prefix clause", async () => {
    const input = await setup()
    await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"], "org"), "vps-ts", await hostKey())
    const assign = (workspaceId: string, remoteDirectory: string) =>
      input.hostAccess.assignWorkspaceHost(owner, { workspaceId, hostId: enrollment.host_id, remoteDirectory })
    await assign("ws_in", "/srv/allowed/web")
    await assign("ws_exact", "/srv/allowed")
    await assign("ws_out", "/srv/allowedx")
    for (const workspaceId of ["ws_in", "ws_exact", "ws_out"]) {
      await input.database.prepare("update workspaces set remote_directory = remote_directory || '/' where workspace_id = ?").bind(workspaceId).run()
    }
    const updated = await input.hostAccess.updateHostEnrollmentScope(owner, {
      enrollmentId: enrollment.enrollment_id,
      scope: { allowed_roots: ["/srv/allowed"], visibility: "org" },
    })
    expect(updated.retired_workspace_ids).toEqual(["ws_out"])
  })

  test("every write of a directory records it normalized, and a re-point without one repairs the stored value", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const { enrollment } = await redeem(input, await invite(input, owner, ["/srv"], "org"), "vps-n", await hostKey())
    const directory = async (workspaceId: string) =>
      (await input.database.prepare("select remote_directory from workspaces where workspace_id = ?").bind(workspaceId).first<{ remote_directory: string }>())?.remote_directory
    // Cold registration through the assignment.
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_cold", hostId: enrollment.host_id, remoteDirectory: "/srv/./api/../api/" })
    expect(await directory("ws_cold")).toBe("/srv/api")
    // Generic registration, which the desktop and the self-hosted node use.
    await input.workspace.registerLocalForSharing(alice, { workspaceId: "ws_reg", displayName: "reg", orgId: "org_acme", remoteDirectory: "/srv/reg//" })
    expect(await directory("ws_reg")).toBe("/srv/reg")
    // Re-assignment of an existing row with a directory.
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_reg", hostId: enrollment.host_id, remoteDirectory: "/srv/reg/../reg2/" })
    expect(await directory("ws_reg")).toBe("/srv/reg2")
    // Re-assignment without one: the stale stored value is written back normalized, not kept.
    await input.database.prepare("update workspaces set remote_directory = '/srv/reg2/../reg3/' where workspace_id = 'ws_reg'").run()
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_reg", hostId: enrollment.host_id })
    expect(await directory("ws_reg")).toBe("/srv/reg3")
    // A Windows path on an account machine is recorded as given.
    await enrollAccountMachine(input, alice, "laptop-n")
    await input.hostAccess.assignWorkspaceHost(owner, { workspaceId: "ws_win", hostId: "laptop-n", orgId: "org_acme", remoteDirectory: "C:\\Users\\dev\\app\\" })
    expect(await directory("ws_win")).toBe("C:\\Users\\dev\\app\\")
  })

  test("hostEnrollmentByHost answers the caller's live machine by host id and nothing for a revoked, foreign or unknown one", async () => {
    const input = await setup()
    const { alice, bob } = await fixture(input)
    const owner = await signed(input.workspace, "alice", "org_acme")
    const laptop = await enrollAccountMachine(input, alice, "laptop")
    const vps = await redeem(input, await invite(input, owner, ["/srv"]), "vps", await hostKey())
    await enrollAccountMachine(input, alice, "gone")
    await input.hostAccess.revokeHostEnrollment(alice, { hostId: "gone" })
    await enrollAccountMachine(input, bob, "bobs")
    expect(await input.hostAccess.hostEnrollmentByHost(alice, { hostId: "laptop" }))
      .toEqual({ enrollment_id: laptop.enrollmentId, host_id: "laptop", enrolled_via: "account" })
    expect(await input.hostAccess.hostEnrollmentByHost(alice, { hostId: "vps" }))
      .toEqual({ enrollment_id: vps.enrollment.enrollment_id, host_id: "vps", enrolled_via: "invitation" })
    for (const hostId of ["gone", "bobs", "nope"]) {
      expect(await input.hostAccess.hostEnrollmentByHost(alice, { hostId })).toBeUndefined()
    }
  })

  async function storedProviderConfig(input: Input, enrollmentId: string) {
    return await input.database.prepare(
      `select sealing_public_key_json, provider_config_sealed, provider_config_sealed_key_json,
              provider_config_provider_ids, provider_config_revision, provider_config_acked_revision
       from host_enrollments where enrollment_id = ?`,
    ).bind(enrollmentId).first()
  }

  test("the owner pushes ciphertext sealed to the key the machine declared, the beat carries it until the machine acks, and no other account can read the target or push", async () => {
    const input = await setup()
    const { alice, bob } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-p", { displayName: "Push box" })
    const key = await sealingKey()

    // Nothing pushable before a beat declares a key: the target says so and the write refuses a null key outright.
    expect(await input.hostAccess.hostProviderConfigTarget(alice, { enrollmentId })).toEqual({
      enrollment_id: enrollmentId,
      host_id: "machine-p",
      display_name: "Push box",
      sealing_public_key: null,
      next_revision: 1,
    })
    await expect(input.hostAccess.pushHostProviderConfig(alice, {
      enrollmentId,
      sealed: "mseal1.e.i.c",
      revision: 1,
      sealingPublicKey: null,
      providerIds: ["openai"],
    })).rejects.toMatchObject({ code: "host_sealing_key_undeclared", status: 409 })

    expect(await machineBeat(input, enrollmentId, [], { sealingPublicKey: key.publicKey })).not.toHaveProperty("provider_config")
    const target = await input.hostAccess.hostProviderConfigTarget(alice, { enrollmentId })
    expect(target.sealing_public_key).toBe(key.stored)
    expect(target.next_revision).toBe(1)

    // The grant is the owner's alone. Bob is a member of the same organization and learns nothing.
    await expect(input.hostAccess.hostProviderConfigTarget(bob, { enrollmentId }))
      .rejects.toMatchObject({ code: "host_enrollment_not_found", status: 404 })
    await expect(input.hostAccess.pushHostProviderConfig(bob, {
      enrollmentId,
      sealed: "mseal1.e.i.c",
      revision: 1,
      sealingPublicKey: key.stored,
      providerIds: ["openai"],
    })).rejects.toMatchObject({ code: "host_enrollment_not_found", status: 404 })
    expect(await storedProviderConfig(input, enrollmentId)).toMatchObject({ provider_config_sealed: null, provider_config_revision: 0 })

    expect(await input.hostAccess.pushHostProviderConfig(alice, {
      enrollmentId,
      sealed: "mseal1.e.i.c1",
      revision: 1,
      sealingPublicKey: key.stored,
      providerIds: ["openai", "anthropic"],
    })).toEqual({ enrollment_id: enrollmentId, revision: 1, sealed: true })
    expect(await storedProviderConfig(input, enrollmentId)).toEqual({
      sealing_public_key_json: key.stored,
      provider_config_sealed: "mseal1.e.i.c1",
      provider_config_sealed_key_json: key.stored,
      provider_config_provider_ids: '["anthropic","openai"]',
      provider_config_revision: 1,
      provider_config_acked_revision: 0,
    })

    // Carried on every beat that declares no ack or a stale one.
    expect((await machineBeat(input, enrollmentId, [])).provider_config).toEqual({ revision: 1, sealed: "mseal1.e.i.c1" })
    expect((await machineBeat(input, enrollmentId, [], { providerConfigRevision: 0 })).provider_config)
      .toEqual({ revision: 1, sealed: "mseal1.e.i.c1" })
    // The ack lands in the beat's own batch, so the beat that carries it already answers nothing.
    expect(await machineBeat(input, enrollmentId, [], { providerConfigRevision: 1 })).not.toHaveProperty("provider_config")
    expect(await machineBeat(input, enrollmentId, [])).not.toHaveProperty("provider_config")
    expect(await storedProviderConfig(input, enrollmentId)).toMatchObject({ provider_config_acked_revision: 1 })
    expect((await input.hostAccess.hostProviderConfigTarget(alice, { enrollmentId })).next_revision).toBe(2)
  })

  test("a push at a stale revision or against a key the machine no longer holds writes nothing, including a re-key that lands between the read and the write", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-r")
    const key = await sealingKey()
    const other = await sealingKey()
    await machineBeat(input, enrollmentId, [], { sealingPublicKey: key.publicKey })
    const push = (args: { sealed: string | null; revision: number; sealingPublicKey: string }) =>
      input.hostAccess.pushHostProviderConfig(alice, { enrollmentId, providerIds: ["openai"], ...args })
    await push({ sealed: "mseal1.e.i.c1", revision: 1, sealingPublicKey: key.stored })

    // Two owners' devices read next_revision 2 and both push: the second is refused with where the row is.
    await expect(push({ sealed: "mseal1.e.i.stale", revision: 1, sealingPublicKey: key.stored }))
      .rejects.toMatchObject({ code: "host_provider_config_revision_stale", status: 409, details: { provider_config_revision: 1 } })
    await expect(push({ sealed: "mseal1.e.i.ahead", revision: 3, sealingPublicKey: key.stored }))
      .rejects.toMatchObject({ code: "host_provider_config_revision_stale", status: 409 })
    // Sealed to a key that is not the row's.
    await expect(push({ sealed: "mseal1.e.i.wrong", revision: 2, sealingPublicKey: other.stored }))
      .rejects.toMatchObject({ code: "host_sealing_key_undeclared", status: 409 })
    // The machine re-keys after the owner read the target and before the write lands.
    input.beforeNextBatch(async () => {
      await machineBeat(input, enrollmentId, [], { sealingPublicKey: other.publicKey })
    })
    await expect(push({ sealed: "mseal1.e.i.rekeyed", revision: 2, sealingPublicKey: key.stored }))
      .rejects.toMatchObject({ code: "host_sealing_key_undeclared", status: 409 })
    expect(await storedProviderConfig(input, enrollmentId)).toEqual({
      sealing_public_key_json: other.stored,
      provider_config_sealed: "mseal1.e.i.c1",
      provider_config_sealed_key_json: key.stored,
      provider_config_provider_ids: '["openai"]',
      provider_config_revision: 1,
      provider_config_acked_revision: 0,
    })
    // The blob is sealed to a key the machine has replaced: it is carried on no
    // further beat, and the listing names the cause rather than leaving the
    // owner reading a counter that will never move.
    expect(await machineBeat(input, enrollmentId, [])).not.toHaveProperty("provider_config")
    expect((await input.hostAccess.listHostEnrollments(alice)).find((row) => row.host_id === "machine-r"))
      .toMatchObject({ provider_config_rekeyed: true, provider_config_providers: ["openai"] })

    // Malformed input is refused before any batch: a blob of another format, a revision below 1.
    await expect(push({ sealed: "not-a-seal", revision: 2, sealingPublicKey: other.stored }))
      .rejects.toMatchObject({ code: "invalid_input", status: 400 })
    await expect(push({ sealed: "mseal1.e.i.c2", revision: 0, sealingPublicKey: other.stored }))
      .rejects.toMatchObject({ code: "invalid_input", status: 400 })
    // A beat declaring a key the sealer cannot use is refused and renews nothing.
    const before = await input.hostAccess.activeHostEnrollment(alice)
    input.advance(1_000)
    await expect(machineBeat(input, enrollmentId, [], { sealingPublicKey: '{"kty":"EC","crv":"P-384","x":"a","y":"b"}' }))
      .rejects.toMatchObject({ code: "invalid_input", status: 400 })
    expect(await input.hostAccess.activeHostEnrollment(alice)).toEqual(before)
    // A revoked machine is not a target.
    await input.hostAccess.revokeHostEnrollment(alice, { hostId: "machine-r" })
    await expect(input.hostAccess.hostProviderConfigTarget(alice, { enrollmentId }))
      .rejects.toMatchObject({ code: "host_enrollment_not_found", status: 404 })
  })

  test("the next revision is one above whichever counter is higher, so a control plane restored below the machine still outruns it", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-b")
    const key = await sealingKey()
    await machineBeat(input, enrollmentId, [], { sealingPublicKey: key.publicKey })
    const push = (args: { sealed: string | null; revision: number }) =>
      input.hostAccess.pushHostProviderConfig(alice, { enrollmentId, sealingPublicKey: key.stored, providerIds: ["openai"], ...args })
    await push({ sealed: "mseal1.e.i.c1", revision: 1 })
    await push({ sealed: "mseal1.e.i.c2", revision: 2 })
    await machineBeat(input, enrollmentId, [], { providerConfigRevision: 2 })

    // The stored row goes back to revision 1 while the machine keeps declaring
    // the 2 it holds. The machine applies only a strictly newer revision, so a
    // mint against the stored counter alone would be ignored forever.
    await input.database.prepare(
      `update host_enrollments set provider_config_revision = 1, provider_config_sealed = 'mseal1.e.i.c1' where enrollment_id = ?`,
    ).bind(enrollmentId).run()
    await machineBeat(input, enrollmentId, [], { providerConfigRevision: 2 })
    expect((await input.hostAccess.hostProviderConfigTarget(alice, { enrollmentId })).next_revision).toBe(3)
    await expect(push({ sealed: "mseal1.e.i.replay", revision: 2 }))
      .rejects.toMatchObject({ code: "host_provider_config_revision_stale", status: 409 })
    expect(await push({ sealed: "mseal1.e.i.c3", revision: 3 })).toEqual({ enrollment_id: enrollmentId, revision: 3, sealed: true })
    expect((await machineBeat(input, enrollmentId, [], { providerConfigRevision: 2 })).provider_config)
      .toEqual({ revision: 3, sealed: "mseal1.e.i.c3" })
  })

  test("an empty push is the withdrawal: a new revision holding null that the beat carries, and the fleet listing reports the three counters", async () => {
    const input = await setup()
    const { alice } = await fixture(input)
    const { enrollmentId } = await enrollAccountMachine(input, alice, "machine-w")
    const { enrollmentId: bare } = await enrollAccountMachine(input, alice, "machine-bare")
    const key = await sealingKey()
    await machineBeat(input, enrollmentId, [], { sealingPublicKey: key.publicKey })
    await input.hostAccess.pushHostProviderConfig(alice, {
      enrollmentId,
      sealed: "mseal1.e.i.c1",
      revision: 1,
      sealingPublicKey: key.stored,
      providerIds: ["openai"],
    })
    await machineBeat(input, enrollmentId, [], { providerConfigRevision: 1 })

    expect(await input.hostAccess.pushHostProviderConfig(alice, {
      enrollmentId,
      sealed: null,
      revision: 2,
      sealingPublicKey: key.stored,
      providerIds: [],
    })).toEqual({ enrollment_id: enrollmentId, revision: 2, sealed: false })
    expect(await storedProviderConfig(input, enrollmentId)).toEqual({
      sealing_public_key_json: key.stored,
      provider_config_sealed: null,
      provider_config_sealed_key_json: null,
      provider_config_provider_ids: null,
      provider_config_revision: 2,
      provider_config_acked_revision: 0,
    })
    expect((await machineBeat(input, enrollmentId, [])).provider_config).toEqual({ revision: 2, sealed: null })

    const listed = (hostId: string) =>
      input.hostAccess.listHostEnrollments(alice).then((rows) => rows.find((row) => row.host_id === hostId))
    expect(await listed("machine-w")).toMatchObject({
      provider_config_revision: 2,
      provider_config_acked_revision: 0,
      sealing_key_declared: true,
      provider_config_providers: [],
      provider_config_rekeyed: false,
    })
    await machineBeat(input, enrollmentId, [], { providerConfigRevision: 2 })
    expect(await listed("machine-w")).toMatchObject({ provider_config_revision: 2, provider_config_acked_revision: 2 })
    expect(await machineBeat(input, enrollmentId, [])).not.toHaveProperty("provider_config")
    expect(await listed("machine-bare")).toMatchObject({
      enrollment_id: bare,
      provider_config_revision: 0,
      provider_config_acked_revision: 0,
      sealing_key_declared: false,
      provider_config_providers: [],
      provider_config_rekeyed: false,
    })
  })
})
