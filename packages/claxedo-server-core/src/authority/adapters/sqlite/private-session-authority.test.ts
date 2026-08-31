import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { exercisePrivateSessionAuthorityConformance } from "@claxedo/server-core/platform/auth/private-session-authority.conformance"
import { exerciseSessionTurnAuthorityConformance } from "@claxedo/server-core/platform/auth/session-turn-authority.conformance"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"

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

describe("SQLite private-session authority", () => {
  test("satisfies the provider-neutral conformance runner", async () => {
    const creator = auth("creator")
    const participant = auth("participant")
    const store = authority()
    await store.usersMe(participant)
    await store.createCloudWorkspace(creator, { workspaceId: "workspace_main", displayName: "Main" })
    await store.grantWorkspaceShare(creator, {
      workspaceId: "workspace_main",
      role: "editor",
      target: { kind: "actor", actorId: participant.user.tokenIdentifier },
    })

    await expect(exercisePrivateSessionAuthorityConformance({
      authority: store,
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
      lifecycle: { reserved: true, reconciled: true, compensated: true },
      access: { deniedBeforeGrant: true, allowedAfterGrant: true, deniedAfterRevoke: true },
      attribution: { canonicalActorPreserved: true, forgedActorRemoved: true },
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
    openAuthorities.push(first, reconstructed)
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
    await first.grantWorkspaceShare(creator, {
      workspaceId: "workspace_main",
      role: "editor",
      target: { kind: "actor", actorId: participant.user.tokenIdentifier },
    })
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
