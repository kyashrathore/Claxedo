import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AdmissionAgentPlan } from "@claxedo/workgraph/contracts"
import { createChangeCursor, createSnapshotResumeCursor } from "@claxedo/workgraph/contracts"
import {
  claimSourcePlans,
  completeSourcePlan,
  enqueueIndependentSessionIntake,
  failSourcePlan,
  listRunningSourcePlans,
  markSourcePlanSession,
  retrySourcePlanLaunch,
} from "../../../../../convex/workgraphBackground"
import { appendSourceRevision } from "../../../../../convex/workgraphCommands"
import { readWorkGraphProjection } from "../../../../../convex/workgraphChanges"

beforeEach(() => {
  vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
})

afterEach(() => vi.unstubAllEnvs())

describe("hosted WorkGraph background jobs", () => {
  test("keeps confirmed source revisions on existing Streams without duplicating exact revisions", () => {
    const first = { work_source_id: "source-a", revision_id: "revision-1", content_hash: "hash-1" }
    const second = { work_source_id: "source-a", revision_id: "revision-2", content_hash: "hash-2" }
    expect(appendSourceRevision([first], second)).toEqual([first, second])
    expect(appendSourceRevision([first, second], second)).toEqual([first, second])
  })

  test("enqueues meaningful independent Sessions once and excludes WorkGraph execution Sessions", async () => {
    const db = new BackgroundDb({ workgraph_runs: [], workgraph_due_jobs: [] })
    const context = { db } as never
    const input = {
      organizationId: "org-a" as never,
      ownerUserId: "user-a" as never,
      sessionId: "session-independent",
      title: "Launch planning",
      summary: "Billing remains.",
      observedAt: 10,
    }

    await expect(enqueueIndependentSessionIntake(context, input)).resolves.toBe("created")
    await expect(enqueueIndependentSessionIntake(context, input)).resolves.toBe("existing")
    db.rows.workgraph_runs.push({
      _id: "run-row",
      organization_id: "org-a",
      owner_user_id: "user-a",
      session_id: "session-workgraph",
    })
    await expect(enqueueIndependentSessionIntake(context, { ...input, sessionId: "session-workgraph" })).resolves.toBe(
      "ignored",
    )
    expect(db.rows.workgraph_due_jobs).toHaveLength(1)
  })

















  test("claims an exact source revision and publishes one fenced agent proposal", async () => {
    const db = sourcePlanningDb()
    const claims = (await handler(claimSourcePlans)({ db } as never, {
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    })) as Array<Record<string, any>>
    expect(claims).toEqual([
      expect.objectContaining({
        ownerUserId: "user-a",
        orgId: "org-a",
        jobId: "source-plan-job",
        leaseEpoch: 1,
        queueLagMs: 9,
        activeLeaseAgeMs: 0,
        expiredRecovery: false,
        retryCount: 0,
        profile: {
          agent: "planner-agent",
          model: { providerId: "openai", modelId: "gpt-5" },
          effort: "high",
          tools: [],
        },
        prompt: expect.stringContaining('"revisionId":"revision-a"'),
      }),
    ])
    await expect(
      handler(markSourcePlanSession)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        job_id: "source-plan-job",
        lease_epoch: 1,
        worker_id: "worker-a",
        workspace_id: "workspace-a",
        session_id: "session-a",
        admission_confirmed: false,
        now: 11,
      }),
    ).resolves.toEqual({ settled: true })
    await expect(
      handler(markSourcePlanSession)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        job_id: "source-plan-job",
        lease_epoch: 1,
        worker_id: "worker-a",
        workspace_id: "workspace-a",
        session_id: "session-a",
        admission_confirmed: true,
        now: 12,
      }),
    ).resolves.toEqual({ settled: true })
    await expect(
      handler(completeSourcePlan)({ db } as never, {
        owner_user_id: "user-a",
        service_token: "service-secret",
        job_id: "source-plan-job",
        lease_epoch: 1,
        session_id: "session-a",
        plan: sourceAgentPlan(),
        now: 13,
      }),
    ).resolves.toEqual({ settled: true })
    await expect(
      handler(completeSourcePlan)({ db } as never, {
        owner_user_id: "user-a",
        service_token: "service-secret",
        job_id: "source-plan-job",
        lease_epoch: 1,
        session_id: "session-a",
        plan: sourceAgentPlan(),
        now: 13,
      }),
    ).resolves.toEqual({ settled: false })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "proposed",
      row_version: 3,
      generation: { method: "agent_session", sessionId: "session-a", generatedAt: 13 },
      proposed_outcomes: [expect.objectContaining({ execution: { effort: "high" } })],
      proposed_work_items: [expect.objectContaining({ completionContract: expect.objectContaining({ version: 1 }) })],
    })
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({ status: "completed" })
    expect(db.rows.workgraph_changes).toEqual([
      expect.objectContaining({
        cursor: 1,
        resource_type: "admission_proposal",
        resource_id: "proposal-a",
        change_type: "admission_proposal_updated",
        payload: expect.objectContaining({
          proposalId: "proposal-a",
          version: 2,
          generation: expect.objectContaining({ method: "planning", tryNumber: 1 }),
        }),
      }),
      expect.objectContaining({
        cursor: 2,
        resource_type: "admission_proposal",
        resource_id: "proposal-a",
        change_type: "admission_proposal_updated",
        payload: expect.objectContaining({
          proposalId: "proposal-a",
          version: 3,
          generation: { method: "agent_session", sessionId: "session-a" },
        }),
      }),
    ])
    expect(db.rows.workgraph_events).toEqual([
      expect.objectContaining({
        event_type: "admission_proposal_updated",
        operation_id: "source_plan_publish_proposal-a_2",
      }),
      expect.objectContaining({
        event_type: "admission_proposal_updated",
        operation_id: "source_plan_publish_proposal-a_3",
      }),
    ])
  })

  test("publishes the exact existing Stream selected by bounded hosted planning evidence", async () => {
    const db = targetedSourcePlanningDb()
    const [claim] = await startSourcePlanningSession(db)
    expect(claim).toMatchObject({
      prompt: expect.stringContaining('"targetStreamId":"stream-target"'),
    })
    expect(claim.prompt).toContain("suggestedPlacement must be existing with that exact Stream ID")
    const plan = sourceAgentPlan()
    plan.suggestedPlacement = { mode: "existing", streamId: "stream-target" as never }

    await expect(
      handler(completeSourcePlan)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        job_id: "source-plan-job",
        lease_epoch: 1,
        session_id: "session-a",
        plan,
        now: 13,
      }),
    ).resolves.toEqual({ settled: true })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "proposed",
      suggested_placement: { mode: "existing", streamId: "stream-target" },
      generation: { method: "agent_session", sessionId: "session-a", generatedAt: 13 },
    })
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({ status: "completed" })
  })

  test.each([
    ["a new Stream", { mode: "new_stream", streamTitle: "Incorrect replacement" }],
    ["another existing Stream", { mode: "existing", streamId: "stream-different" }],
  ] as const)(
    "publishes planning_failed instead of substituting %s for an explicit hosted target",
    async (_label, suggestedPlacement) => {
      const db = targetedSourcePlanningDb()
      await startSourcePlanningSession(db)
      const plan = sourceAgentPlan()
      plan.suggestedPlacement = suggestedPlacement as AdmissionAgentPlan["suggestedPlacement"]

      await expect(
        handler(completeSourcePlan)({ db } as never, {
          service_token: "service-secret",
          owner_user_id: "user-a",
          job_id: "source-plan-job",
          lease_epoch: 1,
          session_id: "session-a",
          plan,
          now: 13,
        }),
      ).resolves.toEqual({ settled: true })
      expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
        state: "planning_failed",
        suggested_placement: undefined,
        proposed_outcomes: undefined,
        proposed_work_items: undefined,
        generation: {
          method: "planning_failed",
          tryNumber: 1,
          reason: "Source planning result did not honor the exact target Stream",
          failedAt: 13,
          retryable: true,
        },
      })
      expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
        status: "failed",
        last_error: "Source planning result did not honor the exact target Stream",
      })
      expect(db.rows.workgraph_changes.at(-1)).toMatchObject({
        change_type: "admission_proposal_updated",
        payload: expect.objectContaining({ generation: expect.objectContaining({ method: "planning_failed" }) }),
      })
    },
  )

  test("fences hosted source-plan publication after the source head changes", async () => {
    const db = sourcePlanningDb()
    await handler(claimSourcePlans)({ db } as never, {
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    })
    const job = db.rows.workgraph_due_jobs[0]!
    await handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret",
      owner_user_id: "user-a",
      job_id: "source-plan-job",
      lease_epoch: 1,
      worker_id: "worker-a",
      workspace_id: "workspace-a",
      session_id: "session-a",
      admission_confirmed: false,
      now: 11,
    })
    await handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret",
      owner_user_id: "user-a",
      job_id: "source-plan-job",
      lease_epoch: 1,
      worker_id: "worker-a",
      workspace_id: "workspace-a",
      session_id: "session-a",
      admission_confirmed: true,
      now: 12,
    })
    db.rows.work_sources[0]!.latest_revision_id = "revision-b"
    await expect(
      handler(completeSourcePlan)({ db } as never, {
        owner_user_id: "user-a",
        service_token: "service-secret",
        job_id: "source-plan-job",
        lease_epoch: 1,
        session_id: "session-a",
        plan: sourceAgentPlan(),
        now: 13,
      }),
    ).resolves.toEqual({ settled: false })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning_failed",
      row_version: 3,
      generation: {
        method: "planning_failed",
        tryNumber: 1,
        reason: "Source revision or proposal is no longer current",
        failedAt: 13,
        retryable: false,
      },
    })
    expect(job).toMatchObject({ status: "cancelled" })
  })

  test("reclaims an indeterminate hosted prompt with the same Session and hides it from result polling until confirmed", async () => {
    const db = sourcePlanningDb()
    const job = db.rows.workgraph_due_jobs[0]!
    Object.assign(job, {
      status: "running",
      claimed_by: "worker-before",
      claim_expires_at: 1,
      lease_epoch: 1,
      payload: { ...job.payload, workspaceId: "workspace-a", sessionId: "session-a", sessionAdmissionConfirmed: false },
    })
    const claims = (await handler(claimSourcePlans)({ db } as never, {
      service_token: "service-secret",
      worker_id: "worker-after",
      now: 10,
      limit: 10,
    })) as Array<Record<string, unknown>>
    expect(claims).toEqual([expect.objectContaining({ leaseEpoch: 2, sessionId: "session-a" })])
    await expect(
      handler(listRunningSourcePlans)({ db } as never, {
        service_token: "service-secret",
        now: 10,
        limit: 10,
      }),
    ).resolves.toEqual([])
    ;(job.payload as Record<string, unknown>).sessionAdmissionConfirmed = true
    await expect(
      handler(listRunningSourcePlans)({ db } as never, {
        service_token: "service-secret",
        now: 10,
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ sessionId: "session-a", leaseEpoch: 2 })])
  })

  test("rejects a two-node hosted agent dependency cycle before proposal publication", async () => {
    const db = sourcePlanningDb()
    await handler(claimSourcePlans)({ db } as never, {
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    })
    const job = db.rows.workgraph_due_jobs[0]!
    await handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret",
      owner_user_id: "user-a",
      job_id: "source-plan-job",
      lease_epoch: 1,
      worker_id: "worker-a",
      workspace_id: "workspace-a",
      session_id: "session-a",
      admission_confirmed: false,
      now: 11,
    })
    await handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret",
      owner_user_id: "user-a",
      job_id: "source-plan-job",
      lease_epoch: 1,
      worker_id: "worker-a",
      workspace_id: "workspace-a",
      session_id: "session-a",
      admission_confirmed: true,
      now: 12,
    })
    const plan = sourceAgentPlan()
    plan.proposedWorkItems.push({
      ...plan.proposedWorkItems[0]!,
      key: "verify",
      title: "Verify",
      dependencyKeys: ["deploy"],
    })
    plan.proposedWorkItems[0]!.dependencyKeys = ["verify"]
    await expect(
      handler(completeSourcePlan)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        job_id: "source-plan-job",
        lease_epoch: 1,
        session_id: "session-a",
        plan,
        now: 13,
      }),
    ).rejects.toThrow("dependency cycle")
    await expect(
      handler(failSourcePlan)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        job_id: "source-plan-job",
        lease_epoch: 1,
        session_id: "session-a",
        reason: "Source planning result contains a dependency cycle",
        now: 13,
      }),
    ).resolves.toEqual({ settled: true })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning_failed",
      row_version: 3,
      generation: { method: "planning_failed", tryNumber: 1, retryable: true, failedAt: 13 },
    })
    expect(job).toMatchObject({ status: "failed", last_error: "Source planning result contains a dependency cycle" })
  })

  test("bounds hosted source planning failures at three attempts and leaves a truthful attention state", async () => {
    const db = sourcePlanningDb()
    for (const [index, now] of [10, 60_011, 120_012].entries()) {
      const [claim] = (await handler(claimSourcePlans)({ db } as never, {
        service_token: "service-secret",
        worker_id: "worker-a",
        now,
        limit: 10,
      })) as Array<Record<string, unknown>>
      expect(claim).toMatchObject({ leaseEpoch: index + 1, proposalId: "proposal-a" })
      await expect(
        handler(retrySourcePlanLaunch)({ db } as never, {
          service_token: "service-secret",
          owner_user_id: "user-a",
          job_id: "source-plan-job",
          lease_epoch: index + 1,
          worker_id: "worker-a",
          reason: "workspace unavailable",
          now: now + 1,
        }),
      ).resolves.toEqual({ settled: true })
    }
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning_failed",
      row_version: 6,
      generation: {
        method: "planning_failed",
        tryNumber: 0,
        reason: "workspace unavailable",
        retryable: true,
        failedAt: 120_013,
      },
    })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      proposed_outcomes: undefined,
      proposed_work_items: undefined,
      duplicate_matches: undefined,
    })
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      status: "failed_terminal",
      last_error: "workspace unavailable",
      payload: expect.objectContaining({ automaticFailureCount: 3 }),
    })
  })

  test("does not claim source-planning Sessions without explicit settings and terminates after bounded retries", async () => {
    const db = sourcePlanningDb()
    db.rows.workgraphs[0]!.defaults = {}
    for (const now of [10, 60_010, 120_010]) {
      await expect(
        handler(claimSourcePlans)({ db } as never, {
          service_token: "service-secret",
          worker_id: "worker-a",
          now,
          limit: 10,
        }),
      ).resolves.toEqual([])
    }
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      status: "failed_terminal",
      lease_epoch: 0,
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: "Source planning requires explicit valid agent configuration",
      payload: expect.objectContaining({
        automaticFailureCount: 3,
        configurationRequirement: { type: "generation", purpose: "source_planning", scope: { type: "workgraph" } },
      }),
    })
    expect(db.rows.workgraph_due_jobs[0]?.payload).not.toHaveProperty("sessionId")
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning_failed",
      generation: expect.objectContaining({
        method: "planning_failed",
        reason: "Source planning requires explicit valid agent configuration",
        retryable: true,
      }),
      proposed_outcomes: undefined,
      proposed_work_items: undefined,
    })
  })

  test("rejects invalid explicit source-planning settings before claiming", async () => {
    const db = sourcePlanningDb()
    db.rows.workgraphs[0]!.defaults = {
      agent: "planner-agent",
      model: { providerId: "openai", modelId: "gpt-5" },
      effort: " ",
    }
    await expect(
      handler(claimSourcePlans)({ db } as never, {
        service_token: "service-secret",
        worker_id: "worker-a",
        now: 10,
        limit: 10,
      }),
    ).resolves.toEqual([])
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      status: "failed",
      lease_epoch: 0,
      last_error: "Source planning requires explicit valid effort configuration",
      payload: expect.objectContaining({
        configurationRequirement: expect.objectContaining({ type: "generation", purpose: "source_planning" }),
      }),
    })
  })

  test("invalidates a legacy proposal before reclaiming its exact source for Session planning", async () => {
    const db = sourcePlanningDb()
    Object.assign(db.rows.workgraph_admission_proposals[0]!, {
      state: "proposed",
      suggested_placement: { mode: "new_stream", streamTitle: "Legacy" },
      placement_matches: [],
      proposed_outcomes: [{ key: "legacy", title: "Legacy result" }],
      proposed_work_items: [],
      duplicate_matches: [],
      generation: { method: "deterministic_fallback", reason: "legacy" },
    })

    await expect(
      handler(claimSourcePlans)({ db } as never, {
        service_token: "service-secret",
        worker_id: "worker-a",
        now: 10,
        limit: 10,
      }),
    ).resolves.toEqual([expect.objectContaining({ proposalId: "proposal-a", leaseEpoch: 1 })])
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning",
      row_version: 3,
      generation: { method: "planning", tryNumber: 0, queuedAt: 10 },
      planning_evidence: { placementMatches: [], duplicateMatches: [] },
    })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      suggested_placement: undefined,
      proposed_outcomes: undefined,
      proposed_work_items: undefined,
    })
    expect(db.rows.workgraph_changes).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          version: 2,
          generation: expect.objectContaining({ method: "planning_failed", tryNumber: 0, retryable: true }),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ version: 3, generation: { method: "planning", tryNumber: 0 } }),
      }),
    ])
  })

  test("quarantines an incomplete legacy proposal without publishing a fabricated source", async () => {
    const db = sourcePlanningDb()
    Object.assign(db.rows.workgraph_admission_proposals[0]!, {
      state: "proposed",
      source: undefined,
      generation: { method: "deterministic_fallback", reason: "legacy" },
    })

    await handler(claimSourcePlans)({ db } as never, {
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    })

    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({ state: "planning_failed" })
    expect(JSON.stringify(db.rows.workgraph_changes)).not.toContain("unknown_source")
  })
})

function sourcePlanningDb() {
  return new BackgroundDb({
    orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
    workgraphs: [
      {
        _id: "graph-a",
        owner_user_id: "user-a",
        id: "workgraph_default",
        defaults: { agent: "planner-agent", model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" },
      },
    ],
    work_sources: [
      {
        _id: "source-row",
        owner_user_id: "user-a",
        id: "source-a",
        title: "Ship cloud",
        latest_revision_id: "revision-a",
      },
    ],
    work_source_revisions: [
      {
        _id: "revision-row",
        owner_user_id: "user-a",
        id: "revision-a",
        work_source_id: "source-a",
        content: "Deploy cloud",
        content_hash: "a".repeat(64),
      },
    ],
    workgraph_streams: [],
    workgraph_outcomes: [],
    workgraph_work_items: [],
    workgraph_admission_proposals: [
      {
        _id: "proposal-row",
        owner_user_id: "user-a",
        id: "proposal-a",
        state: "planning",
        source: { work_source_id: "source-a", revision_id: "revision-a", content_hash: "a".repeat(64) },
        planning_evidence: { placementMatches: [], duplicateMatches: [] },
        generation: { method: "planning", tryNumber: 0, queuedAt: 1 },
        row_version: 1,
      },
    ],
    workgraph_due_jobs: [
      {
        _id: "job-row",
        owner_user_id: "user-a",
        id: "source-plan-job",
        job_type: "source_plan",
        subject_id: "proposal-a",
        due_at: 1,
        status: "pending",
        lease_epoch: 0,
        row_version: 1,
        payload: {
          proposalId: "proposal-a",
          source: { work_source_id: "source-a", revision_id: "revision-a", content_hash: "a".repeat(64) },
        },
      },
    ],
  })
}

function targetedSourcePlanningDb() {
  const db = sourcePlanningDb()
  db.rows.workgraph_streams.push({
    _id: "stream-target-row",
    organization_id: "org-a",
    owner_user_id: "user-a",
    id: "stream-target",
    title: "Existing launch Stream",
    lifecycle_state: "active",
    execution_defaults: {},
    updated_at: 1,
  })
  db.rows.workgraph_admission_proposals[0]!.planning_evidence = {
    targetStreamId: "stream-target",
    placementMatches: [],
    duplicateMatches: [],
  }
  return db
}

async function startSourcePlanningSession(db: BackgroundDb) {
  const claims = (await handler(claimSourcePlans)({ db } as never, {
    service_token: "service-secret",
    worker_id: "worker-a",
    now: 10,
    limit: 10,
  })) as Array<Record<string, any>>
  await handler(markSourcePlanSession)({ db } as never, {
    service_token: "service-secret",
    owner_user_id: "user-a",
    job_id: "source-plan-job",
    lease_epoch: 1,
    worker_id: "worker-a",
    workspace_id: "workspace-a",
    session_id: "session-a",
    admission_confirmed: false,
    now: 11,
  })
  await handler(markSourcePlanSession)({ db } as never, {
    service_token: "service-secret",
    owner_user_id: "user-a",
    job_id: "source-plan-job",
    lease_epoch: 1,
    worker_id: "worker-a",
    workspace_id: "workspace-a",
    session_id: "session-a",
    admission_confirmed: true,
    now: 12,
  })
  return claims
}

function sourceAgentPlan(): AdmissionAgentPlan {
  return {
    source: {
      workSourceId: "source-a" as never,
      revisionId: "revision-a" as never,
      contentHash: "a".repeat(64) as never,
    },
    suggestedPlacement: { mode: "new_stream", streamTitle: "Ship cloud" },
    placementMatches: [],
    proposedOutcomes: [
      { key: "ship", title: "Cloud shipped", successCriteria: ["Healthy"], execution: { effort: "high" } },
    ],
    proposedWorkItems: [
      {
        key: "deploy",
        outcomeKey: "ship",
        title: "Deploy",
        dependencyKeys: [],
        execution: { effort: "medium" },
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [{ id: "healthy" as never, kind: "owner_confirmation", description: "Owner verifies health" }],
        },
      },
    ],
    duplicateMatches: [],
  }
}

function handler(fn: unknown) {
  const run = (fn as { _handler: (context: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
  return (context: unknown, args: Record<string, unknown>) =>
    run(context, {
      organization_id: "org-a",
      owner_user_id: "user-a",
      ...args,
    })
}

class BackgroundDb {
  rows: Record<string, Array<Record<string, any>>>

  constructor(rows: Record<string, Array<Record<string, any>>>) {
    this.rows = Object.fromEntries(
      Object.entries({
        org_memberships: [{ _id: "membership-row", org_id: "org-a", user_id: "user-a" }],
        ...rows,
      }).map(([table, values]) => [
        table,
        values.map((row) => ({
          ...(table.startsWith("workgraph_") || table === "workgraphs" || table.startsWith("work_source")
            ? { organization_id: "org-a" }
            : {}),
          ...row,
        })),
      ]),
    )
  }

  query(table: string) {
    let selected = [...(this.rows[table] ?? [])]
    const chain = {
      withIndex: (_name: string, build: (query: any) => unknown) => {
        const predicates: Array<(row: Record<string, unknown>) => boolean> = []
        const query = {
          eq: (field: string, value: unknown) => {
            predicates.push((row) => row[field] === value)
            return query
          },
          lte: (field: string, value: number) => {
            predicates.push((row) => Number(row[field] ?? 0) <= value)
            return query
          },
          gt: (field: string, value: number) => {
            predicates.push((row) => Number(row[field] ?? 0) > value)
            return query
          },
        }
        build(query)
        selected = selected.filter((row) => predicates.every((predicate) => predicate(row)))
        return chain
      },
      filter: (build: (query: any) => (row: Record<string, unknown>) => boolean) => {
        const query = {
          field: (field: string) => field,
          eq: (field: string, value: unknown) => (row: Record<string, unknown>) => row[field] === value,
          neq: (field: string, value: unknown) => (row: Record<string, unknown>) => row[field] !== value,
          lte: (field: string, value: number) => (row: Record<string, unknown>) => Number(row[field]) <= value,
          and:
            (...predicates: Array<(row: Record<string, unknown>) => boolean>) =>
            (row: Record<string, unknown>) =>
              predicates.every((predicate) => predicate(row)),
          or:
            (...predicates: Array<(row: Record<string, unknown>) => boolean>) =>
            (row: Record<string, unknown>) =>
              predicates.some((predicate) => predicate(row)),
        }
        selected = selected.filter(build(query))
        return chain
      },
      collect: async () => selected,
      take: async (limit: number) => selected.slice(0, limit),
      unique: async () => selected[0] ?? null,
      first: async () => selected[0] ?? null,
    }
    return chain
  }

  async insert(table: string, value: Record<string, unknown>) {
    const row = { _id: `${table}-${(this.rows[table] ?? []).length + 1}`, ...value }
    ;(this.rows[table] ??= []).push(row)
    return row._id
  }

  async patch(id: string, value: Record<string, unknown>) {
    const row = Object.values(this.rows)
      .flat()
      .find((candidate) => candidate._id === id)
    if (row) Object.assign(row, value)
  }

  async delete(id: string) {
    Object.values(this.rows).forEach((rows) => {
      const index = rows.findIndex((candidate) => candidate._id === id)
      if (index >= 0) rows.splice(index, 1)
    })
  }

  async get(id: string) {
    return (
      Object.values(this.rows)
        .flat()
        .find((candidate) => candidate._id === id) ?? null
    )
  }
}
