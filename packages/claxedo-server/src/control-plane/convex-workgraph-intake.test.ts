import { describe, expect, test } from "vitest"
import {
  applyWorkGraphIntakeOperation as applyTenantWorkGraphIntakeOperation,
  applyWorkGraphWebhookOperation,
  readWorkGraphIntake as readTenantWorkGraphIntake,
  readWorkGraphWebhook,
} from "../../../../convex/workgraphIntake"

const organizationId = "org_a" as never
const readWorkGraphIntake = (ctx: never, ownerUserId: never, input: unknown) =>
  readTenantWorkGraphIntake(ctx, organizationId, ownerUserId, input)
const applyWorkGraphIntakeOperation = (ctx: never, ownerUserId: never, input: unknown) =>
  applyTenantWorkGraphIntakeOperation(ctx, organizationId, ownerUserId, input)

describe("Convex WorkGraph intake", () => {
  test("projects independent Sessions as complete discriminated candidate DTOs", async () => {
    const harness = new ConvexIntakeHarness({
      workgraph_intake_candidates: [{
        _id: "candidate-row",
        owner_user_id: "owner_a",
        id: "session_intake_session_1",
        workgraph_id: "workgraph_default",
        candidate_kind: "session",
        title: "Independent brainstorm",
        body: "Decisions and remaining work",
        normalized: { sessionId: "session_1", idempotencyKey: "idle-session:session_1" },
        status: "unorganized",
        observed_revision: "100",
        row_version: 1,
        schema_version: 1,
        created_at: 100,
        updated_at: 100,
      }],
    })

    await expect(readWorkGraphIntake(harness as never, "owner_a" as never, { kind: "candidates" })).resolves.toEqual({
      candidates: [{
        candidateKind: "session",
        id: "session_intake_session_1",
        ownerUserId: "owner_a",
        version: 1,
        sessionId: "session_1",
        title: "Independent brainstorm",
        body: "Decisions and remaining work",
        observedRevision: "100",
        state: "unorganized",
        createdAt: 100,
        updatedAt: 100,
      }],
    })
  })

  test("pages recent unorganized external and Session candidates with stable owner-bound cursors", async () => {
    const candidate = (id: string, owner: string, updatedAt: number, input: Record<string, unknown> = {}) => ({
      _id: `${owner}:${id}`,
      owner_user_id: owner,
      id,
      workgraph_id: "workgraph_default",
      candidate_kind: "session",
      title: id,
      body: "",
      normalized: { sessionId: `session-${id}` },
      status: "unorganized",
      row_version: 1,
      schema_version: 1,
      created_at: updatedAt,
      updated_at: updatedAt,
      ...input,
    })
    const harness = new ConvexIntakeHarness({
      workgraph_intake_candidates: [
        candidate("external-50", "owner_a", 50, {
          source_view_id: "view_1",
          candidate_kind: "external_issue",
          normalized: { provider: "github", externalId: "50", externalStatus: "open" },
        }),
        candidate("session-40", "owner_a", 40),
        candidate("session-30-b", "owner_a", 30),
        candidate("session-30-a", "owner_a", 30),
        candidate("dismissed-100", "owner_a", 100, { status: "dismissed" }),
        candidate("bob-200", "owner_b", 200),
      ],
    })

    const first = await readWorkGraphIntake(harness as never, "owner_a" as never, { kind: "candidate_page", limit: 2 }) as any
    expect(first).toMatchObject({
      candidates: [{ id: "external-50", candidateKind: "external_issue" }, { id: "session-40", candidateKind: "session" }],
      hasMore: true,
    })
    const second = await readWorkGraphIntake(harness as never, "owner_a" as never, {
      kind: "candidate_page",
      limit: 2,
      after: first.nextCursor,
    }) as any
    expect(second).toMatchObject({ candidates: [{ id: "session-30-b" }, { id: "session-30-a" }], hasMore: false })
    await expect(readWorkGraphIntake(harness as never, "owner_b" as never, {
      kind: "candidate_page",
      limit: 2,
      after: first.nextCursor,
    })).rejects.toMatchObject({ data: { code: "cursor_invalid", reason: "owner_mismatch" } })
    await expect(readWorkGraphIntake(harness as never, "owner_a" as never, {
      kind: "candidate_page",
      sourceViewId: "view_1",
      limit: 2,
    })).resolves.toMatchObject({ candidates: [{ id: "external-50" }], hasMore: false })
  })

  test("keeps source views and external candidate lifecycle owner- and org-scoped", async () => {
    const harness = configuredHarness()
    const view = {
      id: "view_1",
      ownerUserId: "external-subject",
      teamConnectionId: "connection_1",
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/claxedo", state: "open" },
      syncPolicy: "announce",
      status: "active",
      createdAt: 10,
      updatedAt: 10,
    }
    await applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, { type: "create_source_view", orgId: "org_a", view })
    const candidate = {
      candidateKind: "external_issue",
      id: "candidate_1",
      ownerUserId: "external-subject",
      sourceViewId: "view_1",
      provider: "github",
      externalId: "42",
      externalKey: "#42",
      externalUrl: "https://github.com/claxedo/claxedo/issues/42",
      title: "Ship hosted intake",
      body: "Use Convex",
      externalStatus: "open",
      observedRevision: "rev-1",
      state: "unorganized",
      createdAt: 20,
      updatedAt: 20,
    }
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "upsert_external",
      identityKey: "owner_a:github:connection_1:42",
      candidate,
    })).resolves.toMatchObject({ created: true, candidate: { candidateKind: "external_issue", externalId: "42" } })
    await expect(harness.query("workgraph_changes").collect()).resolves.toEqual([
      expect.objectContaining({
        change_type: "intake_candidate_changed",
        resource_type: "workgraph",
        resource_id: "workgraph_default",
        snapshot_relevant: false,
      }),
    ])
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "upsert_external",
      identityKey: "owner_a:github:connection_1:42",
      candidate: { ...candidate, id: "candidate_retry", title: "Ship hosted intake now", observedRevision: "rev-2", updatedAt: 25 },
    })).resolves.toMatchObject({
      created: false,
      candidate: { id: "candidate_1", title: "Ship hosted intake now", observedRevision: "rev-2" },
    })
    const draft = { title: "Ship hosted intake now", content: "immutable hosted issue evidence" }
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "prepare_stage_candidate", candidateId: "candidate_1", draft, now: 30,
    })).resolves.toMatchObject({ candidate: { candidateKind: "external_issue", state: "unorganized" }, draft })
    const source = { workSourceId: "source_1", revisionId: "revision_1", contentHash: await digest(draft.content) }
    await harness.insert("workgraph_admission_proposals", {
      owner_user_id: "owner_a",
      id: "proposal_1",
      workgraph_id: "workgraph_default",
      state: "proposed",
      source: { work_source_id: source.workSourceId, revision_id: source.revisionId, content_hash: source.contentHash },
      proposal_kind: "source",
      proposed_outcomes: [],
      proposed_work_items: [],
      duplicate_matches: [],
      row_version: 1,
      schema_version: 1,
      created_at: 30,
      updated_at: 30,
    })
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "stage_candidate", candidateId: "candidate_1", source, proposalId: "proposal_1", now: 40,
    })).resolves.toMatchObject({ candidateKind: "external_issue", state: "staged", source, admissionProposalId: "proposal_1" })
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "upsert_external",
      identityKey: "owner_a:github:connection_1:42",
      candidate: { ...candidate, id: "candidate_after_confirm", externalStatus: "closed", observedRevision: "rev-3", updatedAt: 45 },
    })).resolves.toMatchObject({
      created: false,
      candidate: { id: "candidate_1", state: "staged", admissionProposalId: "proposal_1", externalStatus: "open" },
    })

    await expect(readWorkGraphIntake(harness as never, "owner_a" as never, { kind: "candidates", sourceViewId: "view_1" }))
      .resolves.toMatchObject({ candidates: [{ candidateKind: "external_issue", externalId: "42", admissionProposalId: "proposal_1", source }] })
    await expect(readWorkGraphIntake(harness as never, "owner_b" as never, { kind: "candidates" }))
      .resolves.toEqual({ candidates: [] })
  })

  test("resolves Connection metadata only through current org membership and rejects credential-shaped filters", async () => {
    const harness = configuredHarness()
    await expect(readWorkGraphIntake(harness as never, "owner_a" as never, {
      kind: "connection", clerkOrgId: "clerk_org_a", connectionId: "connection_1",
    })).resolves.toMatchObject({ id: "connection_1", ownerUserId: "owner_a", orgId: "org_a", integrationId: "github" })
    await expect(readWorkGraphIntake(harness as never, "owner_b" as never, {
      kind: "connection", clerkOrgId: "clerk_org_a", connectionId: "connection_1",
    })).resolves.toBeNull()

    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "create_source_view",
      orgId: "org_a",
      view: {
        id: "view_secret",
        teamConnectionId: "connection_1",
        provider: "github",
        providerUserId: "octocat",
        filters: { repo: "token=ghp_not_allowed" },
        syncPolicy: "announce",
        createdAt: 10,
        updatedAt: 10,
      },
    })).rejects.toThrow("credential material")
  })

  test("applies Source View and candidate lifecycle mutations with CAS and safe deletion", async () => {
    const harness = configuredHarness()
    const view = {
      id: "view_lifecycle",
      teamConnectionId: "connection_1",
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/cloud" },
      target: {
        environment: { kind: "hosted_workspace", placement: "shared", repositoryUrl: "https://github.com/claxedo/cloud.git" },
        repository: { remoteUrl: "https://github.com/claxedo/cloud.git", baseRevision: "dev" },
      },
      syncPolicy: "announce",
      createdAt: 10,
      updatedAt: 10,
    }
    await applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, { type: "create_source_view", orgId: "org_a", view })
    const update = {
      type: "update_source_view",
      sourceViewId: view.id,
      expectedVersion: 1,
      providerUserId: "octocat-updated",
      filters: { labels: "launch", repo: "claxedo/cloud" },
      syncPolicy: "full",
      status: "paused",
      updatedAt: 20,
    }
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, update)).resolves.toMatchObject({
      ok: true,
      view: { version: 2, providerUserId: "octocat-updated", status: "paused", target: view.target },
    })
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      ...update,
      filters: { repo: "claxedo/cloud", labels: "launch" },
      updatedAt: 21,
    })).resolves.toMatchObject({ ok: true, view: { version: 2 } })
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      ...update,
      providerUserId: "conflict",
    })).resolves.toEqual({ ok: false, reason: "version_conflict" })

    const candidate = {
      candidateKind: "external_issue",
      id: "candidate_lifecycle",
      sourceViewId: view.id,
      provider: "github",
      externalId: "42",
      title: "Ship lifecycle",
      body: "Use Convex",
      externalStatus: "open",
      state: "unorganized",
      createdAt: 30,
      updatedAt: 30,
    }
    await applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "upsert_external",
      identityKey: "owner_a:github:connection_1:42",
      candidate,
    })
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "delete_source_view", sourceViewId: view.id, expectedVersion: 2,
    })).resolves.toEqual({ ok: false, reason: "in_use" })
    const dismiss = {
      type: "transition_candidate",
      candidateId: candidate.id,
      expectedVersion: 1,
      from: "unorganized",
      to: "dismissed",
      updatedAt: 31,
    }
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, dismiss))
      .resolves.toMatchObject({ ok: true, candidate: { version: 2, state: "dismissed" } })
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, dismiss))
      .resolves.toMatchObject({ ok: true, candidate: { version: 2, state: "dismissed" } })
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      ...dismiss,
      expectedVersion: 2,
      from: "dismissed",
      to: "unorganized",
      updatedAt: 32,
    })).resolves.toMatchObject({ ok: true, candidate: { version: 3, state: "unorganized" } })
    await applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      ...dismiss,
      expectedVersion: 3,
      updatedAt: 33,
    })
    await expect(applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
      type: "delete_source_view", sourceViewId: view.id, expectedVersion: 2,
    })).resolves.toMatchObject({ ok: true, view: { id: view.id, version: 2 } })
    await expect(readWorkGraphIntake(harness as never, "owner_a" as never, { kind: "source_view", sourceViewId: view.id })).resolves.toBeNull()
    await expect(readWorkGraphIntake(harness as never, "owner_a" as never, { kind: "candidates", sourceViewId: view.id })).resolves.toEqual({ candidates: [] })
  })

  test("routes hosted webhooks by Connection/provider and deduplicates durably", async () => {
    const harness = configuredHarness()
    await harness.insert("org_memberships", { org_id: "org_a", user_id: "owner_b", role: "member", created_at: 1, updated_at: 1 })
    await Promise.all([
      applyWorkGraphIntakeOperation(harness as never, "owner_a" as never, {
        type: "create_source_view",
        orgId: "org_a",
        view: { id: "view_a", teamConnectionId: "connection_1", provider: "github", providerUserId: "alice", filters: { repo: "claxedo/cloud" }, syncPolicy: "announce", createdAt: 10, updatedAt: 10 },
      }),
      applyWorkGraphIntakeOperation(harness as never, "owner_b" as never, {
        type: "create_source_view",
        orgId: "org_a",
        view: { id: "view_b", teamConnectionId: "connection_1", provider: "github", providerUserId: "bob", filters: { repo: "claxedo/desktop" }, syncPolicy: "announce", createdAt: 11, updatedAt: 11 },
      }),
    ])

    await expect(readWorkGraphWebhook(harness as never, { kind: "source_views", connectionId: "connection_1", provider: "github", limit: 33 }))
      .resolves.toMatchObject({ sourceViews: [
        { id: "view_a", ownerUserId: "alice-subject", providerUserId: "alice", filters: { repo: "claxedo/cloud" } },
        { id: "view_b", ownerUserId: "bob-subject", providerUserId: "bob", filters: { repo: "claxedo/desktop" } },
      ] })
    const operation = { type: "begin_webhook", connectionId: "connection_1", provider: "github", deliveryId: "delivery_1", event: "issues", now: 20 }
    const first = await applyWorkGraphWebhookOperation(harness as never, operation)
    expect(first).toMatchObject({ state: "acquired" })
    if (!first || typeof first !== "object" || !("state" in first) || first.state !== "acquired") {
      throw new Error("Expected acquired webhook")
    }
    const replacement = await applyWorkGraphWebhookOperation(harness as never, { ...operation, now: 60_021 })
    expect(replacement).toMatchObject({ state: "acquired" })
    if (!replacement || typeof replacement !== "object" || !("state" in replacement) || replacement.state !== "acquired") {
      throw new Error("Expected replacement webhook lease")
    }
    await expect(applyWorkGraphWebhookOperation(harness as never, {
      ...operation,
      type: "complete_webhook",
      leaseId: first.leaseId,
      now: 60_022,
    })).resolves.toBe(false)
    await expect(applyWorkGraphWebhookOperation(harness as never, {
      ...operation,
      type: "complete_webhook",
      leaseId: replacement.leaseId,
      now: 60_023,
    })).resolves.toBe(true)
    await expect(applyWorkGraphWebhookOperation(harness as never, { ...operation, now: 60_024 })).resolves.toEqual({ state: "completed" })
  })
})

async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function configuredHarness() {
  return new ConvexIntakeHarness({
    users: [
      { _id: "owner_a", clerk_subject: "alice-subject" },
      { _id: "owner_b", clerk_subject: "bob-subject" },
    ],
    orgs: [{ _id: "org_a", clerk_org_id: "clerk_org_a", owner_user_id: "owner_a", created_at: 1, updated_at: 1 }],
    org_memberships: [{ _id: "membership_a", org_id: "org_a", user_id: "owner_a", role: "owner", created_at: 1, updated_at: 1 }],
    workgraph_connection_metadata: [{
      _id: "connection-row-owner_a",
      owner_user_id: "owner_a",
      org_id: "org_a",
      connection_id: "connection_1",
      integration_id: "github",
      capabilities: ["work-source"],
      status: "connected",
      token_type: "bearer",
      row_version: 1,
      schema_version: 1,
      created_at: 1,
      updated_at: 1,
    }],
  })
}

class ConvexIntakeHarness {
  private readonly tables = new Map<string, Array<Record<string, unknown>>>()
  private next = 0
  readonly db = this

  constructor(seed: Record<string, Array<Record<string, unknown>>>) {
    Object.entries(seed).forEach(([table, rows]) => this.tables.set(table, rows.map((row) => ({
      ...(table.startsWith("workgraph_") || table === "workgraphs" || table.startsWith("work_source")
        ? { organization_id: "org_a" }
        : {}),
      ...row,
    }))))
  }

  query(table: string) {
    let selected = [...(this.tables.get(table) ?? [])]
    let index = ""
    const chain = {
      withIndex: (name: string, build: (query: { eq(field: string, value: unknown): unknown; lt(field: string, value: unknown): unknown }) => unknown) => {
        index = name
        const filters: Array<Readonly<{ field: string; value: unknown; operation: "eq" | "lt" }>> = []
        const query = {
          eq(field: string, value: unknown) {
            filters.push({ field, value, operation: "eq" })
            return query
          },
          lt(field: string, value: unknown) {
            filters.push({ field, value, operation: "lt" })
            return query
          },
        }
        build(query)
        selected = selected.filter((row) => filters.every((filter) => filter.operation === "eq"
          ? row[filter.field] === filter.value
          : typeof row[filter.field] === "number" && typeof filter.value === "number"
            ? Number(row[filter.field]) < filter.value
            : String(row[filter.field]) < String(filter.value)))
        return chain
      },
      order: (direction: "asc" | "desc") => {
        if (index.includes("updated_id")) selected.sort((left, right) => {
          const comparison = Number(left.updated_at) - Number(right.updated_at) || String(left.id).localeCompare(String(right.id))
          return direction === "desc" ? -comparison : comparison
        })
        return chain
      },
      filter: (build: (query: { field(field: string): string; eq(field: string, value: unknown): (row: Record<string, unknown>) => boolean; and(...filters: Array<(row: Record<string, unknown>) => boolean>): (row: Record<string, unknown>) => boolean }) => (row: Record<string, unknown>) => boolean) => {
        const query = {
          field: (field: string) => field,
          eq: (field: string, value: unknown) => (row: Record<string, unknown>) => row[field] === value,
          and: (...filters: Array<(row: Record<string, unknown>) => boolean>) => (row: Record<string, unknown>) => filters.every((filter) => filter(row)),
        }
        selected = selected.filter(build(query))
        return chain
      },
      unique: async () => selected[0] ?? null,
      collect: async () => selected,
      take: async (limit: number) => selected.slice(0, limit),
    }
    return chain
  }

  async insert(table: string, value: Record<string, unknown>) {
    const row = {
      _id: `${table}:${++this.next}`,
      ...(table.startsWith("workgraph_") || table === "workgraphs" || table.startsWith("work_source")
        ? { organization_id: "org_a" }
        : {}),
      ...value,
    }
    this.tables.set(table, [...(this.tables.get(table) ?? []), row])
    return row._id
  }

  async get(id: string) {
    return [...this.tables.values()].flat().find((candidate) => candidate._id === id) ?? null
  }

  async patch(id: string, value: Record<string, unknown>) {
    const row = [...this.tables.values()].flat().find((candidate) => candidate._id === id)
    if (!row) throw new Error(`Missing row ${id}`)
    Object.assign(row, value)
  }

  async delete(id: string) {
    for (const [table, rows] of this.tables) {
      const next = rows.filter((candidate) => candidate._id !== id)
      if (next.length !== rows.length) {
        this.tables.set(table, next)
        return
      }
    }
  }
}
