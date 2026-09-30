import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import {
  exercisePrivateSessionAdoptionConformance,
  exercisePrivateSessionAuthorityConformance,
  exerciseRuntimeForkReservationConformance,
  exerciseSessionShareLevelConformance,
  exerciseSessionShareRuntimeTokenConformance,
  exerciseSessionWriteClassConformance,
} from "@claxedo/server-core/platform/auth/private-session-authority.conformance"
import {
  exerciseSessionTurnAuthorityConformance,
  exerciseSessionTurnGrantConformance,
} from "@claxedo/server-core/platform/auth/session-turn-authority.conformance"
import { exerciseSessionPageConformance } from "@claxedo/server-core/platform/auth/session-page.conformance"
import { exerciseLatestViewConformance } from "@claxedo/server-core/platform/auth/latest-view.conformance"
import { exerciseFirstReadConformance } from "@claxedo/server-core/platform/auth/first-read.conformance"
import { exerciseTurnPageConformance } from "@claxedo/server-core/platform/auth/turn-page.conformance"
import { exerciseSessionPartConformance } from "@claxedo/server-core/platform/auth/session-part.conformance"
import { createSqlitePrivateSessionAuthority } from "./private-session-authority"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"
import { openAuthorityDb, upsertUser } from "./workspace-authority-store"

function auth(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `token_${subject}`,
    user: {
      subject,
      tokenIdentifier: `https://identity.example.test|${subject}`,
      issuer: "https://identity.example.test",
    },
  }
}

const openAuthorities: Array<{ close(): void }> = []
const temporaryDirectories: string[] = []

function authority() {
  const value = createSqliteWorkspaceAuthority({ path: ":memory:" })
  openAuthorities.push(value)
  return value
}

afterEach(() => {
  for (const value of openAuthorities.splice(0)) value.close()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/**
 * The authority and a second handle on the same file, which is what writing a
 * workspace or organization membership takes: the authority's only grant call
 * is a session share, and `:memory:` gives a second handle a different
 * database.
 */
function authorityWithSeed() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-session-authority-"))
  temporaryDirectories.push(directory)
  const databasePath = path.join(directory, "authority.db")
  const store = createSqliteWorkspaceAuthority({ path: databasePath })
  const seed = openAuthorityDb({ path: databasePath })
  openAuthorities.push(store, seed)
  return { store, seed }
}

function orgMember(seed: () => Database.Database, workspaceId: string, tokenIdentifier: string, role: string) {
  const now = Date.now()
  const db = seed()
  const workspace = db.prepare(`SELECT org_id FROM workspaces WHERE workspace_id = ?`).get(workspaceId) as { org_id: string }
  db.prepare(`
    INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (org_id, token_identifier) DO UPDATE SET role = excluded.role
  `).run(workspace.org_id, tokenIdentifier, role, now, now)
}

describe("SQLite private-session authority", () => {
  test("satisfies the provider-neutral conformance runner", async () => {
    const creator = auth("creator")
    const member = auth("member")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(member)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", member.user.tokenIdentifier, "admin")

    await expect(exercisePrivateSessionAuthorityConformance({
      authority: store,
      setWorkspaceAvailable: async (available) => {
        seed().prepare("UPDATE workspaces SET deleted_at = ? WHERE workspace_id = ?")
          .run(available ? null : Date.now(), "workspace_main")
      },
      turnAuthority: store,
      workspaceId: "workspace_main",
      creator: {
        auth: creator,
        runtime: {
          principalKind: "user",
          actorId: creator.user.tokenIdentifier,
          actorKind: "human",
        },
      },
      member: {
        auth: member,
        runtime: {
          principalKind: "user",
          actorId: member.user.tokenIdentifier,
          actorKind: "human",
        },
      },
    })).resolves.toMatchObject({
      lifecycle: { reserved: true, reconciled: true, compensated: true, released: true },
      access: { memberRefusedTheSession: true, memberRefusedCreation: true, participantGrantRefused: true },
      attribution: { canonicalActorPreserved: true, forgedActorRemoved: true },
    })
  })

  test("satisfies the provider-neutral runtime fork-reservation conformance runner", async () => {
    const creator = auth("creator")
    const member = auth("member")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(member)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", member.user.tokenIdentifier, "member")

    seed().prepare(`INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at)
      SELECT project_id, ?, 'editor', 1, 1 FROM workspaces WHERE workspace_id = 'workspace_main'`)
      .run(member.user.tokenIdentifier)

    await expect(exerciseRuntimeForkReservationConformance({
      setParentShare: async (sessionId, level) => {
        const target = { sessionId, workspaceId: "workspace_main", grantedToTokenIdentifier: member.user.tokenIdentifier }
        if (level) await store.grantSessionShare!(creator, { ...target, level })
        else await store.revokeSessionShare!(creator, target)
      },
      authority: store,
      workspaceId: "workspace_main",
      creator: {
        auth: creator,
        runtime: { principalKind: "user", actorId: creator.user.tokenIdentifier, actorKind: "human" },
      },
      member: {
        auth: member,
        runtime: { principalKind: "user", actorId: member.user.tokenIdentifier, actorKind: "human" },
      },
    })).resolves.toEqual({
      forkReservedUnderAWritableParent: true,
      registeredChildIsPrivateToItsCreator: true,
      refusedUnderAnUnreadableParent: true,
      refusedToAShareHolderAtEitherLevel: true,
      refusedForAMismatchedIntent: true,
    })
  })

  test("satisfies the provider-neutral session-adoption conformance runner", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-session-adoption-"))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, "authority.db")
    const owner = auth("owner")
    const member = auth("member")
    const store = createSqliteWorkspaceAuthority({ path: databasePath })
    const seed = openAuthorityDb({ path: databasePath })
    openAuthorities.push(store, seed)
    await store.usersMe(member)
    await store.createCloudWorkspace(owner, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", member.user.tokenIdentifier, "admin")

    await expect(exercisePrivateSessionAdoptionConformance({
      authority: store,
      workspaceId: "workspace_main",
      hostId: "host_owners_desktop",
      // The real path here is an enrollment plus `assignWorkspaceHost`; the
      // row it writes is what adoption reads, and it is seeded directly so the
      // two adapters answer the same suite from the same starting state.
      assignHost: async () => {
        seed().prepare(`
          INSERT INTO host_workspace_assignments (
            workspace_id, host_id, owner_token_identifier, revision, assigned_at, updated_at
          ) VALUES (?, ?, ?, 1, 1, 1)
        `).run("workspace_main", "host_owners_desktop", owner.user.tokenIdentifier)
      },
      owner: {
        auth: owner,
        runtime: { principalKind: "user", actorId: owner.user.tokenIdentifier, actorKind: "human" },
      },
      member: {
        auth: member,
        runtime: { principalKind: "user", actorId: member.user.tokenIdentifier, actorKind: "human" },
      },
    })).resolves.toEqual({
      refusedBeforeAssignment: true,
      adoptedForEnrollmentOwner: true,
      idempotent: true,
      refusedForMember: true,
      refusedWhileAReservationHoldsIt: true,
    })
  })

  test("satisfies the provider-neutral session-share-level conformance surface", async () => {
    const creator = auth("creator")
    const grantee = auth("grantee")
    const administrator = auth("administrator")
    const outsider = auth("outsider")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(grantee)
    await store.usersMe(administrator)
    await store.usersMe(outsider)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", grantee.user.tokenIdentifier, "member")
    orgMember(seed, "workspace_main", administrator.user.tokenIdentifier, "admin")
    for (const sessionId of ["session_shared", "session_unshared"]) {
      await store.reserveSession(creator, {
        operationId: `operation_${sessionId}`,
        sessionId,
        workspaceId: "workspace_main",
        kind: "create",
      })
      await store.registerRuntimeSession({
        createdAt: Date.now(),
        updatedAt: Date.now(),
        principalKind: "user",
        actorId: creator.user.tokenIdentifier,
        actorKind: "human",
        operationId: `operation_${sessionId}`,
        sessionId,
        workspaceId: "workspace_main",
      })
    }

    await expect(exerciseSessionShareLevelConformance({
      authority: store,
      shares: store,
      workspaceId: "workspace_main",
      sessionId: "session_shared",
      otherSessionId: "session_unshared",
      creator: { auth: creator },
      grantee: {
        auth: grantee,
        runtime: { principalKind: "user", actorId: grantee.user.tokenIdentifier, actorKind: "human" },
        target: { grantedToTokenIdentifier: grantee.user.tokenIdentifier },
      },
      organizationAdministrator: {
        auth: administrator,
        runtime: { principalKind: "user", actorId: administrator.user.tokenIdentifier, actorKind: "human" },
      },
      outsider: { target: { grantedToTokenIdentifier: outsider.user.tokenIdentifier } },
    })).resolves.toEqual({
      defaultsToFollow: true,
      followReadsButDoesNotWrite: true,
      sendWritesWithoutWorkspaceRank: true,
      downgradeEndsWriting: true,
      revokeEndsReading: true,
      shareReachesNoOtherSession: true,
      organizationAdministratorRefusedWithoutAGrant: true,
      offerRefusedOutsideTheOrganization: true,
    })
    await expect(store.openWorkspace(grantee, { workspaceId: "workspace_main" }))
      .rejects.toMatchObject({ code: "workspace_authorization_denied" })
  })

  test("satisfies the provider-neutral session-share runtime-token conformance surface", async () => {
    const founder = auth("founder")
    const owner = auth("owner")
    const grantee = auth("grantee")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(owner)
    await store.usersMe(grantee)
    await store.createCloudWorkspace(founder, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", owner.user.tokenIdentifier, "member")
    orgMember(seed, "workspace_main", grantee.user.tokenIdentifier, "member")
    // The founder cannot leave the organization they own, so the workspace is
    // handed to a member whose departure the suite can make.
    seed().prepare(`UPDATE workspaces SET owner_token_identifier = ? WHERE workspace_id = ?`)
      .run(owner.user.tokenIdentifier, "workspace_main")
    await store.reserveSession(owner, { operationId: "operation_shared", sessionId: "session_shared", workspaceId: "workspace_main", kind: "create" })
    await store.registerRuntimeSession({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalKind: "user",
      actorId: owner.user.tokenIdentifier,
      actorKind: "human",
      operationId: "operation_shared",
      sessionId: "session_shared",
      workspaceId: "workspace_main",
    })

    await expect(exerciseSessionShareRuntimeTokenConformance({
      sessions: store,
      workspace: store,
      workspaceId: "workspace_main",
      hostId: "host_main",
      sessionId: "session_shared",
      owner: {
        auth: owner,
        runtime: { principalKind: "user", actorId: owner.user.tokenIdentifier, actorKind: "human" },
        leaveOrganization: async () => {
          const workspace = seed().prepare(`SELECT org_id FROM workspaces WHERE workspace_id = ?`)
            .get("workspace_main") as { org_id: string }
          seed().prepare(`DELETE FROM org_memberships WHERE org_id = ? AND token_identifier = ?`)
            .run(workspace.org_id, owner.user.tokenIdentifier)
        },
      },
      grantee: {
        auth: grantee,
        runtime: { principalKind: "user", actorId: grantee.user.tokenIdentifier, actorKind: "human" },
        target: { grantedToTokenIdentifier: grantee.user.tokenIdentifier },
      },
      expiresAt: Date.now() + 600_000,
    })).resolves.toEqual({
      workspaceRefusedToAShareHolder: true,
      workspaceTokenRefusedToAShareHolder: true,
      sendShareDrivesTheTurn: true,
      downgradeEndsTheTurn: true,
      ownerHoldsTheWorkspaceToken: true,
      offboardedOwnerLosesSessionWorkspaceAndToken: true,
    })
  })

  test("satisfies durable session-turn conformance across reconstructed adapters", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-session-turn-conformance-"))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, "authority.db")
    const creator = auth("creator")
    const participant = auth("participant")
    const first = createSqliteWorkspaceAuthority({ path: databasePath })
    const reconstructed = createSqliteWorkspaceAuthority({ path: databasePath })
    const seed = openAuthorityDb({ path: databasePath })
    openAuthorities.push(first, reconstructed, seed)
    await first.usersMe(participant)
    await first.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    await first.reserveSession(creator, {
      operationId: "operation_turns",
      sessionId: "session_turns",
      workspaceId: "workspace_main",
      kind: "create",
    })
    await first.registerRuntimeSession({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalKind: "user",
      actorId: creator.user.tokenIdentifier,
      actorKind: "human",
      operationId: "operation_turns",
      sessionId: "session_turns",
      workspaceId: "workspace_main",
    })
    orgMember(seed, "workspace_main", participant.user.tokenIdentifier, "member")
    await first.grantSessionShare!(creator, {
      sessionId: "session_turns",
      workspaceId: "workspace_main",
      grantedToTokenIdentifier: participant.user.tokenIdentifier,
      level: "send",
    })
    let currentTime = Date.now()
    const originalNow = Date.now
    Date.now = () => currentTime
    try {
      await expect(exerciseSessionTurnAuthorityConformance({
        authority: first,
        reconstructed,
        workspaceId: "workspace_main",
        sessionId: "session_turns",
        actor: {
          principalKind: "user",
          actorId: creator.user.tokenIdentifier,
          actorKind: "human",
        },
        competitor: {
          principalKind: "user",
          actorId: participant.user.tokenIdentifier,
          actorKind: "human",
        },
        advancePast(expiresAt) {
          currentTime = expiresAt + 1
        },
      })).resolves.toMatchObject({
        exclusion: { concurrentDenied: true, reconstructionDenied: true },
        recovery: { expiryTakeover: true, staleReleaseFenced: true },
      })
    } finally {
      Date.now = originalNow
    }
  })

  test("satisfies deferred turn-grant conformance across reconstructed adapters", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-session-turn-grant-conformance-"))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, "authority.db")
    const creator = auth("creator")
    const grantee = auth("grantee")
    const first = createSqliteWorkspaceAuthority({ path: databasePath })
    const reconstructed = createSqliteWorkspaceAuthority({ path: databasePath })
    const seed = openAuthorityDb({ path: databasePath })
    openAuthorities.push(first, reconstructed, seed)
    await first.usersMe(grantee)
    await first.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    await first.reserveSession(creator, {
      operationId: "operation_grant_parent",
      sessionId: "session_grant_parent",
      workspaceId: "workspace_main",
      kind: "create",
    })
    await first.registerRuntimeSession({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalKind: "user",
      actorId: creator.user.tokenIdentifier,
      actorKind: "human",
      operationId: "operation_grant_parent",
      sessionId: "session_grant_parent",
      workspaceId: "workspace_main",
    })
    orgMember(seed, "workspace_main", grantee.user.tokenIdentifier, "member")
    let currentTime = Date.now()
    const originalNow = Date.now
    Date.now = () => currentTime
    try {
      await expect(exerciseSessionTurnGrantConformance({
        authority: first,
        reconstructed,
        registrations: first,
        workspaceId: "workspace_main",
        sessionId: "session_grant_parent",
        creator: { principalKind: "user", actorId: creator.user.tokenIdentifier, actorKind: "human" },
        grantee: { principalKind: "user", actorId: grantee.user.tokenIdentifier, actorKind: "human" },
        setGranteeShare: async (level) => {
          const target = {
            sessionId: "session_grant_parent",
            workspaceId: "workspace_main",
            grantedToTokenIdentifier: grantee.user.tokenIdentifier,
          }
          if (level) await first.grantSessionShare!(creator, { ...target, level })
          else await first.revokeSessionShare!(creator, target)
        },
        turnProducer: async (turnId) => {
          const row = seed().prepare<unknown[], { actor_id: string }>(
            `SELECT actor_id FROM session_turn_producers WHERE session_id = ? AND turn_id = ?`,
          ).get("session_grant_parent", turnId)
          return row ? { actorId: row.actor_id } : undefined
        },
        advancePast(expiresAt) {
          currentTime = expiresAt + 1
        },
      })).resolves.toEqual({
        scenarios: [
          "grant-under-send-share",
          "redeem-mints-lease-and-producer",
          "same-turn-retry-returns-the-live-lease",
          "redeemed-grant-refused-after-release",
          "turn-id-and-prefix-mismatch-refused",
          "wrong-actor-refused",
          "expired-refused",
          "downgraded-share-refused-without-lease-or-producer",
          "revoked-refused",
          "reconstruction-visibility",
        ],
        grant: { requiresSendShare: true, requiresChildRegistration: true },
        redemption: { leaseAndProducer: true, sameTurnRetry: true, refusedAfterRelease: true },
        refusals: { mismatch: true, wrongActor: true, expired: true, downgradedShare: true, revoked: true },
        reconstruction: { visible: true },
      })
    } finally {
      Date.now = originalNow
    }
  })

  test("rejects changed operation retries and visibility writes without registration", async () => {
    const creator = auth("creator")
    const store = authority()
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    await store.reserveSession(creator, {
      operationId: "operation_1",
      sessionId: "session_1",
      workspaceId: "workspace_main",
      kind: "create",
    })

    await expect(store.reserveSession(creator, {
      operationId: "operation_1",
      sessionId: "session_changed",
      workspaceId: "workspace_main",
      kind: "create",
    })).rejects.toMatchObject({ code: "resource_conflict" })
    await expect(store.upsertSessionVisibility(creator, {
      workspaceId: "workspace_main",
      sessions: [{ sessionId: "unregistered" }],
    })).rejects.toMatchObject({ status: 403 })
    expect(await store.listSessions(creator, { workspaceId: "workspace_main" })).toEqual([])
  })

  test("stamps the admitted human turn and refuses to move it backwards", async () => {
    const creator = auth("creator")
    const runtime = {
      principalKind: "user" as const,
      actorId: creator.user.tokenIdentifier,
      actorKind: "human" as const,
      sessionId: "session_1",
      workspaceId: "workspace_main",
    }
    const store = authority()
    let currentTime = 1_800_000_000_000
    const originalNow = Date.now
    Date.now = () => currentTime
    try {
      await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
      await store.reserveSession(creator, {
        operationId: "operation_1",
        sessionId: "session_1",
        workspaceId: "workspace_main",
        kind: "create",
      })
      await store.registerRuntimeSession({ ...runtime, operationId: "operation_1", createdAt: Date.now(), updatedAt: Date.now() })

      currentTime = 1_800_000_050_000
      const first = await store.acquireSessionTurn({ ...runtime, turnId: "message_1" })
      expect(await store.listSessions(creator, { workspaceId: "workspace_main" })).toEqual([
        expect.objectContaining({ session_id: "session_1", last_human_turn_at: 1_800_000_050_000 }),
      ])

      await store.releaseSessionTurn({
        ...runtime,
        turnId: "message_1",
        leaseId: first.leaseId,
        fencingToken: first.fencingToken,
      })
      currentTime = 1_800_000_040_000
      await store.acquireSessionTurn({ ...runtime, turnId: "message_2" })

      expect(await store.listSessions(creator, { workspaceId: "workspace_main" })).toEqual([
        expect.objectContaining({ session_id: "session_1", last_human_turn_at: 1_800_000_050_000 }),
      ])
    } finally {
      Date.now = originalNow
    }
  })

  test("a deleted session keeps its runtime's update time; only its deletion takes the authority's clock", async () => {
    const { store, seed } = authorityWithSeed()
    const creator = auth("creator")
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    for (const sessionId of ["session_deleted", "session_replaced", "session_kept"]) {
      await store.reserveSession(creator, { operationId: `operation_${sessionId}`, sessionId, workspaceId: "workspace_main", kind: "create" })
      await store.registerRuntimeSession({
        createdAt: 500,
        updatedAt: 1_000,
        principalKind: "user",
        actorId: creator.user.tokenIdentifier,
        actorKind: "human",
        operationId: `operation_${sessionId}`,
        sessionId,
        workspaceId: "workspace_main",
      })
    }

    await store.deleteSessionVisibility(creator, { workspaceId: "workspace_main", sessionId: "session_deleted" })
    await store.replaceSessionVisibility(creator, { workspaceId: "workspace_main", sessions: [{ sessionId: "session_kept" }] })

    const stored = seed().prepare(`SELECT session_id, updated_at, deleted_at FROM session_history ORDER BY session_id`).all()
    expect(stored).toEqual([
      { session_id: "session_deleted", updated_at: 1_000, deleted_at: expect.any(Number) },
      { session_id: "session_kept", updated_at: 1_000, deleted_at: null },
      { session_id: "session_replaced", updated_at: 1_000, deleted_at: expect.any(Number) },
    ])
  })

  test("leaves a session an agent drove unprompted", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-agent-turn-"))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, "authority.db")
    const store = createSqliteWorkspaceAuthority({ path: databasePath })
    const seed = openAuthorityDb({ path: databasePath })
    openAuthorities.push(store, seed)
    const creator = auth("creator")
    // Every signed request upserts a human user, so the agent row a service
    // principal arrives with has no entrypoint here and is seeded directly.
    upsertUser(seed(), { token_identifier: "actor_agent", kind: "agent" })

    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    await store.reserveSession(creator, {
      operationId: "operation_1",
      sessionId: "session_1",
      workspaceId: "workspace_main",
      kind: "create",
    })
    await store.registerRuntimeSession({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalKind: "user",
      actorId: creator.user.tokenIdentifier,
      actorKind: "human",
      operationId: "operation_1",
      sessionId: "session_1",
      workspaceId: "workspace_main",
    })
    orgMember(seed, "workspace_main", "actor_agent", "member")
    await store.grantSessionParticipant(creator, {
      sessionId: "session_1",
      workspaceId: "workspace_main",
      participantActorId: "actor_agent",
    })

    await store.acquireSessionTurn({
      principalKind: "service",
      actorId: "actor_agent",
      actorKind: "agent",
      sessionId: "session_1",
      workspaceId: "workspace_main",
      turnId: "message_agent",
    })

    const rows = await store.listSessions(creator, { workspaceId: "workspace_main" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty("last_human_turn_at")
  })

  test("hard-cuts legacy workspace-visible sessions instead of inventing private attribution", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-private-session-hard-cut-"))
    temporaryDirectories.push(directory)
    const databasePath = path.join(directory, "authority.db")
    const legacy = new Database(databasePath)
    legacy.exec(`
      CREATE TABLE session_history (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        created_by_token_identifier TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        max_event_ordinal INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );
      CREATE TABLE session_messages (
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT,
        ordinal INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
      INSERT INTO session_history VALUES (
        'legacy_session', 'workspace_main', 'legacy_provider_subject', 'Legacy', 1, 1, 0, NULL
      );
    `)
    legacy.close()

    const store = createSqliteWorkspaceAuthority({ path: databasePath })
    openAuthorities.push(store)
    const creator = auth("creator")
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })

    await expect(store.listSessions(creator, { workspaceId: "workspace_main" })).resolves.toEqual([])
    await expect(store.resolveSession(creator, { sessionId: "legacy_session" })).resolves.toBeNull()
  })
})

describe("SQLite private-session authority, shares of a session this store never registered", () => {
  test("answers the organization it belongs to and refuses everyone else", async () => {
    const creator = auth("creator")
    const teammate = auth("teammate")
    const outsider = auth("outsider")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(teammate)
    await store.usersMe(outsider)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", teammate.user.tokenIdentifier, "member")

    await expect(store.listSessionShares!(teammate, {
      sessionId: "session_created_on_the_machine",
      workspaceId: "workspace_main",
    })).resolves.toEqual({ can_manage_shares: false, grants: [], participants: [], teams: [] })
    await expect(store.listSessionShares!(outsider, {
      sessionId: "session_created_on_the_machine",
      workspaceId: "workspace_main",
    })).rejects.toThrow("session_share_admin_required")
  })
})

describe("SQLite private-session authority, write classes", () => {
  test("satisfies the provider-neutral session-write-class conformance surface", async () => {
    const creator = auth("creator")
    const grantee = auth("grantee")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(grantee)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", grantee.user.tokenIdentifier, "member")
    await store.reserveSession(creator, {
      operationId: "operation_classes",
      sessionId: "session_classes",
      workspaceId: "workspace_main",
      kind: "create",
    })
    await store.registerRuntimeSession({
      createdAt: Date.now(),
      updatedAt: Date.now(),
      principalKind: "user",
      actorId: creator.user.tokenIdentifier,
      actorKind: "human",
      operationId: "operation_classes",
      sessionId: "session_classes",
      workspaceId: "workspace_main",
    })

    await expect(store.openWorkspace(grantee, { workspaceId: "workspace_main" }))
      .rejects.toMatchObject({ code: "workspace_authorization_denied" })

    await expect(exerciseSessionWriteClassConformance({
      authority: store,
      shares: store,
      workspaceId: "workspace_main",
      sessionId: "session_classes",
      creator: {
        auth: creator,
        runtime: { principalKind: "user", actorId: creator.user.tokenIdentifier, actorKind: "human" },
      },
      grantee: {
        runtime: { principalKind: "user", actorId: grantee.user.tokenIdentifier, actorKind: "human" },
        target: { grantedToTokenIdentifier: grantee.user.tokenIdentifier },
      },
    })).resolves.toEqual({
      sendGranteeDrivesTheTurn: true,
      sendGranteeRefusedSessionControl: true,
      creatorHoldsBothClasses: true,
      absentClassAsksAboutTheTurn: true,
    })
  })
})

describe("SQLite session list pages", () => {
  test("satisfies the provider-neutral session-page conformance runner", async () => {
    const reader = auth("reader")
    const colleague = auth("colleague")
    const stranger = auth("stranger")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(colleague)
    await store.createCloudWorkspace(reader, { workspaceId: "workspace_one", displayName: "One" })
    const projectId = (seed().prepare(`SELECT project_id FROM workspaces WHERE workspace_id = ?`)
      .get("workspace_one") as { project_id: string }).project_id
    await store.createCloudWorkspace(reader, { workspaceId: "workspace_two", displayName: "Two", projectId })
    orgMember(seed, "workspace_one", colleague.user.tokenIdentifier, "admin")
    // A create files into the caller's own organization here, so the
    // colleague's workspace is created in the project and handed to them.
    await store.createCloudWorkspace(reader, { workspaceId: "workspace_colleague", displayName: "Colleague", projectId })
    seed().prepare(`UPDATE workspaces SET owner_token_identifier = ? WHERE workspace_id = ?`)
      .run(colleague.user.tokenIdentifier, "workspace_colleague")
    await store.createCloudWorkspace(stranger, { workspaceId: "workspace_stranger", displayName: "Theirs" })
    const strangerProjectId = (seed().prepare(`SELECT project_id FROM workspaces WHERE workspace_id = ?`)
      .get("workspace_stranger") as { project_id: string }).project_id
    const user = (value: SignedControlPlaneAuth) => ({
      auth: value,
      runtime: { principalKind: "user" as const, actorId: value.user.tokenIdentifier, actorKind: "human" as const },
    })

    let clock = 1_800_000_000_000
    const now = () => ++clock
    const sessions = createSqlitePrivateSessionAuthority({
      database: seed,
      principal: (value) => upsertUser(seed(), {
        token_identifier: value.user.tokenIdentifier,
        subject: value.user.subject,
        issuer: value.user.issuer,
        kind: "human",
      }),
      now,
    })

    const report = await exerciseSessionPageConformance({
      authority: sessions,
      now,
      projectId,
      workspaceIds: ["workspace_one", "workspace_two"],
      reader: user(reader),
      colleague: { ...user(colleague), workspaceId: "workspace_colleague" },
      stranger: { ...user(stranger), projectId: strangerProjectId, workspaceId: "workspace_stranger" },
    })

    expect(report.pages).toBeGreaterThanOrEqual(3)
    expect(report.strangerSees).toEqual([])
    expect(report.readerSeesOfStrangersProject).toEqual([])
  })

  test("fills a page past more refused rows than one scan reads", async () => {
    const owner = auth("owner")
    const reader = auth("reader")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(reader)
    await store.createCloudWorkspace(owner, { workspaceId: "workspace_one", displayName: "One" })
    orgMember(seed, "workspace_one", reader.user.tokenIdentifier, "member")
    const register = async (sessionId: string) => {
      await store.reserveSession(owner, { operationId: `op_${sessionId}`, sessionId, workspaceId: "workspace_one", kind: "create" })
      await store.registerRuntimeSession({
        createdAt: Date.now(),
        updatedAt: Date.now(),
        principalKind: "user",
        actorId: owner.user.tokenIdentifier,
        actorKind: "human",
        operationId: `op_${sessionId}`,
        sessionId,
        workspaceId: "workspace_one",
      })
    }
    for (const index of [1, 2, 3]) {
      await register(`ses_shared_${index}`)
      await store.grantSessionShare!(owner, {
        sessionId: `ses_shared_${index}`,
        workspaceId: "workspace_one",
        grantedToTokenIdentifier: reader.user.tokenIdentifier,
      })
    }
    for (let index = 0; index < 70; index++) await register(`ses_unshared_${String(index).padStart(2, "0")}`)
    seed().prepare(`UPDATE session_history SET created_at = 1 WHERE session_id LIKE 'ses_shared_%'`).run()
    seed().prepare(`UPDATE session_history SET created_at = 2 WHERE session_id LIKE 'ses_unshared_%'`).run()

    const rows = await store.listSessionPage(reader, {
      workspaceId: "workspace_one",
      sort: "human_turn_desc",
      archived: "active",
      limit: 3,
    })

    expect(rows.map((row) => row.session_id)).toEqual(["ses_shared_3", "ses_shared_2", "ses_shared_1"])
  })
})

describe("SQLite latest views", () => {
  test("satisfies the provider-neutral latest-view conformance runner", async () => {
    const creator = auth("creator")
    const { store } = authorityWithSeed()
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })

    await expect(exerciseLatestViewConformance({
      authority: store,
      workspaceId: "workspace_main",
      creator: { auth: creator, runtime: { principalKind: "user", actorId: creator.user.tokenIdentifier, actorKind: "human" } },
    })).resolves.toEqual({ surface: ["u2", "a2"], turn: ["u2", "a2-tool", "a2"], earlier: ["u1", "a1"] })
    await expect(exerciseFirstReadConformance({
      authority: store,
      workspaceId: "workspace_main",
      creator: { auth: creator, runtime: { principalKind: "user", actorId: creator.user.tokenIdentifier, actorKind: "human" } },
    })).resolves.toEqual({ outline: ["u1", "u2"], page: ["u1", "u2"] })
    await expect(exerciseTurnPageConformance({
      authority: store,
      workspaceId: "workspace_main",
      creator: { auth: creator, runtime: { principalKind: "user", actorId: creator.user.tokenIdentifier, actorKind: "human" } },
    })).resolves.toEqual(["u1", "u2"])
    await expect(exerciseSessionPartConformance({
      authority: store,
      workspaceId: "workspace_main",
      creator: { auth: creator, runtime: { principalKind: "user", actorId: creator.user.tokenIdentifier, actorKind: "human" } },
    })).resolves.toBe("a1-p0")
  })
})
