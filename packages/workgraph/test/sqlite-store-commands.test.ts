import BetterSqlite3 from "better-sqlite3"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { createSqliteSourcePlanningRuntime } from "../src/adapters/sqlite/source-planning-runtime"
import { createSqliteWorkGraphService, SQLITE_WORKGRAPH_SUPPORTED_COMMANDS, SQLITE_WORKGRAPH_UNSUPPORTED_COMMANDS } from "../src/adapters/sqlite/store"
import { AttentionCursorError, AttentionPageSchema, ChangeEnvelopeSchema, StreamDtoSchema, WorkGraphDefaultsDtoSchema, WorkGraphSnapshotPageSchema } from "../src/contracts"
import type { AdmissionAgentPlan, CompletionContract, OperationID, StreamID, WorkGraphContext, WorkSourceRevisionRef } from "../src/contracts"

const databases: BetterSqlite3.Database[] = []
const contract = { version: 1, mode: "all", requirements: [{ id: branded("owner"), kind: "owner_confirmation", description: "Owner accepts" }] } satisfies CompletionContract
const planningProfile = {
  environment: { kind: "local_worktree" as const },
  repository: { baseRevision: "HEAD" },
  harness: "claxedo-v2",
  agent: "build",
  model: { providerId: "openai", modelId: "gpt-5" },
  effort: "high",
}

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite WorkGraph public commands", () => {
  it("reads and atomically updates owner-scoped WorkGraph defaults with replay safety", async () => {
    const fixture = await setup()
    expect(WorkGraphDefaultsDtoSchema.parse(
      await fixture.adapter.service.query(owner(), "defaults", "read", {}),
    )).toMatchObject({
      id: "workgraph_default",
      ownerUserId: "owner",
      version: 1,
      defaults: { execution: {}, recap: {} },
    })

    const request = {
      operationId: operation("defaults_once"),
      command: {
        version: 1,
        type: "update_workgraph_defaults",
        expectedVersion: 1,
        defaults: {
          execution: { model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" },
          recap: { quietHours: 12, effort: "medium" },
        },
      },
    } as const
    const updated = await fixture.adapter.service.execute(owner(), request as never)
    expect(updated).toMatchObject({ ok: true, cursor: "1" })
    expect(await fixture.adapter.service.execute(owner(), request as never)).toEqual(updated)
    expect(await fixture.adapter.service.execute(owner(), {
      ...request,
      command: { ...request.command, defaults: { execution: {}, recap: {} } },
    } as never)).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } })
    expect(await execute(fixture, "update_workgraph_defaults", {
      expectedVersion: 1,
      defaults: request.command.defaults,
    })).toMatchObject({ ok: false, error: { code: "version_conflict" } })

    expect(WorkGraphDefaultsDtoSchema.parse(
      await fixture.adapter.service.query(owner(), "defaults", "read", {}),
    )).toMatchObject({ version: 2, defaults: request.command.defaults })
    expect(WorkGraphDefaultsDtoSchema.parse(
      await fixture.adapter.service.query(owner("other"), "defaults", "read", {}),
    )).toMatchObject({ ownerUserId: "other", version: 1, defaults: { execution: {}, recap: {} } })
    const snapshot = WorkGraphSnapshotPageSchema.parse(
      await fixture.adapter.service.query(owner(), "snapshot", "page", { limit: 50 }),
    )
    expect(snapshot.records).toContainEqual(expect.objectContaining({ recordType: "workgraph", id: "workgraph_default", version: 2 }))
    expect(snapshot.references).toContainEqual(expect.objectContaining({ resource: { type: "workgraph", id: "workgraph_default" }, version: 2 }))
    expect(ChangeEnvelopeSchema.array().parse(
      await fixture.adapter.service.query(owner(), "changes", "list", { limit: 50 }),
    )).toContainEqual(expect.objectContaining({
      resource: { type: "workgraph", id: "workgraph_default" },
      event: expect.objectContaining({ type: "workgraph_defaults_updated" }),
    }))
  })

  it("updates Outcomes and atomically replaces Work Item dependencies", async () => {
    const fixture = await setup()
    const streamId = await createStream(fixture)
    const outcomeId = await createOutcome(fixture, streamId)
    const dependencyId = await createItem(fixture, streamId, undefined, "Dependency")
    const itemId = await createItem(fixture, streamId, outcomeId, "Original")

    expect(await execute(fixture, "update_outcome", { outcomeId, expectedVersion: 1, title: "Updated", successCriteria: ["Shipped"] })).toMatchObject({ ok: true })
    expect(await execute(fixture, "update_work_item", { workItemId: itemId, expectedVersion: 1, title: "Changed", dependencyIds: [dependencyId] })).toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT title, row_version FROM wg_v2_outcomes WHERE id = ?").get(outcomeId)).toEqual({ title: "Updated", row_version: 2 })
    expect(fixture.database.prepare("SELECT depends_on_work_item_id FROM wg_v2_work_item_dependencies WHERE work_item_id = ?").all(itemId)).toEqual([{ depends_on_work_item_id: dependencyId }])

    expect(await execute(fixture, "update_work_item", { workItemId: itemId, expectedVersion: 2, dependencyIds: [branded("missing")] })).toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(fixture.database.prepare("SELECT depends_on_work_item_id FROM wg_v2_work_item_dependencies WHERE work_item_id = ?").all(itemId)).toEqual([{ depends_on_work_item_id: dependencyId }])
  })

  it("persists visibility and localizes Decision mutations to affected rows", async () => {
    const fixture = await setup()
    const streamId = await createStream(fixture)
    const first = await createItem(fixture, streamId, undefined, "First")
    const second = await createItem(fixture, streamId, undefined, "Second")
    expect(await execute(fixture, "set_stream_visibility", { streamId, expectedVersion: 1, visibility: "archived" })).toMatchObject({ ok: true })
    const proposed = await execute(fixture, "propose_decision", {
      streamId,
      question: "Ship?",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      recommendationOptionId: "yes",
      affectedWorkItemIds: [first],
    })
    const decisionId = resultId(proposed, "decisionId")
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_decision_work_items WHERE decision_id = ?").get(decisionId)).toEqual({ count: 1 })
    expect(fixture.database.prepare("SELECT row_version FROM wg_v2_work_items WHERE id = ?").get(second)).toEqual({ row_version: 1 })
    expect(await execute(fixture, "answer_decision", { decisionId, expectedVersion: 1, optionId: "yes" })).toMatchObject({ ok: true })
    expect(await execute(fixture, "dismiss_decision", { decisionId, expectedVersion: 2, reason: "late" })).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
  })

  it("enforces semantic Outcome close/reopen guards and preserves provenance", async () => {
    const fixture = await setup()
    const streamId = await createStream(fixture)
    const outcomeId = await createOutcome(fixture, streamId)
    fixture.database.prepare("UPDATE wg_v2_outcomes SET lifecycle = 'ready_to_close' WHERE id = ?").run(outcomeId)
    expect(await execute(fixture, "close_outcome", { outcomeId, expectedVersion: 1, reason: "Done" })).toMatchObject({ ok: false, error: { code: "blocked" } })
    await execute(fixture, "record_evidence", {
      subject: { type: "outcome", outcomeId },
      requirementId: branded("owner"),
      evidence: { kind: "owner_confirmation", summary: "Approved", confirmed: true },
    })
    expect(await execute(fixture, "close_outcome", { outcomeId, expectedVersion: 1, reason: "Done" })).toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle, close_reason, closed_by_json FROM wg_v2_outcomes WHERE id = ?").get(outcomeId)).toMatchObject({ lifecycle: "completed", close_reason: "Done" })
    expect(await execute(fixture, "reopen_outcome", { outcomeId, expectedVersion: 2, reason: "More work" })).toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle, reopen_reason FROM wg_v2_outcomes WHERE id = ?").get(outcomeId)).toEqual({ lifecycle: "reopened", reopen_reason: "More work" })
  })

  it("closes a Stream and abandons only unfinished work with the supplied reason", async () => {
    const fixture = await setup()
    const streamId = await createStream(fixture)
    const unfinished = await createItem(fixture, streamId, undefined, "Unfinished")
    const completed = await createItem(fixture, streamId, undefined, "Completed")
    fixture.database.prepare("UPDATE wg_v2_work_items SET lifecycle = 'completed' WHERE id = ?").run(completed)
    expect(await execute(fixture, "close_stream", { streamId, expectedVersion: 1, reason: "Scope changed" })).toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle, abandoned_reason FROM wg_v2_work_items WHERE id = ?").get(unfinished)).toEqual({ lifecycle: "abandoned", abandoned_reason: "Scope changed" })
    expect(fixture.database.prepare("SELECT lifecycle, abandoned_reason FROM wg_v2_work_items WHERE id = ?").get(completed)).toEqual({ lifecycle: "completed", abandoned_reason: null })
  })

  it("cancels a single Work Item into the abandoned lifecycle and guards terminal/version", async () => {
    const fixture = await setup()
    const streamId = await createStream(fixture)
    const itemId = await createItem(fixture, streamId, undefined, "Disposable")
    expect(await execute(fixture, "cancel_work_item", { workItemId: itemId, expectedVersion: 1, reason: "No longer needed" })).toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle, abandoned_reason FROM wg_v2_work_items WHERE id = ?").get(itemId)).toEqual({ lifecycle: "abandoned", abandoned_reason: "No longer needed" })
    expect(await execute(fixture, "cancel_work_item", { workItemId: itemId, expectedVersion: 2, reason: "again" })).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
    const other = await createItem(fixture, streamId, undefined, "Other")
    expect(await execute(fixture, "cancel_work_item", { workItemId: other, expectedVersion: 99, reason: "stale" })).toMatchObject({ ok: false, error: { code: "version_conflict" } })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(other)).toMatchObject({ lifecycle: expect.not.stringMatching("abandoned") })

    const live = await createItem(fixture, streamId, undefined, "Running")
    fixture.database.prepare(`
      INSERT INTO wg_v2_attempts
        (owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle, resolved_execution_profile_json, created_at, updated_at)
      VALUES ('owner', 'attempt_running', ?, ?, 1, 'running', '{}', 1000, 1000)
    `).run(streamId, live)
    fixture.database.prepare(`
      INSERT INTO wg_v2_leases
        (owner_user_id, id, resource_type, resource_id, holder_id, expires_at, created_at, updated_at)
      VALUES ('owner', 'lease_running', 'work_item', ?, 'attempt_running', 999999, 1000, 1000)
    `).run(live)
    expect(await execute(fixture, "cancel_work_item", { workItemId: live, expectedVersion: 1, reason: "unsafe" })).toMatchObject({
      ok: false,
      error: { code: "blocked" },
    })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_work_items WHERE id = ?").get(live)).toEqual({ lifecycle: "pending" })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_attempts WHERE id = 'attempt_running'").get()).toEqual({ lifecycle: "running" })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_leases WHERE id = 'lease_running'").get()).toEqual({ count: 1 })
  })

  it("admits only an exact current source head and applies selected proposed work once", async () => {
    const fixture = await setup()
    const source = await execute(fixture, "create_work_source", { title: "Plan", content: "One" })
    const workSourceId = resultId(source, "workSourceId")
    const revisionId = resultId(source, "revisionId")
    const sourceRef = { workSourceId, revisionId, contentHash: createHash("sha256").update("One").digest("hex") } as WorkSourceRevisionRef
    const proposed = await execute(fixture, "propose_admission", { source: sourceRef })
    const proposalId = resultId(proposed, "proposalId")
    fixture.database.prepare(`
      INSERT INTO wg_v2_intake_candidates
        (owner_user_id, id, workgraph_id, candidate_kind, title, body, normalized_json, status, created_at, updated_at)
      VALUES ('owner', 'candidate_admission', 'workgraph_default', 'session', 'Plan', 'One', ?, 'staged', 1000, 1000)
    `).run(JSON.stringify({
      sessionId: "session_admission",
      admissionDraft: { title: "Plan", content: "One" },
      source: sourceRef,
      admissionProposalId: proposalId,
    }))
    fixture.database.prepare(`UPDATE wg_v2_admission_proposals SET intake_candidate_id = 'candidate_admission' WHERE owner_user_id = 'owner' AND id = ?`).run(proposalId)
    await publishAdmissionPlan(fixture, {
      source: sourceRef,
      suggestedPlacement: { mode: "new_stream", streamTitle: "Plan" },
      placementMatches: [],
      proposedOutcomes: [{ key: "outcome", title: "Ship", successCriteria: ["Done"], execution: { effort: "high" } }],
      proposedWorkItems: [{
        key: "item",
        outcomeKey: "outcome",
        title: "Build",
        dependencyKeys: [],
        completionContract: contract,
        execution: { effort: "medium" },
      }],
      duplicateMatches: [],
    })
    const proposedSnapshot = WorkGraphSnapshotPageSchema.parse(await fixture.adapter.service.query(owner(), "snapshot", "page", { limit: 50 }))
    expect(proposedSnapshot.records).toContainEqual(expect.objectContaining({
      recordType: "admission_proposal",
      id: proposalId,
      state: "proposed",
      version: 3,
      generation: expect.objectContaining({ method: "agent_session" }),
      suggestedPlacement: { mode: "new_stream", streamTitle: "Plan" },
    }))
    const confirmed = await execute(fixture, "confirm_admission", {
      proposalId,
      expectedVersion: 3,
      source: sourceRef,
      selection: { mode: "create", streamTitle: "Admitted" },
      outcomes: [{ proposalKey: "outcome", title: "Ship", successCriteria: ["Done"], execution: { effort: "high" } }],
      workItems: [{ proposalKey: "item", outcomeProposalKey: "outcome", title: "Build", completionContract: contract, execution: { effort: "medium" } }],
    })
    expect(confirmed).toMatchObject({ ok: true })
    expect(fixture.database.prepare("SELECT lifecycle FROM wg_v2_admission_proposals WHERE id = ?").get(proposalId)).toEqual({ lifecycle: "confirmed" })
    expect(fixture.database.prepare("SELECT status FROM wg_v2_intake_candidates WHERE id = 'candidate_admission'").get()).toEqual({ status: "confirmed" })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_work_items WHERE owner_user_id = 'owner'").get()).toEqual({ count: 1 })
    expect(fixture.database.prepare("SELECT execution_defaults_json FROM wg_v2_outcomes WHERE owner_user_id = 'owner'").get()).toEqual({ execution_defaults_json: '{"effort":"high"}' })
    expect(fixture.database.prepare("SELECT execution_overrides_json FROM wg_v2_work_items WHERE owner_user_id = 'owner'").get()).toEqual({ execution_overrides_json: '{"effort":"medium"}' })
    const snapshot = WorkGraphSnapshotPageSchema.parse(await fixture.adapter.service.query(owner(), "snapshot", "page", { limit: 50 }))
    expect(snapshot.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: "admission_proposal", id: proposalId, source: sourceRef }),
      expect.objectContaining({ recordType: "stream", sourceRevisionRefs: [sourceRef] }),
    ]))
    expect(ChangeEnvelopeSchema.array().parse(await fixture.adapter.service.query(owner(), "changes", "list", { limit: 50 })).at(-1)).toMatchObject({
      resource: { type: "stream" },
      event: { type: "admission_confirmed" },
    })
    expect(await execute(fixture, "confirm_admission", {
      proposalId,
      expectedVersion: 4,
      source: sourceRef,
      selection: { mode: "create", streamTitle: "Again" },
    })).toMatchObject({ ok: false, error: { code: "invalid_transition" } })

    const revised = await execute(fixture, "revise_work_source", { workSourceId, expectedRevisionId: revisionId, content: "Two" })
    expect(await execute(fixture, "propose_admission", { source: sourceRef })).toMatchObject({ ok: false, error: { code: "version_conflict" } })
    expect(resultId(revised, "revisionId")).not.toBe(revisionId)
  })

  it("dismisses and reopens only a reviewable proposal without changing its plan or source binding", async () => {
    const fixture = await setup()
    const content = "Organize the launch plan"
    const source = await execute(fixture, "create_work_source", { title: "Launch", content })
    const sourceRef = {
      workSourceId: resultId(source, "workSourceId"),
      revisionId: resultId(source, "revisionId"),
      contentHash: createHash("sha256").update(content).digest("hex"),
    } as WorkSourceRevisionRef
    const proposalId = resultId(await execute(fixture, "propose_admission", { source: sourceRef }), "proposalId")

    await expect(execute(fixture, "dismiss_admission", { proposalId: branded("missing"), expectedVersion: 1 }))
      .resolves.toMatchObject({ ok: false, error: { code: "not_found" } })
    await expect(execute(fixture, "reopen_admission", { proposalId: branded("missing"), expectedVersion: 1 }))
      .resolves.toMatchObject({ ok: false, error: { code: "not_found" } })
    await expect(execute(fixture, "dismiss_admission", { proposalId, expectedVersion: 1 }))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_transition" } })

    fixture.database.prepare(`
      INSERT INTO wg_v2_intake_candidates
        (owner_user_id, id, workgraph_id, candidate_kind, title, body, normalized_json, status, created_at, updated_at)
      VALUES ('owner', 'candidate_review', 'workgraph_default', 'session', 'Launch', ?, ?, 'staged', 1000, 1000)
    `).run(content, JSON.stringify({
      sessionId: "session_review",
      admissionDraft: { title: "Launch", content },
      source: sourceRef,
      admissionProposalId: proposalId,
    }))
    fixture.database.prepare(`
      UPDATE wg_v2_admission_proposals SET intake_candidate_id = 'candidate_review'
      WHERE owner_user_id = 'owner' AND id = ?
    `).run(proposalId)
    await publishAdmissionPlan(fixture, {
      source: sourceRef,
      suggestedPlacement: { mode: "new_stream", streamTitle: "Launch" },
      placementMatches: [],
      proposedOutcomes: [],
      proposedWorkItems: [{ key: "ship", title: "Ship", dependencyKeys: [], completionContract: contract, execution: {} }],
      duplicateMatches: [],
    })
    const original = fixture.database.prepare(`
      SELECT source_revision_id, intake_candidate_id, lifecycle, proposed_work_json, row_version
      FROM wg_v2_admission_proposals WHERE owner_user_id = 'owner' AND id = ?
    `).get(proposalId)
    expect(original).toMatchObject({
      source_revision_id: sourceRef.revisionId,
      intake_candidate_id: "candidate_review",
      lifecycle: "proposed",
      row_version: 3,
    })

    await expect(execute(fixture, "dismiss_admission", { proposalId, expectedVersion: 2 }))
      .resolves.toMatchObject({ ok: false, error: { code: "version_conflict" } })
    const dismissRequest = {
      operationId: operation("dismiss_review_once"),
      command: { version: 1 as const, type: "dismiss_admission" as const, proposalId, expectedVersion: 3 },
    }
    const dismissed = await fixture.adapter.service.execute(owner(), dismissRequest)
    expect(dismissed).toMatchObject({ ok: true, value: { proposalId, version: 4 } })
    expect(await fixture.adapter.service.execute(owner(), dismissRequest)).toEqual(dismissed)
    await expect(fixture.adapter.service.execute(owner(), {
      ...dismissRequest,
      command: { ...dismissRequest.command, expectedVersion: 4 },
    })).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } })
    expect(fixture.database.prepare(`
      SELECT source_revision_id, intake_candidate_id, lifecycle, proposed_work_json, row_version
      FROM wg_v2_admission_proposals WHERE owner_user_id = 'owner' AND id = ?
    `).get(proposalId)).toEqual({ ...original as object, lifecycle: "dismissed", row_version: 4 })
    await expect(execute(fixture, "dismiss_admission", { proposalId, expectedVersion: 4 }))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_transition" } })
    await expect(execute(fixture, "reopen_admission", { proposalId, expectedVersion: 3 }))
      .resolves.toMatchObject({ ok: false, error: { code: "version_conflict" } })

    const reopenRequest = {
      operationId: operation("reopen_review_once"),
      command: { version: 1 as const, type: "reopen_admission" as const, proposalId, expectedVersion: 4 },
    }
    const reopened = await fixture.adapter.service.execute(owner(), reopenRequest)
    expect(reopened).toMatchObject({ ok: true, value: { proposalId, version: 5 } })
    expect(await fixture.adapter.service.execute(owner(), reopenRequest)).toEqual(reopened)
    expect(fixture.database.prepare(`
      SELECT source_revision_id, intake_candidate_id, lifecycle, proposed_work_json, row_version
      FROM wg_v2_admission_proposals WHERE owner_user_id = 'owner' AND id = ?
    `).get(proposalId)).toEqual({ ...original as object, lifecycle: "proposed", row_version: 5 })
    expect(fixture.database.prepare("SELECT status, row_version FROM wg_v2_intake_candidates WHERE id = 'candidate_review'").get())
      .toEqual({ status: "staged", row_version: 1 })

    const snapshot = WorkGraphSnapshotPageSchema.parse(await fixture.adapter.service.query(owner(), "snapshot", "page", { limit: 50 }))
    expect(snapshot.records).toContainEqual(expect.objectContaining({
      recordType: "admission_proposal",
      id: proposalId,
      state: "proposed",
      version: 5,
      source: sourceRef,
    }))
    const changes = ChangeEnvelopeSchema.array().parse(await fixture.adapter.service.query(owner(), "changes", "list", { limit: 50 }))
    expect(changes.slice(-2)).toMatchObject([
      { resource: { type: "admission_proposal", id: proposalId }, event: { type: "admission_dismissed" } },
      { resource: { type: "admission_proposal", id: proposalId }, event: { type: "admission_reopened" } },
    ])

    const malformedId = resultId(await execute(fixture, "propose_admission", { source: sourceRef }), "proposalId")
    fixture.database.prepare(`
      UPDATE wg_v2_admission_proposals SET lifecycle = 'proposed', proposed_work_json = ?
      WHERE owner_user_id = 'owner' AND id = ?
    `).run(JSON.stringify({
      source: sourceRef,
      generation: { method: "agent_session", sessionId: " ", generatedAt: 2 },
      suggestedPlacement: { mode: "new_stream", streamTitle: "Launch" },
      placementMatches: [],
      outcomes: [],
      workItems: [{ proposalKey: "ship", title: "Ship", dependencyProposalKeys: [], completionContract: contract, execution: {} }],
      duplicateMatches: [],
    }), malformedId)
    await expect(execute(fixture, "dismiss_admission", { proposalId: malformedId, expectedVersion: 1 }))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_transition" } })
  })

  it("plans source admission against recent personal Streams and reviews duplicates", async () => {
    const fixture = await setup()
    const streamId = resultId(await execute(fixture, "create_stream", { title: "Ship Claxedo Cloud" }), "streamId") as StreamID
    const outcomeId = resultId(await execute(fixture, "create_outcome", {
      streamId,
      title: "Ship Claxedo Cloud",
      successCriteria: ["Cloud is live"],
    }), "outcomeId")
    await createItem(fixture, streamId, outcomeId, "Deploy cloud API")

    const otherStream = await fixture.adapter.service.execute(owner("other"), {
      operationId: operation("other_stream"),
      command: { version: 1, type: "create_stream", title: "Ship Claxedo Cloud" },
    })
    const otherStreamId = resultId(otherStream as Awaited<ReturnType<typeof execute>>, "streamId") as StreamID
    await fixture.adapter.service.execute(owner("other"), {
      operationId: operation("other_item"),
      command: {
        version: 1,
        type: "create_work_item",
        streamId: otherStreamId,
        title: "Ship Claxedo Cloud",
        completionContract: contract,
      },
    })

    const content = "- Deploy cloud API\n- Verify production launch"
    const source = await execute(fixture, "create_work_source", { title: "Ship Claxedo Cloud", content })
    const sourceRef = {
      workSourceId: resultId(source, "workSourceId"),
      revisionId: resultId(source, "revisionId"),
      contentHash: createHash("sha256").update(content).digest("hex"),
    } as WorkSourceRevisionRef
    const proposalId = resultId(await execute(fixture, "propose_admission", { source: sourceRef }), "proposalId")
    const evidence = admissionPlanningEvidence(fixture, proposalId)
    await publishAdmissionPlan(fixture, {
      source: sourceRef,
      suggestedPlacement: { mode: "existing", streamId },
      placementMatches: evidence.placementMatches,
      proposedOutcomes: [{ key: "cloud", title: "Ship Claxedo Cloud", successCriteria: ["Cloud is live"], execution: {} }],
      proposedWorkItems: [
        { key: "deploy", outcomeKey: "cloud", title: "Deploy cloud API", dependencyKeys: [], completionContract: contract, execution: {} },
        { key: "verify", outcomeKey: "cloud", title: "Verify production launch", dependencyKeys: ["deploy"], completionContract: contract, execution: {} },
      ],
      duplicateMatches: evidence.duplicateMatches,
    })
    const snapshot = WorkGraphSnapshotPageSchema.parse(await fixture.adapter.service.query(owner(), "snapshot", "page", { limit: 50 }))
    const proposal = snapshot.records.find((record) => record.recordType === "admission_proposal" && record.id === proposalId)
    expect(proposal).toMatchObject({
      state: "proposed",
      generation: expect.objectContaining({ method: "agent_session" }),
      suggestedPlacement: { mode: "existing", streamId },
      placementMatches: [expect.objectContaining({ streamId, confidence: "high", evidence: expect.any(Array) })],
      proposedOutcomes: [expect.objectContaining({ title: "Ship Claxedo Cloud" })],
      proposedWorkItems: [
        expect.objectContaining({ title: "Deploy cloud API" }),
        expect.objectContaining({ title: "Verify production launch" }),
      ],
      duplicateMatches: expect.arrayContaining([
        expect.objectContaining({ subject: { type: "outcome", outcomeId }, streamId, state: "active" }),
      ]),
    })
    expect(proposal?.recordType === "admission_proposal" && proposal.state === "proposed" && proposal.duplicateMatches.every((match) => match.streamId !== otherStreamId)).toBe(true)
  })

  it("rejects a longer admission dependency cycle without materializing work", async () => {
    const fixture = await setup()
    const content = "Plan cyclic work"
    const source = await execute(fixture, "create_work_source", { title: "Cycle", content })
    const sourceRef = {
      workSourceId: resultId(source, "workSourceId"),
      revisionId: resultId(source, "revisionId"),
      contentHash: createHash("sha256").update(content).digest("hex"),
    } as WorkSourceRevisionRef
    const proposalId = resultId(await execute(fixture, "propose_admission", { source: sourceRef }), "proposalId")
    await publishAdmissionPlan(fixture, {
      source: sourceRef,
      suggestedPlacement: { mode: "new_stream", streamTitle: "Cycle" },
      placementMatches: [],
      proposedOutcomes: [],
      proposedWorkItems: [],
      duplicateMatches: [],
    })
    await expect(execute(fixture, "confirm_admission", {
      proposalId,
      expectedVersion: 3,
      source: sourceRef,
      selection: { mode: "create", streamTitle: "Cycle" },
      workItems: [
        { proposalKey: "a", title: "A", dependencyProposalKeys: ["b"], completionContract: contract },
        { proposalKey: "b", title: "B", dependencyProposalKeys: ["c"], completionContract: contract },
        { proposalKey: "c", title: "C", dependencyProposalKeys: ["a"], completionContract: contract },
      ],
    })).resolves.toMatchObject({ ok: false, error: { code: "validation_error", message: "Admission Work Item dependencies contain a cycle" } })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_work_items").get()).toEqual({ count: 0 })
  })

  it("truthfully exposes the remaining runtime-only command gap", () => {
    expect(SQLITE_WORKGRAPH_UNSUPPORTED_COMMANDS).toEqual(["execute_stream", "execute_work_item", "cancel_attempt", "retry_work_item"])
    expect(SQLITE_WORKGRAPH_SUPPORTED_COMMANDS).toEqual(expect.arrayContaining([
      "dismiss_admission",
      "reopen_admission",
      "confirm_admission",
      "close_stream",
      "answer_decision",
    ]))
  })

  it("serves strict owner-scoped HTTP records and rejects unavailable execution without persistence", async () => {
    const fixture = await setup()
    await execute(fixture, "create_work_source", { title: "Plan", content: "Text" })
    const streamId = await createStream(fixture)

    const stream = await fixture.adapter.service.query(owner(), "streams", "read", { streamId })
    expect(StreamDtoSchema.parse(stream)).toMatchObject({ recordType: "stream", ownerUserId: "owner", visibility: "visible" })
    const snapshot = await fixture.adapter.service.query(owner(), "snapshot", "page", { limit: 50 })
    expect(WorkGraphSnapshotPageSchema.parse(snapshot)).toMatchObject({ snapshotCursor: "2" })
    expect(WorkGraphSnapshotPageSchema.parse(snapshot).records).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: "workgraph", id: "workgraph_default" }),
      expect.objectContaining({ recordType: "stream", id: streamId }),
    ]))
    const changes = await fixture.adapter.service.query(owner(), "changes", "list", { limit: 50 })
    expect(ChangeEnvelopeSchema.array().parse(changes).map((change) => change.cursor)).toEqual(["1", "2"])

    const rowsBefore = fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_operation_results").get()
    expect(await execute(fixture, "execute_stream", { streamId, executionMode: "autonomous" })).toMatchObject({
      ok: false,
      error: { code: "execution_unavailable" },
    })
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM wg_v2_operation_results").get()).toEqual(rowsBefore)
  })

  it("serves owner-bound bounded Attention pages from canonical records", async () => {
    const fixture = await setup()
    const streamId = await createStream(fixture)
    const itemId = await createItem(fixture, streamId, undefined, "Review release")
    fixture.database.prepare("UPDATE wg_v2_work_items SET lifecycle = 'review_needed', updated_at = 9_000 WHERE owner_user_id = 'owner' AND id = ?")
      .run(itemId)
    fixture.database.prepare(`
      INSERT INTO wg_v2_intake_candidates
        (owner_user_id, id, workgraph_id, candidate_kind, title, status, created_at, updated_at)
      VALUES ('owner', 'candidate_issue', 'workgraph_default', 'external_issue', 'Issue', 'unorganized', 7000, 7000),
        ('owner', 'candidate_session', 'workgraph_default', 'session', 'Session', 'unorganized', 8000, 8000)
    `).run()

    const first = AttentionPageSchema.parse(await fixture.adapter.service.query(owner(), "attention", "list", { limit: 1 }))
    expect(first).toMatchObject({ total: 2, hasMore: true, items: [{ kind: "work_item", id: itemId, record: { state: "review_needed" } }] })
    const second = AttentionPageSchema.parse(await fixture.adapter.service.query(owner(), "attention", "list", { limit: 1, after: first.nextCursor }))
    expect(second).toMatchObject({ total: 2, hasMore: false, items: [{ kind: "unorganized_ai_work", counts: { externalIssues: 1, sessions: 1, total: 2 } }] })
    await expect(fixture.adapter.service.query(owner("other"), "attention", "list", { limit: 1, after: first.nextCursor }))
      .rejects.toBeInstanceOf(AttentionCursorError)
  })
})

async function setup() {
  const database = new BetterSqlite3(":memory:")
  databases.push(database)
  let id = 0
  let now = 1_000
  return { database, adapter: createSqliteWorkGraphService({ database, clock: { now: () => now++ }, ids: { next: (kind) => `${kind}_${++id}` } }) }
}

function execute(fixture: Awaited<ReturnType<typeof setup>>, type: string, command: Record<string, unknown>) {
  return fixture.adapter.service.execute(owner(), { operationId: operation(`operation_${crypto.randomUUID()}`), command: { version: 1, type, ...command } } as never)
}

async function createStream(fixture: Awaited<ReturnType<typeof setup>>) {
  return resultId(await execute(fixture, "create_stream", { title: "Stream" }), "streamId") as StreamID
}

async function createOutcome(fixture: Awaited<ReturnType<typeof setup>>, streamId: string) {
  return resultId(await execute(fixture, "create_outcome", { streamId, title: "Outcome", successCriteria: ["Done"] }), "outcomeId")
}

async function createItem(fixture: Awaited<ReturnType<typeof setup>>, streamId: string, outcomeId: string | undefined, title: string) {
  return resultId(await execute(fixture, "create_work_item", { streamId, ...(outcomeId ? { outcomeId } : {}), title, completionContract: contract }), "workItemId")
}

async function publishAdmissionPlan(fixture: Awaited<ReturnType<typeof setup>>, plan: AdmissionAgentPlan) {
  await expect(execute(fixture, "update_workgraph_defaults", {
    expectedVersion: 1,
    defaults: { execution: planningProfile, recap: {} },
  })).resolves.toMatchObject({ ok: true })
  const runtime = createSqliteSourcePlanningRuntime({
    database: fixture.database,
    workerId: "test-source-planner",
    sessions: {
      async admit(input) { return String(input.sessionId) },
      async result() { return { state: "succeeded", summary: JSON.stringify(plan), artifacts: [] } },
    },
  })
  await expect(runtime.runDue(owner())).resolves.toMatchObject({ state: "completed" })
}

function admissionPlanningEvidence(fixture: Awaited<ReturnType<typeof setup>>, proposalId: string) {
  const row = fixture.database.prepare("SELECT proposed_work_json FROM wg_v2_admission_proposals WHERE owner_user_id = 'owner' AND id = ?")
    .get(proposalId) as { proposed_work_json: string }
  return (JSON.parse(row.proposed_work_json) as {
    planningEvidence: Pick<AdmissionAgentPlan, "placementMatches" | "duplicateMatches">
  }).planningEvidence
}

function resultId(result: Awaited<ReturnType<typeof execute>>, key: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error(`Expected ${key}`)
  const value = result.value[key]
  if (typeof value !== "string") throw new Error(`Expected ${key}`)
  return value
}

function operation(value: string) { return branded<OperationID>(value) }
function branded<Type = string>(value: string) { return value as Type }
function owner(id = "owner"): WorkGraphContext {
  return { ownerUserId: branded(id), actor: { type: "user", id: branded(id) }, requestId: branded(`request_${id}`), access: { mode: "owner" } }
}
