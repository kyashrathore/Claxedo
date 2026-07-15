import { describe, expect, test } from "bun:test"
import {
  __resetFetchThrottleForTests,
  __setFetchThrottleForTests,
  throttledFetch,
} from "@/lib/fetch-throttle"
import { WorkGraphApiError, createWorkGraphClient, decodeWorkGraphSnapshot } from "./api"

const actor = { type: "user" as const, id: "user_1" }
const provenance = { actor }
const stream = {
  recordType: "stream" as const,
  schemaVersion: 1 as const,
  ownerUserId: "user_1",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  provenance,
  id: "stream_1",
  title: "Ship Claxedo cloud",
  lifecycleState: "active" as const,
  visibility: "visible" as const,
  pinned: false,
  executionDefaults: {},
  recapDefaults: {},
  activity: { lastActivityAt: 1, recapDueAt: 2 },
  durableEffectCount: 0,
  sourceRevisionRefs: [],
}

const executionCapabilities = {
  schemaVersion: 1,
  organizationId: "org_1",
  ownerUserId: "user_1",
  catalogRevision: "b".repeat(64),
  observedAt: 1,
  expiresAt: 300_001,
  environments: [{
    kind: "hosted_workspace",
    repositoryRequired: false,
    remoteUrlInput: false,
    baseRevisionInput: false,
  }],
  harnesses: [{ id: "codex" }],
  agents: [{ harnessId: "codex", id: "developer", label: "Developer" }],
  models: [],
  tools: [{ harnessId: "codex", id: "read" }],
  repository: { baseRevisions: [] },
  connections: [],
}

describe("WorkGraph API", () => {
  test("strictly decodes canonical snapshot records", () => {
    const result = decodeWorkGraphSnapshot({
      snapshotCursor: "cursor_1",
      records: [stream],
      references: [{ sequence: 1, resource: { type: "stream", id: "stream_1" }, version: 1 }],
      hasMore: false,
      capturedAt: 2,
    })
    expect(result.records[0]).toMatchObject({ recordType: "stream", id: "stream_1" })
    expect(() => decodeWorkGraphSnapshot({ ...result, surprise: true })).toThrow()
  })

  test("creates a stream through commands and reloads the snapshot", async () => {
    const calls: Array<{ path: string; method: string }> = []
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
      calls.push({ path: url.pathname, method: init?.method ?? "GET" })
      if (url.pathname.endsWith("/commands")) {
        return Response.json({ ok: true, operationId: "op_1", cursor: "cursor_2", value: { streamId: "stream_1" } })
      }
      return Response.json(snapshotPage([stream], "cursor_2", 2))
    }
    const client = createWorkGraphClient({ baseUrl: "http://127.0.0.1:3001", request })
    const result = await client.createStream({ title: "Ship Claxedo cloud" })
    const snapshot = await client.snapshot()
    expect(result.ok).toBe(true)
    expect(snapshot.records).toHaveLength(1)
    expect(calls).toEqual([
      { path: "/api/workgraph/commands", method: "POST" },
      { path: "/api/workgraph/snapshot", method: "GET" },
    ])
  })

  test("invalid cursor becomes an explicit reset signal", async () => {
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => Response.json({ error: { code: "cursor_invalid", message: "Snapshot required", retryable: false } }, { status: 409 }),
    })
    await expect(client.changes("old_cursor")).rejects.toMatchObject({
      kind: "cursor_invalid",
      code: "cursor_invalid",
      retryable: false,
      status: 409,
    })
  })

  test("long-polling changes never starves an ordinary WorkGraph read", async () => {
    __setFetchThrottleForTests(4)
    const releasePolls: Array<() => void> = []
    let snapshotStarted = false
    const client = createWorkGraphClient({
      baseUrl: "https://control.test",
      request: (input, init) => throttledFetch(async () => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        if (url.pathname.endsWith("/changes")) {
          return await new Promise<Response>((resolve) => {
            releasePolls.push(() => resolve(Response.json({ changes: [], timedOut: true })))
          })
        }
        snapshotStarted = true
        return Response.json(snapshotPage([], "cursor_1", 1))
      }, init, input),
    })

    const polls = Array.from({ length: 4 }, () => client.changes(undefined, { waitMs: 25_000 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const snapshot = client.snapshot()
    await new Promise((resolve) => setTimeout(resolve, 0))

    try {
      expect(releasePolls).toHaveLength(4)
      expect(snapshotStarted).toBe(true)
    } finally {
      releasePolls.forEach((release) => release())
      __resetFetchThrottleForTests()
    }
    await Promise.all([...polls, snapshot])
  })

  test("reads the bounded Attention projection without loading a snapshot", async () => {
    const paths: string[] = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        paths.push(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname + new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).search)
        return Response.json({
          items: [
            {
              kind: "configuration_required",
              ownerUserId: "owner_1",
              id: "recap_job_1",
              updatedAt: 6,
              requirement: {
                type: "generation",
                jobId: "recap_job_1",
                purpose: "recap",
                scope: { type: "stream", streamId: "stream_1" },
                reason: "Recap requires explicit valid model configuration",
              },
            },
            {
              kind: "unorganized_ai_work",
              ownerUserId: "owner_1",
              id: "unorganized_ai_work",
              updatedAt: 5,
              counts: { externalIssues: 2, sessions: 1, total: 3 },
            },
          ],
          total: 2,
          hasMore: false,
        })
      },
    })

    await expect(client.attention(undefined, 25)).resolves.toMatchObject({
      total: 2,
      items: [{ kind: "configuration_required", requirement: { type: "generation", purpose: "recap" } }, { kind: "unorganized_ai_work" }],
    })
    expect(paths).toEqual(["/api/workgraph/attention?limit=25"])
  })

  test("surfaces an Attention cursor rejection without a snapshot fallback", async () => {
    const paths: string[] = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        paths.push(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname)
        return Response.json({ error: { code: "cursor_invalid", message: "Attention cursor is no longer valid", retryable: false } }, { status: 409 })
      },
    })

    await expect(client.attention("wgat1:owner:1:decision:decision_1" as never)).rejects.toMatchObject({
      kind: "cursor_invalid",
      code: "cursor_invalid",
      retryable: false,
      status: 409,
    })
    expect(paths).toEqual(["/api/workgraph/attention"])
  })

  test("persists Attention read and clear acknowledgements through backend routes", async () => {
    const calls: Array<{ path: string; method: string }> = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        calls.push({ path: url.pathname, method: init?.method ?? "GET" })
        return Response.json({ ownerUserId: "owner_1", readAt: 10, ...(url.pathname.endsWith("/clear") ? { clearedAt: 10 } : {}) })
      },
    })

    await expect(client.markAllAttentionRead()).resolves.toEqual({ ownerUserId: "owner_1", readAt: 10 })
    await expect(client.clearAttention()).resolves.toEqual({ ownerUserId: "owner_1", readAt: 10, clearedAt: 10 })
    expect(calls).toEqual([
      { path: "/api/workgraph/attention/read", method: "POST" },
      { path: "/api/workgraph/attention/clear", method: "POST" },
    ])
  })

  test("reads a bounded Candidate page with explicit paging and Source View scope", async () => {
    const paths: string[] = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        paths.push(`${url.pathname}${url.search}`)
        return Response.json({ candidates: [], hasMore: false })
      },
    })

    await expect(client.intakeCandidates({
      sourceViewId: "view/one",
      limit: 25,
      after: "wgic1:owner:view%2Fone:42:candidate" as never,
    })).resolves.toEqual({ candidates: [], hasMore: false })
    expect(paths).toEqual(["/api/workgraph/intake?limit=25&sourceViewId=view%2Fone&after=wgic1%3Aowner%3Aview%252Fone%3A42%3Acandidate"])
  })

  test("surfaces an invalid Candidate cursor without an unbounded retry", async () => {
    const paths: string[] = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        paths.push(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname)
        return Response.json({ error: { code: "cursor_invalid", message: "Restart Candidate paging", retryable: false } }, { status: 409 })
      },
    })

    await expect(client.intakeCandidates({ after: "wgic1:owner:*:42:candidate" as never }))
      .rejects.toMatchObject({ kind: "cursor_invalid", status: 409 })
    expect(paths).toEqual(["/api/workgraph/intake"])
  })

  test("aggregates more than one hundred records from one stable snapshot", async () => {
    const pages = [
      snapshotPage(streams(0, 100), "change_101", 5, "resume_100"),
      snapshotPage(streams(100, 1), "change_101", 5, undefined, 101),
    ]
    const calls: string[] = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        calls.push(url.search)
        return Response.json(pages.shift())
      },
    })

    const snapshot = await client.snapshot()
    expect(snapshot.records).toHaveLength(101)
    expect(snapshot.references.map((reference) => reference.sequence)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
    expect(calls).toEqual(["?limit=100", "?limit=100&after=resume_100"])
  })

  test("restarts one invalidated snapshot once and returns only the fresh pages", async () => {
    const stale = snapshotPage(streams(0, 100), "change_stale", 5, "stale_resume")
    const fresh = snapshotPage(streams(100, 100), "change_fresh", 6, "fresh_resume")
    const final = snapshotPage(streams(200, 1), "change_fresh", 6, undefined, 101)
    let call = 0
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => {
        call++
        if (call === 1) return Response.json(stale)
        if (call === 2) return Response.json({ error: { code: "cursor_invalid", message: "Restart", retryable: false } }, { status: 409 })
        if (call === 3) return Response.json(fresh)
        return Response.json(final)
      },
    })

    const snapshot = await client.snapshot()
    expect(call).toBe(4)
    expect(snapshot.snapshotCursor).toBe("change_fresh")
    expect(snapshot.records[0]?.id).toBe("stream_101")
    expect(snapshot.records).toHaveLength(101)
  })

  test("surfaces permanent snapshot invalidation after exactly one restart", async () => {
    let call = 0
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => {
        call++
        if (call % 2 === 1) return Response.json(snapshotPage(streams(0, 100), `change_${call}`, call, `resume_${call}`))
        return Response.json({ error: { code: "cursor_invalid", message: "Restart", retryable: false } }, { status: 409 })
      },
    })

    await expect(client.snapshot()).rejects.toMatchObject({ kind: "cursor_invalid", status: 409 })
    expect(call).toBe(4)
  })

  test("reads versioned WorkGraph defaults and sends the exact CAS update", async () => {
    const calls: Array<{ path: string; body?: unknown }> = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      operationId: () => "operation_defaults",
      request: async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname
        calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
        if (path.endsWith("/defaults")) return Response.json({ recordType: "workgraph", schemaVersion: 1, ownerUserId: "user_1", version: 4, createdAt: 1, updatedAt: 2, provenance, id: "workgraph_default", defaults: { execution: { effort: "high" }, recap: { quietHours: 8 } } })
        return Response.json({ ok: true, operationId: "operation_defaults", cursor: "cursor_5", value: {} })
      },
    })

    expect(await client.defaults()).toMatchObject({ version: 4, defaults: { execution: { effort: "high" }, recap: { quietHours: 8 } } })
    await client.updateWorkGraphDefaults(4, { execution: {}, recap: { effort: "low", quietHours: 12 } })
    expect(calls).toEqual([
      { path: "/api/workgraph/defaults" },
      { path: "/api/workgraph/commands", body: { operationId: "operation_defaults", command: { version: 1, type: "update_workgraph_defaults", expectedVersion: 4, defaults: { execution: {}, recap: { effort: "low", quietHours: 12 } } } } },
    ])
  })

  test("reads exact review and execution details without a snapshot fallback", async () => {
    const calls: string[] = []
    const base = { schemaVersion: 1, ownerUserId: "user_1", version: 1, createdAt: 1, updatedAt: 1, provenance }
    const source = { workSourceId: "source_1", revisionId: "revision_1", contentHash: "a".repeat(64) }
    const workItem = {
      recordType: "work_item", ...base, id: "item_1", streamId: "stream_1", title: "Ship",
      state: "active", priority: 0, dependencyIds: [], sourceRevisionRefs: [source], evidenceIds: [],
      completionContract: { version: 1, mode: "all", requirements: [{ id: "verified", kind: "verification", description: "Verified", instructions: "Run tests" }] },
    }
    const attempt = {
      recordType: "attempt", ...base, id: "attempt_1", streamId: "stream_1", workItemId: "item_1",
      attemptNumber: 1, state: "running", admittedAt: 1, sourceRevisionRefs: [source],
      resolvedExecution: {
        environment: { kind: "hosted_workspace" }, harness: "codex", agent: "developer",
        model: { providerId: "openai", modelId: "gpt-5" }, effort: "high", tools: [], connectionIds: [],
      },
    }
    const responses: Record<string, unknown> = {
      "/api/workgraph/proposals/proposal_1": { recordType: "admission_proposal", ...base, id: "proposal_1", state: "planning", source, generation: { method: "planning", attempt: 0, queuedAt: 1 } },
      "/api/workgraph/streams/stream_1/replacement-review": {
        streamId: "stream_1",
        streamTitle: "Launch",
        status: "eligible",
        targets: [{ workItemId: "item_1", expectedVersion: 1, title: "Ship", state: "active" }],
      },
      "/api/workgraph/work-items/item_1": workItem,
      "/api/workgraph/work-items/item_1/attempts": { attempts: [{ attempt, executionReferences: { sessionId: "session_1", workspaceId: "workspace_1" } }], hasMore: false },
      "/api/workgraph/attempts/attempt_1": { attempt, executionReferences: { sessionId: "session_1", workspaceId: "workspace_1" } },
      "/api/workgraph/decisions/decision_1": { recordType: "decision", ...base, id: "decision_1", streamId: "stream_1", state: "pending", question: "Ship?", options: [{ id: "yes", label: "Yes" }], affectedWorkItemIds: ["item_1"], sourceRevisionRefs: [source] },
      "/api/workgraph/recaps/recap_1": { recordType: "recap", ...base, id: "recap_1", streamId: "stream_1", activityRange: { fromSequence: 1, toSequence: 2, quietSince: 3 }, summary: "Ready", actionableReferences: [], generation: { state: "succeeded", model: { providerId: "openai", modelId: "gpt-5" }, effort: "low", generatedAt: 4, method: "agent_session", sessionId: "session_recap" }, sourceRevisionRefs: [source] },
      "/api/workgraph/intake/candidate_1": { candidateKind: "session", id: "candidate_1", ownerUserId: "user_1", version: 1, sessionId: "session_1", title: "Investigate", body: "Finding", state: "unorganized", createdAt: 1, updatedAt: 1 },
    }
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        calls.push(`${url.pathname}${url.search}`)
        return Response.json(responses[url.pathname])
      },
    })

    await expect(client.proposal("proposal_1")).resolves.toMatchObject({ id: "proposal_1" })
    await expect(client.replacementReview({ streamId: "stream_1", previousSource: source })).resolves.toMatchObject({
      status: "eligible",
      targets: [{ workItemId: "item_1", expectedVersion: 1 }],
    })
    await expect(client.workItem("item_1")).resolves.toMatchObject({ id: "item_1" })
    await expect(client.workItemAttempts("item_1", { limit: 10 })).resolves.toMatchObject({ attempts: [{ executionReferences: { sessionId: "session_1" } }] })
    await expect(client.attempt("attempt_1")).resolves.toMatchObject({ attempt: { id: "attempt_1" } })
    await expect(client.decision("decision_1")).resolves.toMatchObject({ id: "decision_1" })
    await expect(client.recap("recap_1")).resolves.toMatchObject({ id: "recap_1" })
    await expect(client.intakeCandidate("candidate_1")).resolves.toMatchObject({ id: "candidate_1" })
    expect(calls).toEqual([
      "/api/workgraph/proposals/proposal_1",
      `/api/workgraph/streams/stream_1/replacement-review?workSourceId=${source.workSourceId}&revisionId=${source.revisionId}&contentHash=${source.contentHash}`,
      "/api/workgraph/work-items/item_1",
      "/api/workgraph/work-items/item_1/attempts?limit=10",
      "/api/workgraph/attempts/attempt_1",
      "/api/workgraph/decisions/decision_1",
      "/api/workgraph/recaps/recap_1",
      "/api/workgraph/intake/candidate_1",
    ])
  })

  test("reads exact Evidence and a strict subject-scoped Evidence page", async () => {
    const calls: string[] = []
    const evidence = {
      id: "evidence_1",
      subject: { type: "work_item", workItemId: "item_1" },
      requirementId: "verified",
      kind: "finding",
      summary: "Smoke test is green",
      sourceRef: "session:smoke",
      recordedAt: 10,
      recordedBy: { type: "agent", id: "agent_1" },
    }
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        calls.push(`${url.pathname}${url.search}`)
        return Response.json(url.search ? {
          evidence: [evidence],
          hasMore: true,
          nextCursor: "wgep1:owner:work_item:item_1:10:evidence_1",
        } : evidence)
      },
    })

    expect(await client.evidence("evidence_1")).toMatchObject({ id: "evidence_1", kind: "finding" })
    expect(await client.evidencePage(
      { type: "work_item", workItemId: "item_1" },
      { limit: 1, after: "wgep1:owner:work_item:item_0:9:evidence_0" as never },
    )).toMatchObject({ evidence: [{ id: "evidence_1" }], hasMore: true })
    expect(calls).toEqual([
      "/api/workgraph/evidence/evidence_1",
      "/api/workgraph/evidence?subjectType=work_item&limit=1&workItemId=item_1&after=wgep1%3Aowner%3Awork_item%3Aitem_0%3A9%3Aevidence_0",
    ])
  })

  test("reads bounded Task activity with explicit granularity and cursor paging", async () => {
    const calls: string[] = []
    const entry = {
      id: "activity_1",
      streamId: "stream_1",
      workItemId: "item_1",
      category: "checkpoint",
      importance: "progress",
      summary: "Validated the migration boundary",
      occurredAt: 10,
      actor: { type: "agent", id: "session_1" },
      source: { type: "checkpoint", id: "checkpoint_1" },
    }
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        calls.push(`${url.pathname}${url.search}`)
        return Response.json({ entries: [entry], hasMore: true, nextCursor: "activity:next" })
      },
    })

    await expect(client.workItemActivity("item_1", {
      granularity: "detailed",
      after: "activity:previous" as never,
      limit: 1,
    })).resolves.toMatchObject({ entries: [{ id: "activity_1" }], hasMore: true })
    expect(calls).toEqual([
      "/api/workgraph/work-items/item_1/activity?granularity=detailed&limit=1&after=activity%3Aprevious",
    ])
  })

  test("surfaces an invalid Evidence cursor and rejects a non-canonical page", async () => {
    let invalid = true
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => {
        if (invalid) return Response.json({ error: { code: "cursor_invalid", message: "Restart Evidence paging", retryable: false } }, { status: 409 })
        return Response.json({ evidence: [], hasMore: true })
      },
    })

    await expect(client.evidencePage({ type: "stream", streamId: "stream_1" }))
      .rejects.toMatchObject({ kind: "cursor_invalid", status: 409 })
    invalid = false
    await expect(client.evidencePage({ type: "stream", streamId: "stream_1" }))
      .rejects.toMatchObject({ kind: "invalid_response", status: 200 })
  })

  test("sends strict versioned Source View and candidate lifecycle requests", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    const sourceView = {
      id: "view_1",
      ownerUserId: "user_1",
      version: 2,
      teamConnectionId: "connection_1",
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/cloud" },
      target: {
        environment: { kind: "hosted_workspace", repositoryUrl: "https://github.com/claxedo/cloud.git" },
        repository: { remoteUrl: "https://github.com/claxedo/cloud.git", baseRevision: "dev" },
      },
      syncPolicy: "announce",
      status: "paused",
      createdAt: 1,
      updatedAt: 2,
    }
    const candidate = {
      candidateKind: "session",
      id: "candidate_1",
      ownerUserId: "user_1",
      version: 2,
      sessionId: "session_1",
      title: "Investigate",
      body: "Finding",
      state: "dismissed",
      createdAt: 1,
      updatedAt: 2,
    }
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname
        calls.push({ path, method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) })
        return Response.json(path.includes("/intake/") ? candidate : sourceView)
      },
    })

    await client.createSourceView({
      teamConnectionId: "connection_1" as never,
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/cloud" },
      target: sourceView.target,
      syncPolicy: "announce",
    })
    await client.updateSourceView("view_1", {
      expectedVersion: 1,
      providerUserId: "octocat",
      filters: { repo: "claxedo/cloud" },
      target: sourceView.target,
      syncPolicy: "announce",
      status: "paused",
    })
    await client.deleteSourceView("view_1", 2)
    await client.dismissIntakeCandidate("candidate_1", 1)
    await client.restoreIntakeCandidate("candidate_1", 2)

    expect(calls).toEqual([
      { path: "/api/workgraph/source-views", method: "POST", body: { teamConnectionId: "connection_1", provider: "github", providerUserId: "octocat", filters: { repo: "claxedo/cloud" }, target: sourceView.target, syncPolicy: "announce" } },
      { path: "/api/workgraph/source-views/view_1", method: "PUT", body: { expectedVersion: 1, providerUserId: "octocat", filters: { repo: "claxedo/cloud" }, target: sourceView.target, syncPolicy: "announce", status: "paused" } },
      { path: "/api/workgraph/source-views/view_1", method: "DELETE", body: { expectedVersion: 2 } },
      { path: "/api/workgraph/intake/candidate_1/dismiss", method: "POST", body: { expectedVersion: 1 } },
      { path: "/api/workgraph/intake/candidate_1/restore", method: "POST", body: { expectedVersion: 2 } },
    ])
  })

  test("sends exact operational command DTOs through the single command endpoint", async () => {
    const bodies: unknown[] = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      operationId: () => "operation_fixed",
      request: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true, operationId: "operation_fixed", cursor: "cursor_2", value: {} })
      },
    })

    await client.createOutcome({ streamId: "stream_1", title: "Deploy", successCriteria: ["Healthy in production"] })
    await client.createWorkItem({
      streamId: "stream_1",
      outcomeId: "outcome_1",
      title: "Run deployment",
      dependencyIds: ["item_0"],
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{ id: "requirement_1", kind: "verification", description: "Smoke test passes", instructions: "Run smoke test" }],
      },
    })
    await client.updateOutcomeExecution("outcome_1", 2, { effort: "high", model: { providerId: "openai", modelId: "gpt-5.1" } })
    await client.updateStreamSettings("stream_1", 5, {
      execution: { effort: "high" },
      recap: { effort: "low", quietHours: 12 },
      activityGranularity: "detailed",
    })
    await client.updateWorkItemExecution("item_1", 3, {})
    await client.executeWorkItem("item_1", "supervised")
    await client.cancelAttempt("attempt_1", 3, "Owner stopped it")
    await client.cancelWorkItem("item_1", 4, "No longer needed")
    await client.answerDecision("decision_1", 2, { optionId: "ship" })
    await client.recordEvidence({ subject: { type: "work_item", workItemId: "item_1" }, evidence: { kind: "finding", summary: "Smoke test is green" } })
    await client.dismissAdmission("proposal_1", 3)
    await client.reopenAdmission("proposal_1", 4)
    await client.deleteStream("stream_1", 4, "Discard prototype")

    expect(bodies).toEqual([
      { operationId: "operation_fixed", command: { version: 1, type: "create_outcome", streamId: "stream_1", title: "Deploy", successCriteria: ["Healthy in production"] } },
      { operationId: "operation_fixed", command: { version: 1, type: "create_work_item", streamId: "stream_1", outcomeId: "outcome_1", title: "Run deployment", dependencyIds: ["item_0"], completionContract: { version: 1, mode: "all", requirements: [{ id: "requirement_1", kind: "verification", description: "Smoke test passes", instructions: "Run smoke test" }] } } },
      { operationId: "operation_fixed", command: { version: 1, type: "update_outcome", outcomeId: "outcome_1", expectedVersion: 2, execution: { effort: "high", model: { providerId: "openai", modelId: "gpt-5.1" } } } },
      { operationId: "operation_fixed", command: { version: 1, type: "update_stream", streamId: "stream_1", expectedVersion: 5, execution: { effort: "high" }, recap: { effort: "low", quietHours: 12 }, activityGranularity: "detailed" } },
      { operationId: "operation_fixed", command: { version: 1, type: "update_work_item", workItemId: "item_1", expectedVersion: 3, execution: {} } },
      { operationId: "operation_fixed", command: { version: 1, type: "execute_work_item", workItemId: "item_1", executionMode: "supervised" } },
      { operationId: "operation_fixed", command: { version: 1, type: "cancel_attempt", attemptId: "attempt_1", expectedVersion: 3, reason: "Owner stopped it" } },
      { operationId: "operation_fixed", command: { version: 1, type: "cancel_work_item", workItemId: "item_1", expectedVersion: 4, reason: "No longer needed" } },
      { operationId: "operation_fixed", command: { version: 1, type: "answer_decision", decisionId: "decision_1", expectedVersion: 2, optionId: "ship" } },
      { operationId: "operation_fixed", command: { version: 1, type: "record_evidence", subject: { type: "work_item", workItemId: "item_1" }, evidence: { kind: "finding", summary: "Smoke test is green" } } },
      { operationId: "operation_fixed", command: { version: 1, type: "dismiss_admission", proposalId: "proposal_1", expectedVersion: 3 } },
      { operationId: "operation_fixed", command: { version: 1, type: "reopen_admission", proposalId: "proposal_1", expectedVersion: 4 } },
      { operationId: "operation_fixed", command: { version: 1, type: "delete_stream", streamId: "stream_1", expectedVersion: 4, reason: "Discard prototype" } },
    ])
  })

  test("sends empty settings objects to explicitly clear Stream overrides", async () => {
    const bodies: unknown[] = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      operationId: () => "operation_clear_settings",
      request: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true, operationId: "operation_clear_settings", cursor: "cursor_3", value: {} })
      },
    })

    await client.updateStreamSettings("stream_1", 6, { execution: {}, recap: {} })

    expect(bodies).toEqual([{
      operationId: "operation_clear_settings",
      command: {
        version: 1,
        type: "update_stream",
        streamId: "stream_1",
        expectedVersion: 6,
        execution: {},
        recap: {},
      },
    }])
  })

  test("rejects an invalid atomic Stream settings update response", async () => {
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      operationId: () => "operation_recap",
      request: async () => Response.json({ ok: true, operationId: "operation_recap", value: {} }),
    })

    await expect(client.updateStreamSettings("stream_1", 5, { execution: {}, recap: { quietHours: 8 } })).rejects.toMatchObject({
      kind: "invalid_response",
      status: 200,
    })
  })

  test.each([
    ["not_found", 404],
    ["version_conflict", 409],
    ["invalid_transition", 422],
  ] as const)("preserves a typed %s command failure for lifecycle review", async (code, status) => {
    const result = {
      ok: false as const,
      operationId: "operation_failure",
      error: { code, message: `Admission ${code}`, retryable: false },
    }
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      operationId: () => "operation_failure",
      request: async () => Response.json(result, { status }),
    })

    await expect(client.dismissAdmission("proposal_1", 3)).resolves.toEqual(result)
  })

  test("keeps command authentication failures outside the domain result contract", async () => {
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => Response.json({ error: { code: "unauthorized", message: "Sign in required", retryable: false } }, { status: 401 }),
    })

    await expect(client.dismissAdmission("proposal_1", 3)).rejects.toMatchObject({
      kind: "unauthorized",
      code: "unauthorized",
      retryable: false,
      status: 401,
    })
  })

  test("unauthorized responses remain distinguishable from offline failures", async () => {
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => Response.json({ error: { code: "unauthorized", message: "Sign in required", retryable: false } }, { status: 401 }),
    })
    await expect(client.snapshot()).rejects.toBeInstanceOf(WorkGraphApiError)
    await expect(client.snapshot()).rejects.toMatchObject({ kind: "unauthorized", code: "unauthorized", retryable: false })
  })

  test.each([
    ["not_found", 404, false],
    ["validation_error", 400, false],
    ["internal_error", 500, true],
  ] as const)("preserves strict %s read failure metadata", async (code, status, retryable) => {
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => Response.json({ error: { code, message: `Read failed: ${code}`, retryable } }, { status }),
    })

    await expect(client.proposal("proposal_1")).rejects.toMatchObject({
      kind: code,
      code,
      retryable,
      status,
      message: `Read failed: ${code}`,
    })
  })

  test("rejects a non-canonical read error envelope", async () => {
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => Response.json({ message: "missing error metadata" }, { status: 500 }),
    })

    await expect(client.proposal("proposal_1")).rejects.toMatchObject({ kind: "invalid_response", status: 500 })
  })

  test("reads the strict execution capability catalog with an implicit GET", async () => {
    const calls: Array<{ path: string; method: string }> = []
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
        calls.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? "GET" })
        return Response.json(executionCapabilities)
      },
    })

    await expect(client.executionCapabilities()).resolves.toEqual(executionCapabilities)
    expect(calls).toEqual([{ path: "/api/workgraph/execution-capabilities", method: "GET" }])
  })

  test("rejects a malformed execution capability catalog without a fallback", async () => {
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => Response.json({ ...executionCapabilities, harnesses: [] }),
    })

    await expect(client.executionCapabilities()).rejects.toMatchObject({ kind: "invalid_response", status: 200 })
  })

  test("preserves the strict execution capability unavailable envelope", async () => {
    const client = createWorkGraphClient({
      baseUrl: "http://127.0.0.1:3001",
      request: async () => Response.json({
        error: {
          code: "execution_capabilities_unavailable",
          capability: "runtime",
          reason: "runtime_unavailable",
          message: "Execution capability discovery is not composed",
          retryable: false,
        },
      }, { status: 503 }),
    })

    await expect(client.executionCapabilities()).rejects.toMatchObject({
      kind: "execution_capabilities_unavailable",
      code: "execution_capabilities_unavailable",
      capability: "runtime",
      reason: "runtime_unavailable",
      retryable: false,
      status: 503,
      message: "Execution capability discovery is not composed",
    })
  })
})

function streams(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...stream,
    id: `stream_${start + index + 1}`,
    title: `Stream ${start + index + 1}`,
    createdAt: start + index + 1,
    updatedAt: start + index + 1,
  }))
}

function snapshotPage(
  records: ReturnType<typeof streams>,
  snapshotCursor: string,
  capturedAt: number,
  nextCursor?: string,
  sequenceStart = 1,
) {
  return {
    snapshotCursor,
    records,
    references: records.map((record, index) => ({
      sequence: sequenceStart + index,
      resource: { type: "stream", id: record.id },
      version: record.version,
    })),
    hasMore: !!nextCursor,
    ...(nextCursor ? { nextCursor } : {}),
    capturedAt,
  }
}
