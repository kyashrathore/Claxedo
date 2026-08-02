import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { CommandResult } from "@claxedo/workgraph/contracts"
import { createRealWorkGraphHarness, type RealWorkGraphHarness } from "../helpers/real-workgraph-harness"

const repository = path.resolve(import.meta.dirname, "../../../..")
let harness: RealWorkGraphHarness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe("WorkGraph local headless journey", () => {
  test("the loop launches and completes a Task through a real Session V2", async () => {
    harness = await createRealWorkGraphHarness({ port: 0, realSessions: true, realMasters: true })
    const stream = await command({
      version: 1,
      type: "create_stream",
      title: "Headless real Session",
      execution: execution("shared", true),
    })
    const streamId = String(stream.value.streamId)
    const task = await command({
      version: 1,
      type: "create_work_item",
      streamId,
      title: "Complete the headless journey",
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{
          id: "real-session-proof",
          kind: "test",
          description: "The real Session completes through the scoped WorkGraph tool",
        }],
      },
    })

    await expect.poll(async () => {
      await harness!.runReconcile()
      return (await get(`/api/workgraph/work-items/${encodeURIComponent(String(task.value.workItemId))}`)).state
    }, { timeout: 15_000 }).toBe("completed")
    expect(harness.realSessionEvidence()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        directory: harness.worktreeDirectory(streamId),
        title: "Complete the headless journey",
      }),
    ]))
    expect(harness.realSessionDiagnostics()).toMatchObject({
      proxyErrors: [],
    })
    expect(harness.realSessionDiagnostics().providerRequests).toBeGreaterThan(0)
    harness.assertHealthy()
  }, 120_000)

  test("source planning confirms a proposal and completes its born-approved Task", async () => {
    harness = await createRealWorkGraphHarness({ port: 0 })
    harness.queueExecutionResults("running")
    await command({
      version: 1,
      type: "update_workgraph_defaults",
      expectedVersion: 1,
      defaults: {
        execution: {
          harness: "opencode",
          agent: "build",
          model: { providerId: "openai", modelId: "gpt-5" },
          effort: "high",
          tools: ["read", "edit"],
          connectionIds: [],
        },
      },
    })
    const source = await command({
      version: 1,
      type: "create_work_source",
      title: "Headless launch brief",
      content: "Plan and complete the release readiness work.",
    })
    const revision = await get(
      `/api/workgraph/sources/${encodeURIComponent(String(source.value.workSourceId))}/revisions/${encodeURIComponent(String(source.value.revisionId))}`,
    )
    const admission = await command({
      version: 1,
      type: "propose_admission",
      source: {
        workSourceId: source.value.workSourceId,
        revisionId: source.value.revisionId,
        contentHash: revision.contentHash,
      },
    })
    expect(await harness.runSourcePlanning()).toMatchObject({ state: "completed" })
    const proposal = await get(`/api/workgraph/proposals/${encodeURIComponent(String(admission.value.proposalId))}`)
    const confirmed = await command({
      version: 1,
      type: "confirm_admission",
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      source: proposal.source,
      selection: { mode: "create", streamTitle: "Headless planned Stream" },
      outcomes: proposal.proposedOutcomes.map((outcome: Record<string, unknown>) => ({
        proposalKey: outcome.key,
        title: outcome.title,
        successCriteria: outcome.successCriteria,
        execution: outcome.execution,
      })),
      workItems: proposal.proposedWorkItems.map((workItem: Record<string, unknown>) => ({
        proposalKey: workItem.key,
        ...(workItem.outcomeKey ? { outcomeProposalKey: workItem.outcomeKey } : {}),
        title: workItem.title,
        dependencyProposalKeys: workItem.dependencyKeys,
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [{
            id: `planned-${String(workItem.key)}`,
            kind: "test",
            description: "The planned Task completes through the controlled Session",
          }],
        },
        execution: workItem.execution,
      })),
    })
    await command({
      version: 1,
      type: "update_stream",
      streamId: confirmed.value.streamId,
      expectedVersion: 1,
      execution: execution("shared"),
    })
    const snapshot = await get("/api/workgraph/snapshot?limit=100")
    const planned = snapshot.records.find((record: { recordType: string; streamId?: string }) =>
      record.recordType === "work_item" && record.streamId === confirmed.value.streamId)
    expect(planned).toBeDefined()
    await expect.poll(async () => {
      await harness!.runReconcile()
      return (await get(`/api/workgraph/work-items/${encodeURIComponent(String(planned.id))}`)).state
    }, { timeout: 10_000 }).toBe("active")
    await harness.completeControlledRun(
      String(planned.id),
      "The planned Task completed",
      ["artifact://planned-task"],
    )
    await command({
      version: 1,
      type: "record_evidence",
      subject: { type: "work_item", workItemId: planned.id },
      requirementId: `planned-${String(proposal.proposedWorkItems[0].key)}`,
      evidence: { kind: "test_result", summary: "The planned Task passed its journey gate", passed: true },
    })
    await expect.poll(async () => {
      await harness!.runReconcile()
      return (await get(`/api/workgraph/work-items/${encodeURIComponent(String(planned.id))}`)).state
    }).toBe("completed")
    expect(harness.controlledExecutionDiagnostics().durableRuns).toEqual([
      expect.objectContaining({ lifecycle: "result" }),
    ])
    harness.assertHealthy()
  }, 30_000)

  test("swarm shape caps six runnable Tasks at four live isolated leases", async () => {
    harness = await createRealWorkGraphHarness({ port: 0 })
    harness.queueExecutionResults("running", "running", "running", "running", "running", "running")
    const stream = await command({
      version: 1,
      type: "create_stream",
      title: "Four-wide headless swarm",
      execution: {
        ...execution("worktree"),
        maxParallel: 4,
      },
    })
    const streamId = String(stream.value.streamId)
    await Promise.all(Array.from({ length: 6 }, (_, index) => command({
      version: 1,
      type: "create_work_item",
      streamId,
      title: `Parallel Task ${index + 1}`,
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{ id: `parallel-${index + 1}`, kind: "owner_confirmation", description: "Owner review" }],
      },
    })))

    await expect.poll(async () => {
      await harness!.runReconcile()
      return harness!.controlledExecutionDiagnostics().leases.length
    }).toBe(4)
    expect(harness.controlledExecutionDiagnostics().pendingWork).toHaveLength(2)

    const parent = await command({
      version: 1,
      type: "create_stream",
      title: "Promotion parent",
      execution: {
        mayPromote: true,
        budget: { amount: 100, unit: "tokens", window: "stream" },
      },
    })
    await expect(command({
      version: 1,
      type: "create_stream",
      title: "Unconfirmed child",
      parentStreamId: parent.value.streamId,
      budgetCarve: { amount: 30, unit: "tokens", window: "stream" },
    })).rejects.toThrow("requires explicit owner confirmation")
    const child = await command({
      version: 1,
      type: "create_stream",
      title: "Confirmed child",
      parentStreamId: parent.value.streamId,
      budgetCarve: { amount: 30, unit: "tokens", window: "stream" },
      confirmAutonomy: true,
    })
    await expect(command({
      version: 1,
      type: "close_stream",
      streamId: parent.value.streamId,
      expectedVersion: 2,
      reason: "Done",
    })).rejects.toThrow(String(child.value.streamId))
    harness.assertHealthy()
  }, 30_000)

  /**
   * G3 (`2026-07-29-002:156`) — the headless mirror of the browser Connections
   * journey (`core-workgraph.spec.ts:413`), in the lane that actually gets re-run.
   * Every hop is asserted by API, never by UI (WS-F F1 scenario 1,
   * `2026-07-28-010:27`). The only replaced boundaries are the ones the harness
   * already replaces: the provider's HTTP surface (the scripted source-issue
   * connector, which performs a REAL token comparison) and the model endpoint (the
   * fake OpenAI-compatible server). The Connection itself, its credential store,
   * the integrations routes, the Source View + intake services, source planning,
   * admission, the Session V2 gateway, the connection-operation broker and a real
   * OpenCode subprocess are all production code.
   */
  test("a real Connection drives discovery, planning, a real Session V2, and a durable external effect", async () => {
    harness = await createRealWorkGraphHarness({ port: 0, realSessions: true })
    const connectionId = harness.connectionEvidence().connectionIds.github
    await command({
      version: 1,
      type: "update_workgraph_defaults",
      expectedVersion: 1,
      defaults: {
        execution: {
          harness: "opencode",
          agent: "build",
          model: { providerId: "workgraph-e2e", modelId: "workgraph-model" },
          effort: "high",
          tools: ["read", "edit"],
          connectionIds: [],
        },
      },
    })

    // HOP 1 — a Source View is created against the REAL team Connection. The
    // route resolves the Connection through the real capability port, so a
    // Connection the owner cannot see would 409 here instead of persisting.
    const sourceView = await post("/api/workgraph/source-views", {
      teamConnectionId: connectionId,
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/claxedo", state: "open" },
      target: {
        environment: { kind: "local_worktree", placement: "shared", directory: repository },
        repository: { baseRevision: "HEAD" },
      },
      syncPolicy: "announce",
    })
    expect(sourceView).toMatchObject({ teamConnectionId: connectionId, provider: "github", status: "active" })
    expect(await get("/api/workgraph/source-views")).toMatchObject({
      sourceViews: [{ id: sourceView.id, teamConnectionId: connectionId }],
    })

    // HOP 2 — refresh reaches the provider through the Connection's live token.
    // `authorized` is a real comparison inside the connector: a wrong or missing
    // token would record `false` and throw, so `true` proves the credential
    // actually crossed the capability handle.
    expect(await post(`/api/workgraph/source-views/${encodeURIComponent(sourceView.id)}/refresh`, {}))
      .toMatchObject({ created: 1, updated: 0 })
    expect(harness.connectionEvidence().requests).toEqual([{
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/claxedo", state: "open" },
      authorized: true,
    }])

    // HOP 3 — the external issue is a durable intake candidate.
    const candidates = (await get("/api/workgraph/intake?limit=50")).candidates as Record<string, unknown>[]
    const candidate = candidates.find((entry) => entry.candidateKind === "external_issue")
    expect(candidate).toMatchObject({
      candidateKind: "external_issue",
      provider: "github",
      externalId: "101",
      externalKey: "#101",
      state: "unorganized",
      sourceViewId: sourceView.id,
    })

    // HOP 4 — staging freezes the text into an immutable content-hashed revision
    // and opens an admission proposal.
    const staged = await post(`/api/workgraph/intake/${encodeURIComponent(String(candidate!.id))}/stage`, undefined)
    expect(staged).toMatchObject({
      state: "staged",
      source: { workSourceId: expect.any(String), revisionId: expect.any(String), contentHash: expect.any(String) },
      admissionProposalId: expect.any(String),
    })

    // HOP 5 — real source planning produces a reviewable proposal for the frozen
    // revision. The proposal is Session-authored: the plan text comes from the
    // generation runtime, and the Connection binding rides the proposal-level
    // execution the intake service derived from the Source View (asserted at
    // HOP 6, where it becomes durable Stream state).
    expect(await harness.runSourcePlanning()).toMatchObject({ state: "completed" })
    const proposal = await get(`/api/workgraph/proposals/${encodeURIComponent(String(staged.admissionProposalId))}`)
    expect(proposal).toMatchObject({
      state: "proposed",
      source: staged.source,
      generation: { method: "agent_session" },
    })
    expect(proposal.proposedWorkItems).toHaveLength(1)
    expect(proposal.proposedWorkItems[0].title).toBe("Resolve #101")

    // HOP 6 — confirmation creates a born-approved Task. There is no approve hop:
    // owner-confirmed work is born approved and the active Stream's drain admits it.
    const confirmed = await command({
      version: 1,
      type: "confirm_admission",
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      source: proposal.source,
      selection: { mode: "create", streamTitle: "#101 · Connection-filtered launch issue" },
      outcomes: [],
      workItems: proposal.proposedWorkItems.map((workItem: Record<string, unknown>) => ({
        proposalKey: workItem.key,
        title: workItem.title,
        description: workItem.description,
        dependencyProposalKeys: workItem.dependencyKeys,
        completionContract: workItem.completionContract,
        execution: workItem.execution,
      })),
    })
    const streamId = String(confirmed.value.streamId)
    const snapshot = await get("/api/workgraph/snapshot?limit=100")
    const task = snapshot.records.find((record: { recordType: string; streamId?: string }) =>
      record.recordType === "work_item" && record.streamId === streamId)
    // Born approved: an owner-confirmed Task never waits in `pending_approval`
    // (nor lands as an inert `draft`) — the active Stream's drain may admit it
    // immediately, so it is already `pending` or launched into `active`.
    expect(["pending", "active"]).toContain(task.state)
    // The Connection binding is durable Stream state derived from the Source View
    // — the one place a Connection may enter execution. The Connection tools ride
    // with it, and `connection_code_host_open_pr` is present only because this
    // Connection really granted `code-host`.
    const stream = snapshot.records.find((record: { recordType: string; id?: string }) =>
      record.recordType === "stream" && record.id === streamId)
    expect(stream.executionDefaults).toMatchObject({ connectionIds: [connectionId] })
    expect(stream.executionDefaults.tools).toContain("connection_work_source_comment")

    // HOP 7 — the drain launches a REAL Session V2 (a real OpenCode subprocess)
    // and the Task settles through its completion contract, not through a test poke.
    try {
      await expect.poll(async () => {
        await harness!.runReconcile()
        return (await get(`/api/workgraph/work-items/${encodeURIComponent(String(task.id))}`)).state
      }, { timeout: 60_000 }).toBe("completed")
    } catch (error) {
      throw new Error([
        String(error),
        `Work item: ${JSON.stringify(await get(`/api/workgraph/work-items/${encodeURIComponent(String(task.id))}`))}`,
        `Execution: ${JSON.stringify(harness!.controlledExecutionDiagnostics())}`,
        `Real Session: ${JSON.stringify(harness!.realSessionDiagnostics())}`,
      ].join("\n"))
    }
    // The real Session ran in this Stream's own isolated envelope, not loose in
    // the repository — the placement the confirmed execution profile asked for.
    expect(harness.realSessionEvidence()).toEqual(expect.arrayContaining([
      expect.objectContaining({ directory: harness.worktreeDirectory(streamId), title: "Resolve #101" }),
    ]))
    expect(harness.realSessionDiagnostics()).toMatchObject({ proxyErrors: [] })

    // HOP 8 — the Connection operation the agent asked for actually reached the
    // provider, carrying a real authorization and its idempotency key. The agent
    // never held a credential: it named a capability handle and the server
    // exchanged it server-side.
    expect(harness.connectionEvidence().effects).toEqual([{
      provider: "github",
      action: "comment",
      externalId: "101",
      body: "Claxedo completed the requested work for 101 in a project-scoped autonomous Session.",
      idempotencyKey: "workgraph-e2e:101:result",
      authorized: true,
    }])

    // HOP 9 — durable state, not request counts: the Stream carries exactly one
    // durable effect receipt and the candidate closed the loop back to confirmed.
    expect(await get(`/api/workgraph/streams/${encodeURIComponent(streamId)}`))
      .toMatchObject({ durableEffectCount: 1 })
    expect(await get(`/api/workgraph/intake/${encodeURIComponent(String(candidate!.id))}`))
      .toMatchObject({ state: "confirmed" })
    harness.assertHealthy()
  }, 180_000)

  /**
   * G5 (`2026-07-29-002:158`) — the broken-Connection lifecycle.
   *
   * `docs/workgraph.md:154` promises a down dependency surfaces as *unavailable*
   * (503) and NEVER as *unauthorized* (401) — an outage must not masquerade as a
   * bad login. This drives both halves through the real provider boundary and
   * asserts the durable Connection state each one leaves behind.
   *
   * SCOPE NOTE (reported, not forced): `docs/workgraph.md:84` also promises broken
   * Connections appear in Needs-you. In this LOCAL composition that row does not
   * exist to assert: the SQLite Attention projection
   * (`workgraph/src/adapters/sqlite/store.ts:136`) sources `configuration_required`
   * exclusively from `wg_v2_due_jobs` rows whose
   * `configurationRequirement.type` is `"generation"` — there is no
   * connection-status producer at all. The connection-shaped requirement
   * (`contracts/attention.ts:131`) is written only by the HOSTED projection
   * (`convex/workgraphAttention.ts:145` `syncConnectionAttention`). Asserting a
   * broken-Connection Attention row here would require inventing production
   * behaviour, so this test asserts the Attention page truthfully stays empty and
   * proves the degradation durably instead.
   */
  test("a provider outage surfaces as unavailable while a real 401 degrades the Connection", async () => {
    harness = await createRealWorkGraphHarness({ port: 0 })
    const connectionId = harness.connectionEvidence().connectionIds.github
    const sourceView = await post("/api/workgraph/source-views", {
      teamConnectionId: connectionId,
      provider: "github",
      providerUserId: "octocat",
      filters: { repo: "claxedo/claxedo", state: "open" },
      syncPolicy: "silent",
    })
    const refresh = `/api/workgraph/source-views/${encodeURIComponent(sourceView.id)}/refresh`

    // OUTAGE — the provider transport is down. The rail: 503 unavailable and
    // retryable, never 401, and the Connection is NOT blamed for the outage.
    //
    // This reaches the router's real transport branch for a SHIPPED connector
    // too: classification is now by error `name`, not `instanceof`, so it no
    // longer depends on which bundled entry point raised the error. (It used to:
    // the connectors arrive from `@claxedo/workgraph` while the classes live in
    // `@claxedo/workgraph/connectors`, separately bundled, so every real throw
    // fell through to an unclassified 500. See intake-router `sourceIssueFailure`.)
    harness.failSourceIssueProvider("github", "unavailable")
    const unavailable = await raw(refresh)
    expect(unavailable.status).toBe(503)
    expect(unavailable.body).toMatchObject({
      error: { code: "source_issue_transport_unavailable", retryable: true },
    })
    expect(await harness.connectionStatuses()).toContainEqual({
      id: connectionId,
      integrationId: "github",
      status: "connected",
    })

    // GENUINE 401 — the provider rejects a structurally valid token. The real
    // `useAuthorization` → `reportAuthFailure` path must durably degrade the
    // Connection: that degradation, not the HTTP status, is the load-bearing
    // outcome, so it is what this asserts.
    //
    // The status is now assertable: it used to be an unclassified 500 because
    // the router matched on `instanceof` across a bundle split. `401`, never a
    // masked 503, is the promised distinction — an expired credential is the
    // owner's problem to fix, not a transient outage to retry.
    harness.failSourceIssueProvider("github", "unauthorized")
    const unauthorized = await raw(refresh)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.body).toMatchObject({
      error: { code: "source_issue_provider_unauthorized", retryable: false },
    })
    await expect.poll(() => harness!.connectionStatuses()).toContainEqual({
      id: connectionId,
      integrationId: "github",
      status: "degraded",
    })

    // The degradation is load-bearing, not cosmetic: a degraded Connection stops
    // being offered as an execution capability, so no new work can bind to it.
    expect((await get("/api/workgraph/execution-capabilities")).connections
      .map((connection: { id: string }) => connection.id)).not.toContain(connectionId)

    // Truthful assertion of the surface this composition really has. See the
    // SCOPE NOTE above: the connection-shaped Needs-you row is hosted-only today.
    expect(await get("/api/workgraph/attention?limit=50")).toMatchObject({ items: [], total: 0 })
    harness.assertHealthy()
  }, 30_000)

  test("the automatic sweep recovers state while command cursors remain monotonic", async () => {
    harness = await createRealWorkGraphHarness({ port: 0, reconcileIntervalMs: 10 })
    const first = await command({ version: 1, type: "create_stream", title: "Doorbell one" })
    const second = await command({ version: 1, type: "create_stream", title: "Doorbell two" })
    expect(String(second.cursor).localeCompare(String(first.cursor))).toBeGreaterThan(0)
    const reconcileCalls = harness.controlledExecutionDiagnostics().reconcileCalls
    harness.advanceTime(60_000)
    await expect.poll(() => harness!.controlledExecutionDiagnostics().reconcileCalls)
      .toBeGreaterThan(reconcileCalls)
    const snapshot = await get("/api/workgraph/snapshot?limit=100")
    expect(snapshot.records.filter((record: { recordType: string }) => record.recordType === "stream"))
      .toHaveLength(2)
    expect(harness.controlledExecutionDiagnostics().lastReconcile).toBeDefined()
    harness.assertHealthy()
  })
})

async function command(command: Record<string, unknown>) {
  const response = await fetch(`${harness!.apiUrl}/api/workgraph/commands`, {
    method: "POST",
    headers: { authorization: "Bearer local-token", "content-type": "application/json" },
    body: JSON.stringify({ operationId: crypto.randomUUID(), command }),
  })
  const result = await response.json() as CommandResult
  if (!response.ok || !result.ok) {
    throw new Error(result.ok ? `Command failed with ${response.status}` : result.error.message)
  }
  return result as CommandResult & { ok: true; value: Record<string, unknown>; cursor: string }
}

async function post(route: string, body: unknown) {
  const response = await raw(route, body)
  if (response.status >= 400) throw new Error(`POST ${route} failed: ${response.status} ${JSON.stringify(response.body)}`)
  return response.body as any
}

/** POST that keeps the status: the 401-vs-503 rail is asserted on the status. */
async function raw(route: string, body?: unknown) {
  const response = await fetch(`${harness!.apiUrl}${route}`, {
    method: "POST",
    headers: { authorization: "Bearer local-token", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

async function get(route: string) {
  const response = await fetch(`${harness!.apiUrl}${route}`, {
    headers: { authorization: "Bearer local-token" },
  })
  if (!response.ok) throw new Error(`GET ${route} failed: ${response.status} ${await response.text()}`)
  return await response.json() as any
}

function execution(placement: "shared" | "worktree", realSession = false) {
  return {
    environment: { kind: "local_worktree", placement, directory: repository },
    repository: { baseRevision: "HEAD" },
    harness: "opencode",
    agent: "build",
    model: realSession
      ? { providerId: "workgraph-e2e", modelId: "workgraph-model" }
      : { providerId: "openai", modelId: "gpt-5" },
    effort: "high",
    tools: ["read", "edit"],
    connectionIds: [],
  }
}
