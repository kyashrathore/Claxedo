import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import {
  exercisePrivateSessionAdoptionConformance,
  exercisePrivateSessionAuthorityConformance,
  exerciseRuntimeForkReservationConformance,
  exerciseSessionShareLevelConformance,
  exerciseSessionShareRuntimeTokenConformance,
  exerciseSessionWriteClassConformance,
} from "@claxedo/server-core/platform/auth/private-session-authority.conformance"
import { exerciseSessionTurnAuthorityConformance } from "@claxedo/server-core/platform/auth/session-turn-authority.conformance"

import { buildSessionListResponse, parseSessionListQuery } from "../../../session/list"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1ChannelRuntimeAuthority } from "./channel-runtime-authority"
import { D1SessionAuthority } from "./session-authority"

const MIGRATIONS = [
  "0001_service_installations.sql",
  "0002_workspace_authority.sql",
  "0003_private_sessions.sql",
  "0004_host_access_and_sharing.sql",
  "0006_channel_identity_and_canonical_runtime.sql",
  "0010_session_turn_leases.sql",
  "0011_session_turn_producers.sql",
  "0013_org_team_session_sharing.sql",
  "0014_host_workspace_assignments.sql",
  "0024_session_last_human_turn.sql",
  "0028_workspace_org_member_visible.sql",
  "0034_drop_workspace_access.sql",
  "0035_session_share_level.sql",
  "0036_drop_workspace_share_role.sql",
].map(
  (name) => fileURLToPath(new URL(`../../../../migrations/control-plane/${name}`, import.meta.url)),
)

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function setup() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const path of MIGRATIONS) {
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration
      .split(/;\s*\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run()
    }
  }
  let sequence = 0
  let currentTime = 1_800_000_000_000
  const now = () => ++currentTime
  const workspace = new D1WorkspaceAuthority(database, {
    deploymentId: "deployment-a",
    product: { kind: "claxedo-hosted" },
    now,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  const sessions = new D1SessionAuthority(database, {
    deploymentId: "deployment-a",
    now,
    randomId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  })
  const runtimeTokens = new D1ChannelRuntimeAuthority(database, {
    deploymentId: "deployment-a",
    now,
    randomId: () => `chn_${String(++sequence).padStart(4, "0")}`,
  })
  return {
    database,
    workspace,
    sessions,
    runtimeTokens,
    now,
    advancePast: (expiresAt: number) => {
      currentTime = Math.max(currentTime, expiresAt)
    },
    rewindTo: (value: number) => {
      currentTime = value
    },
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

async function sharedWorkspace(input: Awaited<ReturnType<typeof setup>>) {
  const alice = await signed(input.workspace, "alice")
  const bob = await signed(input.workspace, "bob")
  const admin = await signed(input.workspace, "admin")
  const outsider = await signed(input.workspace, "outsider")
  const reader = await signed(input.workspace, "reader")
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
  await input.workspace.addOrganizationMember(alice, {
    orgId: "org_acme",
    userId: reader.principal!.userId,
    role: "member",
  })
  const workspace = await input.workspace.createWorkspace(alice, {
    workspaceId: "ws_main",
    orgId: "org_acme",
    displayName: "main",
    repoUrl: "https://github.com/acme/main.git",
    backing: "cloud-vm",
  })
  await input.database
    .prepare(
      `
    insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at)
    values (?, ?, 'editor', 1, 1, null)
  `,
    )
    .bind(workspace.project_id, bob.principal!.userId)
    .run()
  await input.database
    .prepare(
      `
    insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at)
    values (?, ?, 'viewer', 1, 1, null)
  `,
    )
    .bind(workspace.project_id, reader.principal!.userId)
    .run()
  return { alice, bob, admin, outsider, reader, workspace }
}

async function reserveAndRegister(
  sessions: D1SessionAuthority,
  auth: SignedControlPlaneAuth,
  input: { operationId: string; sessionId: string; workspaceId?: string; title?: string },
) {
  await sessions.reserveSession(auth, {
    operationId: input.operationId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId ?? "ws_main",
    kind: "create",
    title: input.title,
  })
  return await sessions.registerRuntimeSession({
    principalKind: "user",
    actorId: auth.principal!.actorId,
    actorKind: "human",
    operationId: input.operationId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId ?? "ws_main",
    title: input.title,
  })
}

describe("D1 private multiplayer session authority", () => {
  test("satisfies the provider-neutral private-session conformance surface", async () => {
    const input = await setup()
    const { alice, bob } = await sharedWorkspace(input)

    await expect(
      exercisePrivateSessionAuthorityConformance({
        authority: input.sessions,
        turnAuthority: input.sessions,
        workspaceId: "ws_main",
        creator: {
          auth: alice,
          runtime: {
            principalKind: "user",
            actorId: alice.principal!.actorId,
            actorKind: "human",
          },
        },
        participant: {
          auth: bob,
          runtime: {
            principalKind: "user",
            actorId: bob.principal!.actorId,
            actorKind: "human",
          },
        },
      }),
    ).resolves.toEqual({
      scenarios: [
        "reservation-reconciliation-compensation",
        "workspace-and-private-session-conjunction",
        "canonical-actor-attribution",
        "explicit-runtime-principal",
      ],
      lifecycle: { reserved: true, reconciled: true, compensated: true, released: true },
      access: { deniedBeforeGrant: true, allowedAfterGrant: true, deniedAfterRevoke: true },
      attribution: { canonicalActorPreserved: true, forgedActorRemoved: true },
    })
  })

  test("satisfies the provider-neutral runtime fork-reservation conformance surface", async () => {
    const input = await setup()
    const { alice, bob } = await sharedWorkspace(input)

    await expect(
      exerciseRuntimeForkReservationConformance({
        authority: input.sessions,
        workspaceId: "ws_main",
        creator: {
          auth: alice,
          runtime: { principalKind: "user", actorId: alice.principal!.actorId, actorKind: "human" },
        },
        participant: {
          auth: bob,
          runtime: { principalKind: "user", actorId: bob.principal!.actorId, actorKind: "human" },
        },
      }),
    ).resolves.toEqual({
      forkReservedUnderAReadableParent: true,
      registeredChildIsPrivateToItsCreator: true,
      refusedUnderAnUnreadableParent: true,
      refusedForAMismatchedIntent: true,
    })
  })

  test("satisfies the provider-neutral session-share-level conformance surface", async () => {
    const input = await setup()
    const { alice, admin, outsider } = await sharedWorkspace(input)
    const teammate = await signed(input.workspace, "teammate")
    await input.workspace.addOrganizationMember(alice, {
      orgId: "org_acme",
      userId: teammate.principal!.userId,
      role: "member",
    })
    // `org_member_visible = 0` withholds the implicit member rank, which is
    // what leaves the teammate with no workspace standing at all and the
    // share as the only thing that can admit them.
    await input.database
      .prepare(`update workspaces set org_member_visible = 0 where workspace_id = ?`)
      .bind("ws_main")
      .run()
    await reserveAndRegister(input.sessions, alice, {
      operationId: "op_shared",
      sessionId: "ses_shared",
    })
    await expect(input.workspace.openWorkspace(teammate, { workspaceId: "ws_main" }))
      .rejects.toMatchObject({ code: "workspace_authorization_denied" })

    await expect(
      exerciseSessionShareLevelConformance({
        authority: input.sessions,
        shares: input.sessions,
        workspaceId: "ws_main",
        sessionId: "ses_shared",
        creator: { auth: alice },
        grantee: {
          auth: teammate,
          runtime: { principalKind: "user", actorId: teammate.principal!.actorId, actorKind: "human" },
          target: { grantedToUserId: teammate.principal!.userId },
        },
        organizationAdministrator: {
          auth: admin,
          runtime: { principalKind: "user", actorId: admin.principal!.actorId, actorKind: "human" },
        },
        outsider: { target: { grantedToUserId: outsider.principal!.userId } },
      }),
    ).resolves.toEqual({
      defaultsToFollow: true,
      followReadsButDoesNotWrite: true,
      sendWritesWithoutWorkspaceRank: true,
      downgradeEndsWriting: true,
      revokeEndsReading: true,
      organizationAdministratorRefusedWithoutAGrant: true,
      offerRefusedOutsideTheOrganization: true,
    })
  })

  test("satisfies the provider-neutral session-share runtime-token conformance surface", async () => {
    const input = await setup()
    const { alice, admin } = await sharedWorkspace(input)
    const teammate = await signed(input.workspace, "teammate")
    await input.workspace.addOrganizationMember(alice, {
      orgId: "org_acme",
      userId: teammate.principal!.userId,
      role: "member",
    })
    // `org_member_visible = 0` withholds the implicit member rank, so the
    // teammate's only standing on this workspace is the share under test. An
    // org ADMIN keeps their rank either way, which is what lets the departing
    // member create a session and what revoking the membership takes back.
    await input.database
      .prepare(`update workspaces set org_member_visible = 0 where workspace_id = ?`)
      .bind("ws_main")
      .run()
    await reserveAndRegister(input.sessions, alice, { operationId: "op_shared", sessionId: "ses_shared" })
    await reserveAndRegister(input.sessions, admin, { operationId: "op_departing", sessionId: "ses_departing" })

    await expect(
      exerciseSessionShareRuntimeTokenConformance({
        sessions: input.sessions,
        workspace: {
          openWorkspace: (auth, args) => input.workspace.openWorkspace(auth, args),
          recordRuntimeAccessToken: (auth, args) => input.runtimeTokens.recordRuntimeAccessToken(auth, args),
          runtimeAccessTokenActive: (args) => input.runtimeTokens.runtimeAccessTokenActive(args),
          grantSessionShare: (auth, args) => input.sessions.grantSessionShare(auth, args),
        },
        workspaceId: "ws_main",
        hostId: "host_alices_desktop",
        sessionId: "ses_shared",
        creator: { auth: alice },
        grantee: {
          auth: teammate,
          runtime: { principalKind: "user", actorId: teammate.principal!.actorId, actorKind: "human" },
          target: { grantedToUserId: teammate.principal!.userId },
        },
        offboarded: {
          auth: admin,
          runtime: { principalKind: "user", actorId: admin.principal!.actorId, actorKind: "human" },
          sessionId: "ses_departing",
          leaveOrganization: async () => {
            await input.database
              .prepare(`update org_memberships set revoked_at = 99 where org_id = 'org_acme' and user_id = ?`)
              .bind(admin.principal!.userId)
              .run()
          },
        },
        expiresAt: 1_800_000_600_000,
      }),
    ).resolves.toEqual({
      tokenRefusedBeforeTheShare: true,
      sendGranteeMintsAViewerTokenAndWrites: true,
      shareNeverWidensTheTokenRole: true,
      followGranteeKeepsTheTokenAndLosesTheTurn: true,
      offboardedCreatorLosesReadWriteAndToken: true,
    })
  })

  test("satisfies the provider-neutral session-adoption conformance surface", async () => {
    const input = await setup()
    const { alice, bob, workspace } = await sharedWorkspace(input)

    await expect(
      exercisePrivateSessionAdoptionConformance({
        authority: input.sessions,
        workspaceId: "ws_main",
        hostId: "host_alices_desktop",
        assignHost: async () => {
          await input.database
            .prepare(
              `
            insert into host_workspace_assignments (
              workspace_id, host_id, org_id, owner_user_id, owner_actor_id, assigned_at, updated_at
            ) values (?, ?, ?, ?, ?, 1, 1)
          `,
            )
            .bind(
              "ws_main",
              "host_alices_desktop",
              workspace.org_id,
              alice.principal!.userId,
              alice.principal!.actorId,
            )
            .run()
        },
        owner: {
          auth: alice,
          runtime: { principalKind: "user", actorId: alice.principal!.actorId, actorKind: "human" },
        },
        member: {
          auth: bob,
          runtime: { principalKind: "user", actorId: bob.principal!.actorId, actorKind: "human" },
        },
      }),
    ).resolves.toEqual({
      refusedBeforeAssignment: true,
      adoptedForEnrollmentOwner: true,
      idempotent: true,
      refusedForMember: true,
      refusedWhenHeldByAnotherCreator: true,
    })
  })

  test("satisfies durable exactly-one turn admission across reconstructed adapters", async () => {
    const input = await setup()
    const { alice, bob } = await sharedWorkspace(input)
    await reserveAndRegister(input.sessions, alice, {
      operationId: "op_turn_conformance",
      sessionId: "ses_turn_conformance",
    })
    await input.sessions.grantSessionParticipant(alice, {
      sessionId: "ses_turn_conformance",
      workspaceId: "ws_main",
      participantActorId: bob.principal!.actorId,
    })
    const reconstructed = new D1SessionAuthority(input.database, {
      deploymentId: "deployment-a",
      now: input.now,
      turnLeaseTtlMs: 5_000,
    })

    await expect(exerciseSessionTurnAuthorityConformance({
      authority: input.sessions,
      reconstructed,
      workspaceId: "ws_main",
      sessionId: "ses_turn_conformance",
      actor: {
        principalKind: "user",
        actorId: alice.principal!.actorId,
        actorKind: "human",
      },
      competitor: {
        principalKind: "user",
        actorId: bob.principal!.actorId,
        actorKind: "human",
      },
      advancePast: input.advancePast,
    })).resolves.toEqual({
      scenarios: [
        "atomic-session-exclusion",
        "idempotent-turn-retry",
        "reconstruction-visibility",
        "expiry-fencing-and-stale-release",
      ],
      exclusion: { concurrentDenied: true, reconstructionDenied: true },
      retry: { idempotent: true },
      recovery: { expiryTakeover: true, staleReleaseFenced: true },
    })
  })

  test("makes reservation retries exact and keeps ambiguous or compensated runtimes invisible", async () => {
    const input = await setup()
    const { alice } = await sharedWorkspace(input)

    const reserved = await input.sessions.reserveSession(alice, {
      operationId: "op_create",
      sessionId: "ses_create",
      workspaceId: "ws_main",
      kind: "create",
      title: "created",
    })
    expect(reserved).toMatchObject({ changed: true, state: "reserved" })
    expect(await input.sessions.listSessions(alice, { workspaceId: "ws_main" })).toEqual([])
    await expect(
      input.sessions.reserveSession(alice, {
        operationId: "op_create",
        sessionId: "ses_changed",
        workspaceId: "ws_main",
        kind: "create",
        title: "created",
      }),
    ).rejects.toMatchObject({ code: "resource_conflict" })

    await input.sessions.markSessionRegistrationAmbiguous({
      principalKind: "user",
      actorId: alice.principal!.actorId,
      actorKind: "human",
      operationId: "op_create",
      sessionId: "ses_create",
      workspaceId: "ws_main",
      reason: "runtime result timed out",
    })
    expect(await input.sessions.listSessions(alice, { workspaceId: "ws_main" })).toEqual([])
    await expect(
      input.sessions.registerRuntimeSession({
        principalKind: "user",
        actorId: alice.principal!.actorId,
        actorKind: "human",
        operationId: "op_different_retry",
        sessionId: "ses_create",
        workspaceId: "ws_main",
        title: "created",
      }),
    ).rejects.toMatchObject({ code: "registration_transition_denied" })
    await expect(
      input.sessions.registerRuntimeSession({
        principalKind: "user",
        actorId: alice.principal!.actorId,
        actorKind: "human",
        operationId: "op_create",
        sessionId: "ses_create",
        workspaceId: "ws_main",
        title: "created",
      }),
    ).resolves.toMatchObject({ registered: true })
    expect(await input.sessions.listSessions(alice, { workspaceId: "ws_main" })).toEqual([
      expect.objectContaining({ session_id: "ses_create", project_id: expect.any(String) }),
    ])

    await input.workspace.createWorkspace(alice, {
      workspaceId: "ws_other",
      orgId: "org_acme",
      displayName: "other",
      repoUrl: "https://github.com/acme/other.git",
      backing: "cloud-vm",
    })
    await expect(
      input.sessions.reserveSession(alice, {
        operationId: "op_cross_workspace_fork",
        sessionId: "ses_cross_workspace_fork",
        workspaceId: "ws_other",
        kind: "fork",
        parentSessionId: "ses_create",
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      await input.database
        .prepare(
          `
      select 1 from session_registration_operations where operation_id = 'op_cross_workspace_fork'
    `,
        )
        .first(),
    ).toBeNull()
    await expect(
      input.database
        .prepare(
          `
      insert into session_registration_operations (
        operation_id, session_id, workspace_id, org_id, project_id, creator_actor_id,
        operation_kind, parent_session_id, requested_title, state, state_reason, created_at, updated_at
      ) values ('op_wrong_project', 'ses_wrong_project', 'ws_main', 'org_acme', 'prj_wrong', ?,
        'create', null, null, 'reserved', null, 1, 1)
    `,
        )
        .bind(alice.principal!.actorId)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)

    await input.sessions.reserveSession(alice, {
      operationId: "op_fork",
      sessionId: "ses_fork",
      workspaceId: "ws_main",
      kind: "fork",
      parentSessionId: "ses_create",
    })
    await expect(
      input.sessions.registerRuntimeSession({
        principalKind: "user",
        actorId: alice.principal!.actorId,
        actorKind: "human",
        operationId: "op_fork",
        sessionId: "ses_fork",
        workspaceId: "ws_main",
      }),
    ).resolves.toMatchObject({ registered: true })

    await input.sessions.reserveSession(alice, {
      operationId: "op_compensate",
      sessionId: "ses_compensate",
      workspaceId: "ws_main",
      kind: "create",
    })
    await input.sessions.beginSessionCompensation({
      principalKind: "user",
      actorId: alice.principal!.actorId,
      actorKind: "human",
      operationId: "op_compensate",
      sessionId: "ses_compensate",
      workspaceId: "ws_main",
      reason: "runtime definitively denied creation",
    })
    await expect(
      input.sessions.registerRuntimeSession({
        principalKind: "user",
        actorId: alice.principal!.actorId,
        actorKind: "human",
        operationId: "op_compensate",
        sessionId: "ses_compensate",
        workspaceId: "ws_main",
      }),
    ).rejects.toMatchObject({ code: "registration_transition_denied" })
    await input.sessions.completeSessionCompensation({
      principalKind: "user",
      actorId: alice.principal!.actorId,
      actorKind: "human",
      operationId: "op_compensate",
      sessionId: "ses_compensate",
      workspaceId: "ws_main",
      reason: "runtime confirmed deletion",
    })
    expect(
      await input.database.prepare("select 1 from sessions where session_id = 'ses_compensate'").first(),
    ).toBeNull()
    expect(
      await input.database
        .prepare("select state, state_reason from session_registration_operations where operation_id = 'op_compensate'")
        .first<{ state: string; state_reason: string }>(),
    ).toEqual({ state: "compensated", state_reason: "runtime confirmed deletion" })

    await expect(
      input.sessions.reserveSession(alice, {
        operationId: "op_compensate_retry",
        sessionId: "ses_compensate",
        workspaceId: "ws_main",
        kind: "create",
      }),
    ).resolves.toMatchObject({ changed: true, state: "reserved", sessionId: "ses_compensate" })
    expect(
      await input.database
        .prepare("select operation_id from session_registration_operations where session_id = 'ses_compensate'")
        .all<{ operation_id: string }>(),
    ).toMatchObject({ results: [{ operation_id: "op_compensate_retry" }] })

    await expect(
      input.sessions.registerRuntimeSession({
        principalKind: "user",
        actorId: alice.principal!.actorId,
        actorKind: "human",
        operationId: "op_unreserved",
        sessionId: "ses_unreserved",
        workspaceId: "ws_main",
      }),
    ).rejects.toMatchObject({ code: "registration_transition_denied" })

    await expect(
      input.database
        .prepare(
          `
      update sessions set project_id = 'project_drift' where session_id = 'ses_create'
    `,
        )
        .run(),
    ).rejects.toThrow(/session scope is immutable/)
  })

  test("admits a session only to its creator, a participant or a share grantee", async () => {
    const input = await setup()
    const { alice, bob, admin, outsider } = await sharedWorkspace(input)
    await reserveAndRegister(input.sessions, alice, { operationId: "op_private", sessionId: "ses_private" })

    expect(await input.sessions.listSessions(bob, { workspaceId: "ws_main" })).toEqual([])
    expect(await input.sessions.listSessions(admin, { workspaceId: "ws_main" })).toEqual([])
    await expect(
      input.sessions.authorizeSessionRead(admin, { sessionId: "ses_private", workspaceId: "ws_main" }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      input.sessions.authorizeSessionWrite(admin, { sessionId: "ses_private", workspaceId: "ws_main" }),
    ).rejects.toMatchObject({ status: 403 })
    expect(await input.sessions.listSessions(outsider, { workspaceId: "ws_main" })).toEqual([])
    expect(
      await input.sessions.readSessionMessages(outsider, {
        sessionId: "ses_private",
        workspaceId: "ws_main",
      }),
    ).toEqual({ allowed: false, messages: [] })
    await input.sessions.grantSessionParticipant(alice, {
      sessionId: "ses_private",
      workspaceId: "ws_main",
      participantActorId: bob.principal!.actorId,
    })
    await expect(
      input.sessions.authorizeSessionWrite(bob, { sessionId: "ses_private", workspaceId: "ws_main" }),
    ).resolves.toBeUndefined()
    expect(await input.sessions.listSessions(bob, { workspaceId: "ws_main" })).toEqual([
      expect.objectContaining({ session_id: "ses_private" }),
    ])

    expect(
      await input.sessions.revokeSessionParticipant(alice, {
        sessionId: "ses_private",
        workspaceId: "ws_main",
        participantActorId: bob.principal!.actorId,
      }),
    ).toEqual({ removed: true })
    await expect(
      input.sessions.authorizeSessionRead(bob, { sessionId: "ses_private", workspaceId: "ws_main" }),
    ).rejects.toMatchObject({ status: 403 })
    expect(
      await input.sessions.revokeSessionParticipant(alice, {
        sessionId: "ses_private",
        workspaceId: "ws_main",
        participantActorId: alice.principal!.actorId,
      }),
    ).toEqual({ removed: false })

    await reserveAndRegister(input.sessions, bob, { operationId: "op_bob", sessionId: "ses_bob" })
    await expect(
      input.sessions.authorizeSessionRead(bob, { sessionId: "ses_bob", workspaceId: "ws_main" }),
    ).resolves.toBeUndefined()
    await input.database
      .prepare(
        `
      update org_memberships set revoked_at = 99
      where org_id = 'org_acme' and user_id = ?
    `,
      )
      .bind(bob.principal!.userId)
      .run()
    // Offboarding ends every grant in the organization, creator standing
    // included: the row Bob created stays in the workspace and Bob reaches
    // none of it.
    await expect(input.workspace.openWorkspace(bob, { workspaceId: "ws_main" }))
      .rejects.toMatchObject({ status: 403 })
    await expect(
      input.sessions.authorizeSessionRead(bob, { sessionId: "ses_bob", workspaceId: "ws_main" }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      input.sessions.authorizeSessionWrite(bob, { sessionId: "ses_bob", workspaceId: "ws_main" }),
    ).rejects.toMatchObject({ status: 403 })
    expect(await input.sessions.listSessions(bob, { workspaceId: "ws_main" })).toEqual([])
    expect(
      await input.database
        .prepare(`select deleted_at from sessions where session_id = 'ses_bob'`)
        .first<{ deleted_at: number | null }>(),
    ).toEqual({ deleted_at: null })

    // An active account is asked of the actor, not only of the signed caller,
    // so a suspension reaches the runtime's own question too.
    await input.database
      .prepare(`update users set state = 'suspended', suspended_at = 101 where user_id = ?`)
      .bind(alice.principal!.userId)
      .run()
    await expect(input.sessions.listSessions(alice, { workspaceId: "ws_main" }))
      .rejects.toMatchObject({ code: "account_suspended" })
    await expect(
      input.sessions.authorizeRuntimeSession({
        principalKind: "user",
        actorId: alice.principal!.actorId,
        actorKind: "human",
        sessionId: "ses_private",
        workspaceId: "ws_main",
        action: "read",
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  test("syncs only registered writable sessions and projects verified message attribution", async () => {
    const input = await setup()
    const { alice, bob } = await sharedWorkspace(input)
    await reserveAndRegister(input.sessions, alice, {
      operationId: "op_messages",
      sessionId: "ses_messages",
      title: "messages",
    })
    await input.sessions.grantSessionParticipant(alice, {
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      participantActorId: bob.principal!.actorId,
    })
    const messages = [
      {
        info: {
          id: "m1",
          role: "user",
          claxedo: { author: { id: alice.principal!.actorId, name: "forged" } },
        },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: {
          id: "m2",
          role: "user",
          claxedo: { author: { id: bob.principal!.actorId, name: "forged" } },
        },
        parts: [{ type: "text", text: "forged" }],
      },
      {
        info: {
          id: "m3",
          role: "assistant",
          claxedo: { author: { id: alice.principal!.actorId, name: "also forged" } },
        },
        parts: [{ type: "text", text: "reply" }],
      },
    ]
    const bobTurn = await input.sessions.acquireSessionTurn({
      principalKind: "user",
      actorId: bob.principal!.actorId,
      actorKind: "human",
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      turnId: "m1",
    })
    await input.sessions.releaseSessionTurn({
      principalKind: "user",
      actorId: bob.principal!.actorId,
      actorKind: "human",
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      turnId: "m1",
      leaseId: bobTurn.leaseId,
      fencingToken: bobTurn.fencingToken,
    })
    const aliceTurn = await input.sessions.acquireSessionTurn({
      principalKind: "user",
      actorId: alice.principal!.actorId,
      actorKind: "human",
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      turnId: "m2",
    })
    await input.sessions.releaseSessionTurn({
      principalKind: "user",
      actorId: alice.principal!.actorId,
      actorKind: "human",
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      turnId: "m2",
      leaseId: aliceTurn.leaseId,
      fencingToken: aliceTurn.fencingToken,
    })
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_messages",
        workspaceId: "ws_main",
        messages,
        maxEventOrdinal: 7,
        fencingToken: aliceTurn.fencingToken,
      }),
    ).resolves.toEqual({ ok: true, applied: true, maxEventOrdinal: 7 })

    const page = (await input.sessions.readSessionMessages(alice, {
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      limit: 2,
    })) as { messages: Array<Record<string, any>>; nextCursor?: string }
    expect(page.messages.map((message) => message.info.id)).toEqual(["m2", "m3"])
    expect(page.messages[0].info.claxedo.author).toEqual({
      id: alice.principal!.actorId,
      kind: "human",
    })
    expect(page.messages[1].info.claxedo).toBeUndefined()
    expect(page.nextCursor).toEqual(expect.any(String))
    const earlier = (await input.sessions.readSessionMessages(alice, {
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      limit: 2,
      before: page.nextCursor,
    })) as { messages: Array<Record<string, any>> }
    expect(earlier.messages).toHaveLength(1)
    expect(earlier.messages[0].info.claxedo.author).toEqual({
      id: bob.principal!.actorId,
      kind: "human",
    })

    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_messages",
        workspaceId: "ws_main",
        messages,
        maxEventOrdinal: 7,
        fencingToken: aliceTurn.fencingToken,
      }),
    ).resolves.toEqual({ ok: true, applied: false, maxEventOrdinal: 7 })
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_messages",
        workspaceId: "ws_main",
        messages: [...messages, { info: { id: "m4", role: "assistant" }, parts: [] }],
        maxEventOrdinal: 7,
        fencingToken: aliceTurn.fencingToken,
      }),
    ).rejects.toMatchObject({ code: "resource_conflict" })
    const takeover = await input.sessions.acquireSessionTurn({
      principalKind: "user",
      actorId: bob.principal!.actorId,
      actorKind: "human",
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      turnId: "m5",
    })
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_messages",
        workspaceId: "ws_main",
        messages,
        maxEventOrdinal: 8,
        fencingToken: aliceTurn.fencingToken,
      }),
    ).rejects.toMatchObject({ code: "resource_conflict", message: expect.stringContaining("stale") })
    expect(takeover.fencingToken).toBeGreaterThan(aliceTurn.fencingToken)
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_messages",
        workspaceId: "ws_main",
        messages: [{ info: { role: "user" }, parts: [] }],
        maxEventOrdinal: 8,
        fencingToken: takeover.fencingToken,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" })
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_unknown",
        workspaceId: "ws_main",
        messages,
        maxEventOrdinal: 8,
        fencingToken: takeover.fencingToken,
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect(await input.database.prepare("select 1 from sessions where session_id = 'ses_unknown'").first()).toBeNull()
  })

  test("updates only registered visible sessions and replace hides only the caller's omitted sessions", async () => {
    const input = await setup()
    const { alice, bob } = await sharedWorkspace(input)
    await reserveAndRegister(input.sessions, alice, { operationId: "op_a", sessionId: "ses_a" })
    await reserveAndRegister(input.sessions, alice, { operationId: "op_b", sessionId: "ses_b" })
    await input.sessions.grantSessionParticipant(alice, {
      sessionId: "ses_b",
      workspaceId: "ws_main",
      participantActorId: bob.principal!.actorId,
    })
    await input.sessions.upsertSessionVisibility(bob, {
      workspaceId: "ws_main",
      sessions: [{ sessionId: "ses_b", title: "participant update" }],
    })
    await expect(
      input.sessions.upsertSessionVisibility(alice, {
        workspaceId: "ws_main",
        sessions: [{ sessionId: "ses_a", createdAt: 123 }],
      }),
    ).rejects.toMatchObject({ code: "resource_conflict" })
    await expect(
      input.sessions.upsertSessionVisibility(alice, {
        workspaceId: "ws_main",
        sessions: [{ sessionId: "ses_unknown", title: "must not fabricate" }],
      }),
    ).rejects.toMatchObject({ status: 403 })
    expect(await input.database.prepare("select 1 from sessions where session_id = 'ses_unknown'").first()).toBeNull()

    await input.sessions.replaceSessionVisibility(alice, {
      workspaceId: "ws_main",
      sessions: [{ sessionId: "ses_a", title: "kept" }],
    })
    expect(await input.sessions.listSessions(alice, { workspaceId: "ws_main" })).toEqual([
      expect.objectContaining({ session_id: "ses_a", title: "kept" }),
    ])
    expect(await input.sessions.listSessions(bob, { workspaceId: "ws_main" })).toEqual([])
    expect(
      await input.database.prepare("select deleted_at from sessions where session_id = 'ses_b'").first(),
    ).toMatchObject({ deleted_at: expect.any(Number) })
  })

  test("stamps the admitted human turn and refuses to move it backwards", async () => {
    const input = await setup()
    const { alice } = await sharedWorkspace(input)
    await reserveAndRegister(input.sessions, alice, { operationId: "op_turn", sessionId: "ses_turn" })
    const runtime = {
      principalKind: "user" as const,
      actorId: alice.principal!.actorId,
      actorKind: "human" as const,
      sessionId: "ses_turn",
      workspaceId: "ws_main",
    }

    const first = await input.sessions.acquireSessionTurn({ ...runtime, turnId: "m1" })
    expect(await input.sessions.listSessions(alice, { workspaceId: "ws_main" })).toEqual([
      expect.objectContaining({ session_id: "ses_turn", last_human_turn_at: first.acquiredAt }),
    ])

    await input.sessions.releaseSessionTurn({
      ...runtime,
      turnId: "m1",
      leaseId: first.leaseId,
      fencingToken: first.fencingToken,
    })
    input.rewindTo(first.acquiredAt - 10_000)
    const second = await input.sessions.acquireSessionTurn({ ...runtime, turnId: "m2" })

    expect(second.acquiredAt).toBeLessThan(first.acquiredAt)
    expect(await input.sessions.listSessions(alice, { workspaceId: "ws_main" })).toEqual([
      expect.objectContaining({ session_id: "ses_turn", last_human_turn_at: first.acquiredAt }),
    ])
  })

  test("leaves a session an agent drove unprompted", async () => {
    const input = await setup()
    const { alice } = await sharedWorkspace(input)
    // Every identity this store mints is a human actor, so the agent row a
    // service principal arrives with has no entrypoint and is seeded directly.
    await input.database
      .prepare(
        `insert into actors (actor_id, user_id, kind, state, created_at, updated_at, revoked_at)
         values (?, ?, 'agent', 'active', 1, 1, null)`,
      )
      .bind("actor_agent", alice.principal!.userId)
      .run()
    const agent = { principalKind: "service" as const, actorId: "actor_agent", actorKind: "agent" as const }
    await input.sessions.reserveRuntimeSession(agent, {
      operationId: "op_agent",
      sessionId: "ses_agent",
      workspaceId: "ws_main",
      kind: "create",
    })
    await input.sessions.registerRuntimeSession({
      ...agent,
      operationId: "op_agent",
      sessionId: "ses_agent",
      workspaceId: "ws_main",
    })

    await input.sessions.acquireSessionTurn({
      ...agent,
      sessionId: "ses_agent",
      workspaceId: "ws_main",
      turnId: "m_agent",
    })

    const rows = await input.sessions.listSessions(alice, { workspaceId: "ws_main" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty("last_human_turn_at")
  })

  test("orders the session list by the last human turn and pages past the never-prompted rows", async () => {
    const input = await setup()
    const { alice } = await sharedWorkspace(input)
    for (const sessionId of ["ses_first", "ses_second", "ses_quiet"]) {
      await reserveAndRegister(input.sessions, alice, { operationId: `op_${sessionId}`, sessionId })
    }
    const prompt = async (sessionId: string, turnId: string) => {
      const runtime = {
        principalKind: "user" as const,
        actorId: alice.principal!.actorId,
        actorKind: "human" as const,
        sessionId,
        workspaceId: "ws_main",
      }
      const lease = await input.sessions.acquireSessionTurn({ ...runtime, turnId })
      await input.sessions.releaseSessionTurn({
        ...runtime,
        turnId,
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      })
    }
    await prompt("ses_first", "m_first")
    await prompt("ses_second", "m_second")

    const sessions = await input.sessions.listSessions(alice, { workspaceId: "ws_main" })
    const page = buildSessionListResponse({ query: sessionListQuery("limit=2"), sessions })
    expect(page.items?.map((item) => item.sessionId)).toEqual(["ses_second", "ses_first"])

    const rest = buildSessionListResponse({
      query: sessionListQuery(`limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`),
      sessions,
    })
    expect(rest.items?.map((item) => item.sessionId)).toEqual(["ses_quiet"])
  })
})

/** The query `GET /api/control/session-list` builds for a cloud workspace rail. */
function sessionListQuery(search: string) {
  return parseSessionListQuery(
    new URL(
      `https://control.test/api/control/session-list?scope=workspace&workspaceId=ws_main&sort=human_turn_desc&${search}`,
    ),
  )
}

describe("D1 session authority, shares of a session this plane never registered", () => {
  test("answers the organization it belongs to and refuses everyone else", async () => {
    const input = await setup()
    const { alice, outsider } = await sharedWorkspace(input)
    const teammate = await signed(input.workspace, "teammate")
    await input.workspace.addOrganizationMember(alice, {
      orgId: "org_acme",
      userId: teammate.principal!.userId,
      role: "member",
    })
    // Withholding the implicit member rank leaves the teammate standing in
    // the organization and nowhere else, which is what the two twins have to
    // answer the same way.
    await input.database
      .prepare(`update workspaces set org_member_visible = 0 where workspace_id = ?`)
      .bind("ws_main")
      .run()

    await expect(input.sessions.listSessionShares(teammate, {
      sessionId: "ses_created_on_the_machine",
      workspaceId: "ws_main",
    })).resolves.toEqual({ can_manage_shares: false, grants: [], participants: [], teams: [] })
    await expect(input.sessions.listSessionShares(outsider, {
      sessionId: "ses_created_on_the_machine",
      workspaceId: "ws_main",
    })).rejects.toMatchObject({ code: "workspace_authorization_denied" })
  })
})

describe("D1 session authority, write classes", () => {
  test("satisfies the provider-neutral session-write-class conformance surface", async () => {
    const input = await setup()
    const { alice } = await sharedWorkspace(input)
    const teammate = await signed(input.workspace, "teammate")
    await input.workspace.addOrganizationMember(alice, {
      orgId: "org_acme",
      userId: teammate.principal!.userId,
      role: "member",
    })
    // `org_member_visible = 0` withholds the implicit member rank, so the
    // share is the teammate's only standing and the class alone decides each
    // write.
    await input.database
      .prepare(`update workspaces set org_member_visible = 0 where workspace_id = ?`)
      .bind("ws_main")
      .run()
    await reserveAndRegister(input.sessions, alice, { operationId: "op_classes", sessionId: "ses_classes" })
    await expect(input.workspace.openWorkspace(teammate, { workspaceId: "ws_main" }))
      .rejects.toMatchObject({ code: "workspace_authorization_denied" })

    await expect(
      exerciseSessionWriteClassConformance({
        authority: input.sessions,
        shares: input.sessions,
        workspaceId: "ws_main",
        sessionId: "ses_classes",
        creator: {
          auth: alice,
          runtime: { principalKind: "user", actorId: alice.principal!.actorId, actorKind: "human" },
        },
        grantee: {
          runtime: { principalKind: "user", actorId: teammate.principal!.actorId, actorKind: "human" },
          target: { grantedToUserId: teammate.principal!.userId },
        },
      }),
    ).resolves.toEqual({
      sendGranteeDrivesTheTurn: true,
      sendGranteeRefusedSessionControl: true,
      creatorHoldsBothClasses: true,
      absentClassAsksAboutTheTurn: true,
    })
  })
})
