import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { exercisePrivateSessionAuthorityConformance } from "@claxedo/server-core/platform/auth/private-session-authority.conformance"

import { D1WorkspaceAuthority } from "./workspace-authority"
import { D1SessionAuthority } from "./session-authority"

const MIGRATIONS = ["0001_service_installations.sql", "0002_workspace_authority.sql", "0003_private_sessions.sql"].map(
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
  const now = () => 1_800_000_000_000 + ++sequence
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
  return { database, workspace, sessions }
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
  const workspace = await input.workspace.createWorkspace(alice, {
    workspaceId: "ws_main",
    orgId: "org_acme",
    displayName: "main",
    repoUrl: "https://github.com/acme/main.git",
    backing: "cloud-vm",
    access: "cloud",
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
  return { alice, bob, admin, outsider, workspace }
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
      lifecycle: { reserved: true, reconciled: true, compensated: true },
      access: { deniedBeforeGrant: true, allowedAfterGrant: true, deniedAfterRevoke: true },
      attribution: { canonicalActorPreserved: true, forgedActorRemoved: true },
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
      access: "cloud",
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

  test("conjoins workspace authority with creator, participant, or current org administration", async () => {
    const input = await setup()
    const { alice, bob, admin, outsider } = await sharedWorkspace(input)
    await reserveAndRegister(input.sessions, alice, { operationId: "op_private", sessionId: "ses_private" })

    expect(await input.sessions.listSessions(bob, { workspaceId: "ws_main" })).toEqual([])
    expect(await input.sessions.listSessions(admin, { workspaceId: "ws_main" })).toEqual([
      expect.objectContaining({ session_id: "ses_private" }),
    ])
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
    await input.database
      .prepare(
        `
      update org_memberships set revoked_at = 99
      where org_id = 'org_acme' and user_id = ?
    `,
      )
      .bind(bob.principal!.userId)
      .run()
    await expect(
      input.sessions.authorizeSessionRead(bob, { sessionId: "ses_bob", workspaceId: "ws_main" }),
    ).rejects.toMatchObject({ status: 403 })
    expect(await input.sessions.listSessions(bob, { workspaceId: "ws_main" })).toEqual([])

    await input.database
      .prepare(
        `
      update org_memberships set revoked_at = 100
      where org_id = 'org_acme' and user_id = ?
    `,
      )
      .bind(admin.principal!.userId)
      .run()
    expect(await input.sessions.listSessions(admin, { workspaceId: "ws_main" })).toEqual([])
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
          claxedo: { author: { id: bob.principal!.actorId, name: "untrusted" } },
        },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: {
          id: "m2",
          role: "user",
          claxedo: { author: { id: alice.principal!.actorId, name: "forged" } },
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
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_messages",
        workspaceId: "ws_main",
        messages,
        maxEventOrdinal: 7,
      }),
    ).resolves.toEqual({ ok: true, applied: true, maxEventOrdinal: 7 })

    const page = (await input.sessions.readSessionMessages(alice, {
      sessionId: "ses_messages",
      workspaceId: "ws_main",
      limit: 2,
    })) as { messages: Array<Record<string, any>>; nextCursor?: string }
    expect(page.messages.map((message) => message.info.id)).toEqual(["m2", "m3"])
    expect(page.messages[0].info.claxedo).toBeUndefined()
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
      }),
    ).resolves.toEqual({ ok: true, applied: false, maxEventOrdinal: 7 })
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_messages",
        workspaceId: "ws_main",
        messages: [...messages, { info: { id: "m4", role: "assistant" }, parts: [] }],
        maxEventOrdinal: 7,
      }),
    ).rejects.toMatchObject({ code: "resource_conflict" })
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_messages",
        workspaceId: "ws_main",
        messages: [{ info: { role: "user" }, parts: [] }],
        maxEventOrdinal: 8,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" })
    await expect(
      input.sessions.syncSessionMessages(bob, {
        sessionId: "ses_unknown",
        workspaceId: "ws_main",
        messages,
        maxEventOrdinal: 8,
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
})
