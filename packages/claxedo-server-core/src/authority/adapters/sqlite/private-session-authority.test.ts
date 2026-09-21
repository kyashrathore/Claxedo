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
import { exerciseSessionTurnAuthorityConformance } from "@claxedo/server-core/platform/auth/session-turn-authority.conformance"
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
    const participant = auth("participant")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(participant)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", participant.user.tokenIdentifier, "member")

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
      participant: {
        auth: participant,
        runtime: {
          principalKind: "user",
          actorId: participant.user.tokenIdentifier,
          actorKind: "human",
        },
      },
    })).resolves.toMatchObject({
      lifecycle: { reserved: true, reconciled: true, compensated: true, released: true },
      access: { deniedBeforeGrant: true, allowedAfterGrant: true, deniedAfterRevoke: true },
      attribution: { canonicalActorPreserved: true, forgedActorRemoved: true },
    })
  })

  test("satisfies the provider-neutral runtime fork-reservation conformance runner", async () => {
    const creator = auth("creator")
    const participant = auth("participant")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(participant)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    orgMember(seed, "workspace_main", participant.user.tokenIdentifier, "member")

    seed().prepare(`INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at)
      SELECT project_id, ?, 'editor', 1, 1 FROM workspaces WHERE workspace_id = 'workspace_main'`)
      .run(participant.user.tokenIdentifier)

    await expect(exerciseRuntimeForkReservationConformance({
      setParentShare: async (sessionId, level) => {
        const target = { sessionId, workspaceId: "workspace_main", grantedToTokenIdentifier: participant.user.tokenIdentifier }
        if (level) await store.grantSessionShare!(creator, { ...target, level })
        else await store.revokeSessionShare!(creator, target)
      },
      authority: store,
      workspaceId: "workspace_main",
      creator: {
        auth: creator,
        runtime: { principalKind: "user", actorId: creator.user.tokenIdentifier, actorKind: "human" },
      },
      participant: {
        auth: participant,
        runtime: { principalKind: "user", actorId: participant.user.tokenIdentifier, actorKind: "human" },
      },
    })).resolves.toEqual({
      forkReservedUnderAWritableParent: true,
      registeredChildIsPrivateToItsCreator: true,
      refusedUnderAnUnreadableParent: true,
      refusedUnderAFollowOnlyParent: true,
      revokedParentRefusesStartupAndRegistration: true,
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
    // An org admin ranks `admin` on the workspace, which is the standing this
    // suite needs its non-owner to have: enough to create a session there,
    // never enough to adopt one the machine holds.
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
            workspace_id, host_id, owner_token_identifier, second_device_open_at, revision, assigned_at, updated_at
          ) VALUES (?, ?, ?, NULL, 1, 1, 1)
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
      refusedWhenHeldByAnotherCreator: true,
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
    // `org_member_visible = 0` withholds the implicit viewer role a plain
    // member would otherwise carry, which is what leaves the grantee with no
    // workspace rank at all and the share as their only standing.
    seed().prepare(`UPDATE workspaces SET org_member_visible = 0 WHERE workspace_id = ?`).run("workspace_main")
    orgMember(seed, "workspace_main", grantee.user.tokenIdentifier, "member")
    orgMember(seed, "workspace_main", administrator.user.tokenIdentifier, "admin")
    await store.reserveSession(creator, {
      operationId: "operation_shared",
      sessionId: "session_shared",
      workspaceId: "workspace_main",
      kind: "create",
    })
    await store.registerRuntimeSession({
      principalKind: "user",
      actorId: creator.user.tokenIdentifier,
      actorKind: "human",
      operationId: "operation_shared",
      sessionId: "session_shared",
      workspaceId: "workspace_main",
    })

    await expect(exerciseSessionShareLevelConformance({
      authority: store,
      shares: store,
      workspaceId: "workspace_main",
      sessionId: "session_shared",
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
      organizationAdministratorRefusedWithoutAGrant: true,
      offerRefusedOutsideTheOrganization: true,
    })
    await expect(store.openWorkspace(grantee, { workspaceId: "workspace_main" }))
      .rejects.toMatchObject({ code: "workspace_authorization_denied" })
  })

  test("satisfies the provider-neutral session-share runtime-token conformance surface", async () => {
    const creator = auth("creator")
    const grantee = auth("grantee")
    const departing = auth("departing")
    const { store, seed } = authorityWithSeed()
    await store.usersMe(grantee)
    await store.usersMe(departing)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    // `org_member_visible = 0` withholds the implicit member rank, so the
    // grantee's only standing on this workspace is the share under test. An
    // org ADMIN keeps their rank either way, which is what lets the departing
    // member create a session and what revoking the membership takes back.
    seed().prepare(`UPDATE workspaces SET org_member_visible = 0 WHERE workspace_id = ?`).run("workspace_main")
    orgMember(seed, "workspace_main", grantee.user.tokenIdentifier, "member")
    orgMember(seed, "workspace_main", departing.user.tokenIdentifier, "admin")
    for (const [operationId, sessionId, owner] of [
      ["operation_shared", "session_shared", creator],
      ["operation_departing", "session_departing", departing],
    ] as const) {
      await store.reserveSession(owner, { operationId, sessionId, workspaceId: "workspace_main", kind: "create" })
      await store.registerRuntimeSession({
        principalKind: "user",
        actorId: owner.user.tokenIdentifier,
        actorKind: "human",
        operationId,
        sessionId,
        workspaceId: "workspace_main",
      })
    }

    await expect(exerciseSessionShareRuntimeTokenConformance({
      sessions: store,
      workspace: store,
      workspaceId: "workspace_main",
      hostId: "host_main",
      sessionId: "session_shared",
      creator: { auth: creator },
      grantee: {
        auth: grantee,
        runtime: { principalKind: "user", actorId: grantee.user.tokenIdentifier, actorKind: "human" },
        target: { grantedToTokenIdentifier: grantee.user.tokenIdentifier },
      },
      offboarded: {
        auth: departing,
        runtime: { principalKind: "user", actorId: departing.user.tokenIdentifier, actorKind: "human" },
        sessionId: "session_departing",
        leaveOrganization: async () => {
          const workspace = seed().prepare(`SELECT org_id FROM workspaces WHERE workspace_id = ?`)
            .get("workspace_main") as { org_id: string }
          seed().prepare(`DELETE FROM org_memberships WHERE org_id = ? AND token_identifier = ?`)
            .run(workspace.org_id, departing.user.tokenIdentifier)
        },
      },
      expiresAt: Date.now() + 600_000,
    })).resolves.toEqual({
      tokenRefusedBeforeTheShare: true,
      sendGranteeMintsAViewerTokenAndWrites: true,
      shareNeverWidensTheTokenRole: true,
      followGranteeKeepsTheTokenAndLosesTheTurn: true,
      offboardedCreatorLosesReadWriteAndToken: true,
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
      principalKind: "user",
      actorId: creator.user.tokenIdentifier,
      actorKind: "human",
      operationId: "operation_turns",
      sessionId: "session_turns",
      workspaceId: "workspace_main",
    })
    orgMember(seed, "workspace_main", participant.user.tokenIdentifier, "member")
    await first.grantSessionParticipant(creator, {
      sessionId: "session_turns",
      workspaceId: "workspace_main",
      participantActorId: participant.user.tokenIdentifier,
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
      await store.registerRuntimeSession({ ...runtime, operationId: "operation_1" })

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
    // Withholding the implicit member rank leaves the teammate standing in
    // the organization and nowhere else, which is what the two twins have to
    // answer the same way.
    seed().prepare(`UPDATE workspaces SET org_member_visible = 0 WHERE workspace_id = ?`).run("workspace_main")
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
    // `org_member_visible = 0` withholds the implicit viewer role a plain
    // member would otherwise carry, so the share is the grantee's only
    // standing and the class alone decides each write.
    seed().prepare(`UPDATE workspaces SET org_member_visible = 0 WHERE workspace_id = ?`).run("workspace_main")
    orgMember(seed, "workspace_main", grantee.user.tokenIdentifier, "member")
    await store.reserveSession(creator, {
      operationId: "operation_classes",
      sessionId: "session_classes",
      workspaceId: "workspace_main",
      kind: "create",
    })
    await store.registerRuntimeSession({
      principalKind: "user",
      actorId: creator.user.tokenIdentifier,
      actorKind: "human",
      operationId: "operation_classes",
      sessionId: "session_classes",
      workspaceId: "workspace_main",
    })

    // Before the share exists there is nothing to admit them: what follows is
    // the share's alone, never a rank on the workspace.
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
