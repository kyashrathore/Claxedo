import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteIntakeStores } from "../src/adapters/sqlite/intake-store"
import { createSqliteSessionIntakePort } from "../src/adapters/sqlite/session-intake"
import { hashWorkSourceContent } from "../src/application/work-source-service"
import { ActorIDSchema, ConnectionIDSchema, IntakeCandidatePageCursorError, OwnerUserIDSchema, RequestIDSchema, type WorkGraphContext } from "../src/contracts"
import type { ExternalIntakeCandidate } from "../src/application/intake-service"
import type { SourceView } from "../src/application/source-view-service"

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite personal intake stores", () => {
  it("advances the live change feed when intake Attention changes", async () => {
    const database = open()
    const stores = createSqliteIntakeStores(database)
    const alice = context("alice")
    await stores.sourceViews.create(alice, view("alice"))

    await stores.candidates.upsertExternal(alice, {
      candidate: issue("alice", "candidate-a", "New issue"),
      identityKey: "alice:github:team:42",
    })
    await stores.candidates.transition(alice, "candidate-a", {
      expectedVersion: 1,
      from: "unorganized",
      to: "dismissed",
      updatedAt: 2,
    })
    await createSqliteSessionIntakePort(database).createUnorganized(alice, {
      sessionId: "session-42",
      title: "Independent discovery",
      body: "Found follow-up work",
      idempotencyKey: "session-42:discovery-1",
      observedAt: 3,
    })

    expect(database.prepare(`
      SELECT change_type, resource_type, resource_id, snapshot_relevant
      FROM wg_v2_changes
      WHERE organization_id = ? AND owner_user_id = ?
      ORDER BY cursor
    `).all(alice.organizationId, alice.ownerUserId)).toEqual([
      { change_type: "intake_candidate_changed", resource_type: "workgraph", resource_id: "workgraph_default", snapshot_relevant: 0 },
      { change_type: "intake_candidate_changed", resource_type: "workgraph", resource_id: "workgraph_default", snapshot_relevant: 0 },
      { change_type: "intake_candidate_changed", resource_type: "workgraph", resource_id: "workgraph_default", snapshot_relevant: 0 },
    ])
  })

  it("keeps source views and external identities owner-scoped and idempotent", async () => {
    const database = open()
    const stores = createSqliteIntakeStores(database)
    const alice = context("alice")
    const bob = context("bob")
    await stores.sourceViews.create(alice, view("alice"))
    await stores.sourceViews.create(bob, view("bob"))

    const first = await stores.candidates.upsertExternal(alice, {
      candidate: issue("alice", "candidate-a", "Initial title"),
      identityKey: "alice:github:team:42",
    })
    const updated = await stores.candidates.upsertExternal(alice, {
      candidate: issue("alice", "discarded-new-id", "Updated title"),
      identityKey: "alice:github:team:42",
    })
    const separateOwner = await stores.candidates.upsertExternal(bob, {
      candidate: issue("bob", "candidate-b", "Bob title"),
      identityKey: "bob:github:team:42",
    })

    expect(first.created).toBe(true)
    expect(updated).toMatchObject({ created: false, candidate: { id: "candidate-a", title: "Updated title" } })
    expect(separateOwner).toMatchObject({ created: true, candidate: { id: "candidate-b" } })
    expect(await stores.candidates.list(alice)).toHaveLength(1)
    expect(await stores.candidates.list(bob)).toHaveLength(1)
    expect(await stores.candidates.read(bob, "candidate-a")).toBeUndefined()
  })

  it("persists exact source/proposal staging and owner-scoped sync claims without credential material", async () => {
    const database = open()
    const stores = createSqliteIntakeStores(database)
    const alice = context("alice")
    await stores.sourceViews.create(alice, view("alice"))
    await stores.candidates.upsertExternal(alice, {
      candidate: issue("alice", "candidate-a", "Ship"),
      identityKey: "alice:github:team:42",
    })
    const prepared = await stores.candidates.prepareStage(alice, "candidate-a", { title: "Ship", content: "immutable issue evidence" })
    const source = { workSourceId: "source-1", revisionId: "revision-1", contentHash: hashWorkSourceContent(prepared.draft.content) } as const
    database.prepare(`INSERT INTO wg_v2_work_sources (organization_id, owner_user_id, id, workgraph_id, title, latest_revision_number, created_at, updated_at) VALUES (?, ?, ?, 'workgraph_default', ?, 1, 1, 1)`).run(alice.organizationId, alice.ownerUserId, source.workSourceId, "Ship")
    database.prepare(`INSERT INTO wg_v2_work_source_revisions (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1)`).run(alice.organizationId, alice.ownerUserId, source.revisionId, source.workSourceId, prepared.draft.content, source.contentHash)
    database.prepare(`INSERT INTO wg_v2_admission_proposals (organization_id, owner_user_id, id, workgraph_id, source_revision_id, proposal_kind, lifecycle, proposed_work_json, created_at, updated_at) VALUES (?, ?, 'proposal-1', 'workgraph_default', ?, 'source', 'proposed', '{}', 1, 1)`).run(alice.organizationId, alice.ownerUserId, source.revisionId)
    expect(await stores.candidates.stage(alice, "candidate-a", { source: source as never, proposalId: "proposal-1" as never })).toMatchObject({
      state: "staged",
      admissionProposalId: "proposal-1",
      source,
    })

    const acquired = await stores.receipts.begin(alice, { key: "sync-key", candidateId: "candidate-a", effect: "announce" })
    expect(acquired.state).toBe("acquired")
    expect((await stores.receipts.begin(alice, { key: "sync-key", candidateId: "candidate-a", effect: "announce" })).state).toBe("busy")
    if (acquired.state === "acquired") await stores.receipts.complete(alice, { key: "sync-key", leaseId: acquired.leaseId })
    expect((await stores.receipts.begin(alice, { key: "sync-key", candidateId: "candidate-a", effect: "announce" })).state).toBe("completed")
    expect((await stores.receipts.begin(context("bob"), { key: "sync-key", candidateId: "candidate-b", effect: "announce" })).state).toBe("acquired")

    const persisted = database.prepare(`
      SELECT filters_json AS value FROM wg_v2_source_views
      UNION ALL SELECT normalized_json FROM wg_v2_intake_candidates
      UNION ALL SELECT metadata_json FROM wg_v2_external_identities
      UNION ALL SELECT payload_json FROM wg_v2_outbox
    `).all().map((row) => (row as { value: string }).value).join("\n")
    expect(persisted).not.toContain("token")
    expect(persisted).not.toContain("secret")
    expect(persisted).not.toContain("authorization")
  })

  it("rejects staging a second candidate with an already-bound proposal without mutating it", async () => {
    const database = open()
    const stores = createSqliteIntakeStores(database)
    const alice = context("alice")
    await stores.sourceViews.create(alice, view("alice"))
    await stores.candidates.upsertExternal(alice, {
      candidate: issue("alice", "candidate-a", "Ship"),
      identityKey: "alice:github:team:42",
    })
    await stores.candidates.upsertExternal(alice, {
      candidate: { ...issue("alice", "candidate-b", "Ship"), externalId: "43", externalKey: "#43" },
      identityKey: "alice:github:team:43",
    })
    const draft = { title: "Ship", content: "immutable issue evidence" }
    const prepared = await stores.candidates.prepareStage(alice, "candidate-a", draft)
    await stores.candidates.prepareStage(alice, "candidate-b", draft)
    const source = { workSourceId: "source-1", revisionId: "revision-1", contentHash: hashWorkSourceContent(prepared.draft.content) } as const
    database.prepare(`INSERT INTO wg_v2_work_sources (organization_id, owner_user_id, id, workgraph_id, title, latest_revision_number, created_at, updated_at) VALUES (?, ?, ?, 'workgraph_default', ?, 1, 1, 1)`).run(alice.organizationId, alice.ownerUserId, source.workSourceId, "Ship")
    database.prepare(`INSERT INTO wg_v2_work_source_revisions (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1)`).run(alice.organizationId, alice.ownerUserId, source.revisionId, source.workSourceId, prepared.draft.content, source.contentHash)
    database.prepare(`INSERT INTO wg_v2_admission_proposals (organization_id, owner_user_id, id, workgraph_id, source_revision_id, proposal_kind, lifecycle, proposed_work_json, created_at, updated_at) VALUES (?, ?, 'proposal-1', 'workgraph_default', ?, 'source', 'proposed', '{}', 1, 1)`).run(alice.organizationId, alice.ownerUserId, source.revisionId)
    await stores.candidates.stage(alice, "candidate-a", { source: source as never, proposalId: "proposal-1" as never })
    const before = database.prepare(`SELECT status, normalized_json, row_version FROM wg_v2_intake_candidates WHERE owner_user_id = ? AND id = 'candidate-b'`).get(alice.ownerUserId)

    await expect(stores.candidates.stage(alice, "candidate-b", { source: source as never, proposalId: "proposal-1" as never }))
      .rejects.toThrow("Admission proposal is already bound to another candidate")

    expect(database.prepare(`SELECT status, normalized_json, row_version FROM wg_v2_intake_candidates WHERE owner_user_id = ? AND id = 'candidate-b'`).get(alice.ownerUserId)).toEqual(before)
    expect(database.prepare(`SELECT intake_candidate_id FROM wg_v2_admission_proposals WHERE owner_user_id = ? AND id = 'proposal-1'`).get(alice.ownerUserId))
      .toEqual({ intake_candidate_id: "candidate-a" })
  })

  it("rejects credential-shaped Source View filters before SQLite persistence", async () => {
    const database = open()
    const stores = createSqliteIntakeStores(database)
    await expect(stores.sourceViews.create(context("alice"), {
      ...view("alice"),
      filters: { repo: "Bearer team-credential" },
    })).rejects.toThrow("cannot contain credential material")
    await expect(stores.sourceViews.create(context("alice"), {
      ...view("alice"),
      filters: { credentials: "team-credential" },
    })).rejects.toThrow("cannot contain credential material")
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_source_views").get()).toEqual({ count: 0 })
  })

  it("fences Source View and candidate lifecycle mutations and deletes only dismissed discovery state", async () => {
    const database = open()
    const stores = createSqliteIntakeStores(database)
    const alice = context("alice")
    await stores.sourceViews.create(alice, view("alice"))

    const updated = await stores.sourceViews.update(alice, "view", {
      expectedVersion: 1,
      providerUserId: "alice-updated",
      filters: { labels: "launch", repo: "acme/alice" },
      syncPolicy: "full",
      status: "paused",
      updatedAt: 2,
    })
    expect(updated).toMatchObject({ ok: true, view: { version: 2, providerUserId: "alice-updated", status: "paused" } })
    expect(updated).toMatchObject({ ok: true, view: { target: { environment: { repositoryUrl: "https://github.com/acme/alice.git" }, repository: { baseRevision: "dev" } } } })
    expect(await stores.sourceViews.update(alice, "view", {
      expectedVersion: 1,
      providerUserId: "alice-updated",
      filters: { repo: "acme/alice", labels: "launch" },
      syncPolicy: "full",
      status: "paused",
      updatedAt: 3,
    })).toEqual(updated)
    expect(await stores.sourceViews.update(alice, "view", {
      expectedVersion: 1,
      providerUserId: "different",
      filters: { repo: "acme/alice" },
      syncPolicy: "full",
      status: "paused",
      updatedAt: 3,
    })).toEqual({ ok: false, reason: "version_conflict" })

    await stores.candidates.upsertExternal(alice, {
      candidate: { ...issue("alice", "candidate-a", "Ship"), sourceViewId: "view" },
      identityKey: "alice:github:team:42",
    })
    expect(await stores.sourceViews.delete(alice, "view", { expectedVersion: 2 })).toEqual({ ok: false, reason: "in_use" })
    expect(await stores.candidates.transition(alice, "candidate-a", {
      expectedVersion: 1,
      from: "unorganized",
      to: "dismissed",
      updatedAt: 4,
    })).toMatchObject({ ok: true, candidate: { version: 2, state: "dismissed" } })
    expect(await stores.candidates.transition(alice, "candidate-a", {
      expectedVersion: 1,
      from: "unorganized",
      to: "dismissed",
      updatedAt: 5,
    })).toMatchObject({ ok: true, candidate: { version: 2, state: "dismissed" } })
    expect(await stores.candidates.transition(alice, "candidate-a", {
      expectedVersion: 1,
      from: "dismissed",
      to: "unorganized",
      updatedAt: 5,
    })).toEqual({ ok: false, reason: "version_conflict" })

    expect(await stores.sourceViews.delete(alice, "view", { expectedVersion: 2 })).toMatchObject({ ok: true, view: { id: "view", version: 2 } })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_source_views").get()).toEqual({ count: 0 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_intake_candidates").get()).toEqual({ count: 0 })
    expect(database.prepare("SELECT COUNT(*) AS count FROM wg_v2_external_identities").get()).toEqual({ count: 0 })
  })

  it("lists independent Session candidates with their Session provenance", async () => {
    const database = open()
    const alice = context("alice")
    await createSqliteSessionIntakePort(database).createUnorganized(alice, {
      sessionId: "session-42",
      title: "Investigate launch failure",
      body: "The agent found a missing deployment prerequisite.",
      idempotencyKey: "session-42:discovery-1",
      observedAt: 42,
    })

    expect(await createSqliteIntakeStores(database).candidates.list(alice)).toEqual([
      expect.objectContaining({
        candidateKind: "session",
        sessionId: "session-42",
        title: "Investigate launch failure",
        state: "unorganized",
      }),
    ])
  })

  it("pages only recent unorganized external and Session candidates with owner-bound stable cursors", async () => {
    const database = open()
    const alice = context("alice")
    const bob = context("bob")
    const stores = createSqliteIntakeStores(database)
    await stores.sourceViews.create(alice, view("alice"))
    await stores.sourceViews.create(bob, view("bob"))
    await stores.candidates.upsertExternal(alice, {
      candidate: { ...issue("alice", "external-50", "External"), externalId: "50", updatedAt: 50 },
      identityKey: "alice:github:team:50",
    })
    const sessions = createSqliteSessionIntakePort(database)
    await sessions.createUnorganized(alice, { sessionId: "session-40", title: "Session 40", body: "", idempotencyKey: "40", observedAt: 40 })
    await sessions.createUnorganized(alice, { sessionId: "session-30-a", title: "Session 30 A", body: "", idempotencyKey: "30-a", observedAt: 30 })
    await sessions.createUnorganized(alice, { sessionId: "session-30-b", title: "Session 30 B", body: "", idempotencyKey: "30-b", observedAt: 30 })
    await sessions.createUnorganized(alice, { sessionId: "session-dismissed", title: "Dismissed", body: "", idempotencyKey: "dismissed", observedAt: 60 })
    await sessions.createUnorganized(bob, { sessionId: "session-bob", title: "Bob", body: "", idempotencyKey: "bob", observedAt: 100 })
    const dismissed = (await stores.candidates.list(alice)).find((candidate) => candidate.candidateKind === "session" && candidate.sessionId === "session-dismissed")!
    await stores.candidates.transition(alice, dismissed.id, {
      expectedVersion: dismissed.version,
      from: "unorganized",
      to: "dismissed",
      updatedAt: 200,
    })

    const first = await stores.candidates.page(alice, { limit: 2 })
    expect(first).toMatchObject({
      candidates: [{ id: "external-50", candidateKind: "external_issue" }, { candidateKind: "session", sessionId: "session-40" }],
      hasMore: true,
    })
    const second = await stores.candidates.page(alice, { limit: 2, after: first.nextCursor })
    expect(second.candidates.map((candidate) => candidate.id)).toEqual([...second.candidates.map((candidate) => candidate.id)].sort().reverse())
    expect(second.candidates.map((candidate) => candidate.candidateKind === "session" && candidate.sessionId).sort()).toEqual(["session-30-a", "session-30-b"])
    expect(second.hasMore).toBe(false)
    await expect(stores.candidates.page(bob, { limit: 2, after: first.nextCursor }))
      .rejects.toBeInstanceOf(IntakeCandidatePageCursorError)
    await expect(stores.candidates.page(alice, { sourceViewId: "view", limit: 2, after: first.nextCursor }))
      .rejects.toMatchObject({ reason: "source_view_mismatch" })
    await expect(stores.candidates.page(alice, { sourceViewId: "view", limit: 2 })).resolves.toMatchObject({
      candidates: [{ id: "external-50" }],
      hasMore: false,
    })
  })
})

function open() {
  const database = new Database(":memory:")
  databases.push(database)
  return database
}

function context(owner: string): WorkGraphContext {
  return {
    organizationId: "organization" as never,
    ownerUserId: OwnerUserIDSchema.parse(owner),
    actor: { type: "user", id: ActorIDSchema.parse(owner) },
    requestId: RequestIDSchema.parse(`request-${owner}`),
    access: { mode: "owner" },
  }
}

function view(owner: string): SourceView {
  return {
    id: "view",
    ownerUserId: owner,
    version: 1,
    teamConnectionId: ConnectionIDSchema.parse("team"),
    provider: "github",
    providerUserId: `${owner}-gh`,
    filters: { repo: `acme/${owner}` },
    target: {
      environment: { kind: "hosted_workspace", placement: "shared", repositoryUrl: `https://github.com/acme/${owner}.git` },
      repository: { remoteUrl: `https://github.com/acme/${owner}.git`, baseRevision: "dev" },
    },
    syncPolicy: "announce",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  }
}

function issue(owner: string, id: string, title: string): ExternalIntakeCandidate {
  return {
    candidateKind: "external_issue",
    id,
    ownerUserId: owner,
    version: 1,
    sourceViewId: "view",
    provider: "github",
    externalId: "42",
    externalKey: "#42",
    externalUrl: "https://github.test/acme/repo/issues/42",
    title,
    body: "Launch details",
    externalStatus: "open",
    observedRevision: "revision-1",
    state: "unorganized",
    createdAt: 1,
    updatedAt: 2,
  }
}
