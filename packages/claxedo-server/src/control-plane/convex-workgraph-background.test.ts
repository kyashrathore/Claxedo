import { beforeEach, describe, expect, test } from "vitest"
import type { AdmissionAgentPlan } from "@claxedo/workgraph/contracts"
import {
  claimRecaps,
  claimSourcePlans,
  completeRecap,
  completeSourcePlan,
  enqueueIndependentSessionIntake,
  failSourcePlan,
  listRunningSourcePlans,
  markSourcePlanSession,
  retryRecapLaunch,
  retrySourcePlanLaunch,
  scheduleDueRecaps,
} from "../../../../convex/workgraphBackground"
import { appendSourceRevision } from "../../../../convex/workgraphCommands"

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "service-secret"
})

describe("hosted WorkGraph background jobs", () => {
  test("keeps confirmed source revisions on existing Streams without duplicating exact revisions", () => {
    const first = { work_source_id: "source-a", revision_id: "revision-1", content_hash: "hash-1" }
    const second = { work_source_id: "source-a", revision_id: "revision-2", content_hash: "hash-2" }
    expect(appendSourceRevision([first], second)).toEqual([first, second])
    expect(appendSourceRevision([first, second], second)).toEqual([first, second])
  })

  test("schedules one durable Recap job for one quiet activity range", async () => {
    const db = new BackgroundDb({
      workgraph_streams: [
        {
          _id: "stream-row",
          owner_user_id: "user-a",
          id: "stream-a",
          lifecycle_state: "active",
          activity: { lastActivityAt: 1, recapDueAt: 2 },
          updated_at: 2,
        },
      ],
      workgraph_events: [{ _id: "event-row", owner_user_id: "user-a", stream_id: "stream-a", sequence: 4 }],
      workgraph_recaps: [],
      workgraph_due_jobs: [],
    })

    await handler(scheduleDueRecaps)({ db } as never, { limit: 10 })
    await handler(scheduleDueRecaps)({ db } as never, { limit: 10 })

    expect(db.rows.workgraph_due_jobs).toHaveLength(1)
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      job_type: "recap",
      subject_id: "stream-a:4",
      status: "pending",
      payload: { streamId: "stream-a", fromSequence: 1, toSequence: 4, quietSince: 1 },
    })
  })

  test("enqueues meaningful independent Sessions once and excludes WorkGraph execution Sessions", async () => {
    const db = new BackgroundDb({ workgraph_attempts: [], workgraph_due_jobs: [] })
    const context = { db } as never
    const input = {
      ownerUserId: "user-a" as never,
      sessionId: "session-independent",
      title: "Launch planning",
      summary: "Billing remains.",
      observedAt: 10,
    }

    await expect(enqueueIndependentSessionIntake(context, input)).resolves.toBe("created")
    await expect(enqueueIndependentSessionIntake(context, input)).resolves.toBe("existing")
    db.rows.workgraph_attempts.push({ _id: "attempt-row", owner_user_id: "user-a", session_id: "session-workgraph" })
    await expect(enqueueIndependentSessionIntake(context, { ...input, sessionId: "session-workgraph" })).resolves.toBe(
      "ignored",
    )
    expect(db.rows.workgraph_due_jobs).toHaveLength(1)
  })

  test("atomically publishes one actionable Recap notification and no retry duplicate", async () => {
    const db = new BackgroundDb({
      workgraph_streams: [{ _id: "stream-row", owner_user_id: "user-a", id: "stream-a", updated_at: 1 }],
      workgraph_due_jobs: [{
        _id: "job-row",
        owner_user_id: "user-a",
        id: "job-a",
        stream_id: "stream-a",
        status: "running",
        lease_epoch: 2,
        row_version: 1,
        payload: { sessionId: "session-a", streamId: "stream-a", fromSequence: 1, toSequence: 2, quietSince: 1, generationProfile: { model: { providerId: "openai", modelId: "gpt-5" }, effort: "medium" } },
      }],
      workgraph_recaps: [],
      workgraph_notifications: [],
    })
    const args = {
      service_token: "service-secret",
      owner_user_id: "user-a",
      job_id: "job-a",
      lease_epoch: 2,
      session_id: "session-a",
      summary: "Approval remains.",
      actionable_references: [{ type: "stream", id: "stream-a" }],
      now: 10,
    }
    await expect(handler(completeRecap)({ db } as never, args)).resolves.toEqual({ settled: true })
    await expect(handler(completeRecap)({ db } as never, args)).resolves.toEqual({ settled: false })
    expect(db.rows.workgraph_recaps).toHaveLength(1)
    expect(db.rows.workgraph_recaps[0]).toMatchObject({
      generation: {
        state: "succeeded",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "medium",
        method: "agent_session",
        sessionId: "session-a",
      },
    })
    expect(db.rows.workgraph_notifications).toEqual([
      expect.objectContaining({
        owner_user_id: "user-a",
        id: "notification_recap_job-a",
        state: "unread",
        stream_id: "stream-a",
        recap_id: "recap_job-a",
        row_version: 1,
      }),
    ])
  })

  test("publishes no notification for a non-actionable hosted Recap", async () => {
    const db = new BackgroundDb({
      workgraph_streams: [{ _id: "stream-row", owner_user_id: "user-a", id: "stream-a", updated_at: 1 }],
      workgraph_due_jobs: [{
        _id: "job-row",
        owner_user_id: "user-a",
        id: "job-a",
        stream_id: "stream-a",
        status: "running",
        lease_epoch: 1,
        row_version: 1,
        payload: { sessionId: "session-a", streamId: "stream-a", fromSequence: 1, toSequence: 1, quietSince: 1, generationProfile: { model: { providerId: "openai", modelId: "gpt-5" }, effort: "medium" } },
      }],
      workgraph_recaps: [],
      workgraph_notifications: [],
    })
    await handler(completeRecap)({ db } as never, {
      service_token: "service-secret",
      owner_user_id: "user-a",
      job_id: "job-a",
      lease_epoch: 1,
      session_id: "session-a",
      summary: "No action needed.",
      now: 10,
    })
    expect(db.rows.workgraph_recaps).toHaveLength(1)
    expect(db.rows.workgraph_notifications).toHaveLength(0)
  })

  test("keeps hosted launch failures retryable and surfaces Stream attention after exhaustion without publication", async () => {
    const db = new BackgroundDb({
      workgraph_streams: [{ _id: "stream-row", owner_user_id: "user-a", id: "stream-a", memory: { summary: "Previous memory", updatedAt: 1 }, updated_at: 1 }],
      workgraph_due_jobs: [{
        _id: "job-row", owner_user_id: "user-a", id: "job-a", stream_id: "stream-a", status: "running",
        claimed_by: "worker-a", lease_epoch: 1, row_version: 1, payload: {},
      }],
      workgraph_recaps: [],
      workgraph_notifications: [],
    })
    const retry = (leaseEpoch: number, now: number) => handler(retryRecapLaunch)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "job-a", lease_epoch: leaseEpoch,
      worker_id: "worker-a", reason: "workspace unavailable", now,
    })

    await expect(retry(1, 10)).resolves.toEqual({ settled: true })
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({ status: "pending", last_error: "workspace unavailable" })
    Object.assign(db.rows.workgraph_due_jobs[0]!, { status: "running", claimed_by: "worker-a", lease_epoch: 3 })
    await expect(retry(3, 20)).resolves.toEqual({ settled: true })
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({ status: "failed", last_error: "workspace unavailable" })
    expect(db.rows.workgraph_streams[0]).toMatchObject({
      memory: { summary: "Previous memory", attention: { type: "recap_failed", reason: "workspace unavailable", at: 20 } },
    })
    expect(db.rows.workgraph_recaps).toHaveLength(0)
    expect(db.rows.workgraph_notifications).toHaveLength(0)
  })

  test("fails a hosted Recap completion whose durable claim lacks its captured generation profile", async () => {
    const db = new BackgroundDb({
      workgraph_streams: [{ _id: "stream-row", owner_user_id: "user-a", id: "stream-a", updated_at: 1 }],
      workgraph_due_jobs: [{
        _id: "job-row", owner_user_id: "user-a", id: "job-a", stream_id: "stream-a", status: "running",
        lease_epoch: 3, row_version: 1, payload: { sessionId: "session-a", fromSequence: 1, toSequence: 1, quietSince: 1 },
      }],
      workgraph_recaps: [],
      workgraph_notifications: [],
    })
    await expect(handler(completeRecap)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "job-a", lease_epoch: 3,
      session_id: "session-a", summary: "Must not publish", now: 10,
    })).resolves.toEqual({ settled: true })
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      status: "failed",
      last_error: "Recap generation profile is missing from its durable claim",
      payload: { configurationRequirement: { type: "generation", purpose: "recap", scope: { type: "stream", streamId: "stream-a" } } },
    })
    expect(db.rows.workgraph_streams[0]).toMatchObject({ memory: { attention: { type: "recap_failed" } } })
    expect(db.rows.workgraph_recaps).toHaveLength(0)
    expect(db.rows.workgraph_notifications).toHaveLength(0)
  })

  test("does not claim a Recap Session without an explicit generation profile and surfaces terminal attention", async () => {
    const db = recapClaimDb()
    for (const now of [10, 60_010, 120_010]) {
      await expect(handler(claimRecaps)({ db } as never, {
        service_token: "service-secret", worker_id: "worker-a", now, limit: 10,
      })).resolves.toEqual([])
    }
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      status: "failed",
      lease_epoch: 0,
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: "Recap requires explicit valid agent configuration",
      payload: expect.objectContaining({
        automaticFailureCount: 3,
        configurationRequirement: { type: "generation", purpose: "recap", scope: { type: "stream", streamId: "stream-a" } },
      }),
    })
    expect(db.rows.workgraph_due_jobs[0]?.payload).not.toHaveProperty("sessionId")
    expect(db.rows.workgraph_streams[0]).toMatchObject({
      memory: { attention: { type: "recap_failed", reason: "Recap requires explicit valid agent configuration" } },
    })
    expect(db.rows.workgraph_recaps).toHaveLength(0)
    expect(db.rows.workgraph_notifications).toHaveLength(0)
  })

  test("claims Recaps with explicit Stream-over-WorkGraph generation settings unchanged", async () => {
    const db = recapClaimDb()
    Object.assign(db.rows.workgraphs[0]!, {
      defaults: { agent: "root-agent", model: { providerId: "root", modelId: "exec" }, effort: "root-effort" },
      recap_defaults: { model: { providerId: "root", modelId: "recap" }, effort: "root-recap-effort" },
    })
    Object.assign(db.rows.workgraph_streams[0]!, {
      execution_defaults: { agent: "stream-agent", model: { providerId: "stream", modelId: "exec" }, effort: "stream-effort" },
      recap_defaults: { model: { providerId: "stream", modelId: "recap" }, effort: "stream-recap-effort" },
    })
    await expect(handler(claimRecaps)({ db } as never, {
      service_token: "service-secret", worker_id: "worker-a", now: 10, limit: 10,
    })).resolves.toEqual([expect.objectContaining({
      leaseEpoch: 1,
      profile: {
        agent: "stream-agent",
        model: { providerId: "stream", modelId: "recap" },
        effort: "stream-recap-effort",
        tools: [],
      },
    })])
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      status: "running",
      payload: { generationProfile: { model: { providerId: "stream", modelId: "recap" }, effort: "stream-recap-effort" } },
    })
  })

  test("rejects an invalid explicit Recap generation profile before claiming", async () => {
    const db = recapClaimDb()
    db.rows.workgraphs[0]!.defaults = {
      agent: "recap-agent", model: { providerId: "openai", modelId: "gpt-5" }, effort: "high",
    }
    db.rows.workgraph_streams[0]!.recap_defaults = { model: { providerId: "", modelId: "gpt-5" } }
    await expect(handler(claimRecaps)({ db } as never, {
      service_token: "service-secret", worker_id: "worker-a", now: 10, limit: 10,
    })).resolves.toEqual([])
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      status: "pending", lease_epoch: 0, last_error: "Recap requires explicit valid model configuration",
      payload: expect.objectContaining({ configurationRequirement: expect.objectContaining({ type: "generation", purpose: "recap" }) }),
    })
  })

  test("claims an exact source revision and publishes one fenced agent proposal", async () => {
    const db = sourcePlanningDb()
    const claims = await handler(claimSourcePlans)({ db } as never, { service_token: "service-secret", worker_id: "worker-a", now: 10, limit: 10 }) as Array<Record<string, any>>
    expect(claims).toEqual([expect.objectContaining({
      ownerUserId: "user-a",
      orgId: "org-a",
      jobId: "source-plan-job",
      leaseEpoch: 1,
      profile: {
        agent: "planner-agent",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "high",
        tools: [],
      },
      prompt: expect.stringContaining('"revisionId":"revision-a"'),
    })])
    await expect(handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job", lease_epoch: 1,
      worker_id: "worker-a", workspace_id: "workspace-a", session_id: "session-a", admission_confirmed: false, now: 11,
    })).resolves.toEqual({ settled: true })
    await expect(handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job", lease_epoch: 1,
      worker_id: "worker-a", workspace_id: "workspace-a", session_id: "session-a", admission_confirmed: true, now: 12,
    })).resolves.toEqual({ settled: true })
    await expect(handler(completeSourcePlan)({ db } as never, {
      owner_user_id: "user-a",
      service_token: "service-secret",
      job_id: "source-plan-job",
      lease_epoch: 1,
      session_id: "session-a",
      plan: sourceAgentPlan(),
      now: 13,
    })).resolves.toEqual({ settled: true })
    await expect(handler(completeSourcePlan)({ db } as never, {
      owner_user_id: "user-a",
      service_token: "service-secret",
      job_id: "source-plan-job",
      lease_epoch: 1,
      session_id: "session-a",
      plan: sourceAgentPlan(),
      now: 13,
    })).resolves.toEqual({ settled: false })
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
        payload: expect.objectContaining({ proposalId: "proposal-a", version: 2, generation: expect.objectContaining({ method: "planning", attempt: 1 }) }),
      }),
      expect.objectContaining({
        cursor: 2,
        resource_type: "admission_proposal",
        resource_id: "proposal-a",
        change_type: "admission_proposal_updated",
        payload: expect.objectContaining({ proposalId: "proposal-a", version: 3, generation: { method: "agent_session", sessionId: "session-a" } }),
      }),
    ])
    expect(db.rows.workgraph_events).toEqual([
      expect.objectContaining({ event_type: "admission_proposal_updated", operation_id: "source_plan_publish_proposal-a_2" }),
      expect.objectContaining({ event_type: "admission_proposal_updated", operation_id: "source_plan_publish_proposal-a_3" }),
    ])
  })

  test("fences hosted source-plan publication after the source head changes", async () => {
    const db = sourcePlanningDb()
    await handler(claimSourcePlans)({ db } as never, { service_token: "service-secret", worker_id: "worker-a", now: 10, limit: 10 })
    const job = db.rows.workgraph_due_jobs[0]!
    await handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job", lease_epoch: 1,
      worker_id: "worker-a", workspace_id: "workspace-a", session_id: "session-a", admission_confirmed: false, now: 11,
    })
    await handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job", lease_epoch: 1,
      worker_id: "worker-a", workspace_id: "workspace-a", session_id: "session-a", admission_confirmed: true, now: 12,
    })
    db.rows.work_sources[0]!.latest_revision_id = "revision-b"
    await expect(handler(completeSourcePlan)({ db } as never, {
      owner_user_id: "user-a",
      service_token: "service-secret",
      job_id: "source-plan-job",
      lease_epoch: 1,
      session_id: "session-a",
      plan: sourceAgentPlan(),
      now: 13,
    })).resolves.toEqual({ settled: false })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning_failed",
      row_version: 3,
      generation: {
        method: "planning_failed",
        attempt: 1,
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
    const claims = await handler(claimSourcePlans)({ db } as never, {
      service_token: "service-secret", worker_id: "worker-after", now: 10, limit: 10,
    }) as Array<Record<string, unknown>>
    expect(claims).toEqual([expect.objectContaining({ leaseEpoch: 2, sessionId: "session-a" })])
    await expect(handler(listRunningSourcePlans)({ db } as never, {
      service_token: "service-secret", now: 10, limit: 10,
    })).resolves.toEqual([])
    ;(job.payload as Record<string, unknown>).sessionAdmissionConfirmed = true
    await expect(handler(listRunningSourcePlans)({ db } as never, {
      service_token: "service-secret", now: 10, limit: 10,
    })).resolves.toEqual([expect.objectContaining({ sessionId: "session-a", leaseEpoch: 2 })])
  })

  test("rejects a two-node hosted agent dependency cycle before proposal publication", async () => {
    const db = sourcePlanningDb()
    await handler(claimSourcePlans)({ db } as never, { service_token: "service-secret", worker_id: "worker-a", now: 10, limit: 10 })
    const job = db.rows.workgraph_due_jobs[0]!
    await handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job", lease_epoch: 1,
      worker_id: "worker-a", workspace_id: "workspace-a", session_id: "session-a", admission_confirmed: false, now: 11,
    })
    await handler(markSourcePlanSession)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job", lease_epoch: 1,
      worker_id: "worker-a", workspace_id: "workspace-a", session_id: "session-a", admission_confirmed: true, now: 12,
    })
    const plan = sourceAgentPlan()
    plan.proposedWorkItems.push({ ...plan.proposedWorkItems[0]!, key: "verify", title: "Verify", dependencyKeys: ["deploy"] })
    plan.proposedWorkItems[0]!.dependencyKeys = ["verify"]
    await expect(handler(completeSourcePlan)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job",
      lease_epoch: 1, session_id: "session-a", plan, now: 13,
    })).rejects.toThrow("dependency cycle")
    await expect(handler(failSourcePlan)({ db } as never, {
      service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job", lease_epoch: 1,
      session_id: "session-a", reason: "Source planning result contains a dependency cycle", now: 13,
    })).resolves.toEqual({ settled: true })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning_failed",
      row_version: 3,
      generation: { method: "planning_failed", attempt: 1, retryable: true, failedAt: 13 },
    })
    expect(job).toMatchObject({ status: "failed", last_error: "Source planning result contains a dependency cycle" })
  })

  test("bounds hosted source planning failures at three attempts and leaves a truthful attention state", async () => {
    const db = sourcePlanningDb()
    for (const [index, now] of [10, 60_011, 120_012].entries()) {
      const [claim] = await handler(claimSourcePlans)({ db } as never, {
        service_token: "service-secret", worker_id: "worker-a", now, limit: 10,
      }) as Array<Record<string, unknown>>
      expect(claim).toMatchObject({ leaseEpoch: index + 1, proposalId: "proposal-a" })
      await expect(handler(retrySourcePlanLaunch)({ db } as never, {
        service_token: "service-secret", owner_user_id: "user-a", job_id: "source-plan-job",
        lease_epoch: index + 1, worker_id: "worker-a", reason: "workspace unavailable", now: now + 1,
      })).resolves.toEqual({ settled: true })
    }
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning_failed",
      row_version: 6,
      generation: { method: "planning_failed", attempt: 0, reason: "workspace unavailable", retryable: true, failedAt: 120_013 },
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
      await expect(handler(claimSourcePlans)({ db } as never, {
        service_token: "service-secret", worker_id: "worker-a", now, limit: 10,
      })).resolves.toEqual([])
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
      agent: "planner-agent", model: { providerId: "openai", modelId: "gpt-5" }, effort: " ",
    }
    await expect(handler(claimSourcePlans)({ db } as never, {
      service_token: "service-secret", worker_id: "worker-a", now: 10, limit: 10,
    })).resolves.toEqual([])
    expect(db.rows.workgraph_due_jobs[0]).toMatchObject({
      status: "failed", lease_epoch: 0, last_error: "Source planning requires explicit valid effort configuration",
      payload: expect.objectContaining({ configurationRequirement: expect.objectContaining({ type: "generation", purpose: "source_planning" }) }),
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

    await expect(handler(claimSourcePlans)({ db } as never, {
      service_token: "service-secret", worker_id: "worker-a", now: 10, limit: 10,
    })).resolves.toEqual([expect.objectContaining({ proposalId: "proposal-a", leaseEpoch: 1 })])
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      state: "planning",
      row_version: 3,
      generation: { method: "planning", attempt: 0, queuedAt: 10 },
      planning_evidence: { placementMatches: [], duplicateMatches: [] },
    })
    expect(db.rows.workgraph_admission_proposals[0]).toMatchObject({
      suggested_placement: undefined,
      proposed_outcomes: undefined,
      proposed_work_items: undefined,
    })
    expect(db.rows.workgraph_changes).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ version: 2, generation: expect.objectContaining({ method: "planning_failed", attempt: 0, retryable: true }) }) }),
      expect.objectContaining({ payload: expect.objectContaining({ version: 3, generation: { method: "planning", attempt: 0 } }) }),
    ])
  })
})

function sourcePlanningDb() {
  return new BackgroundDb({
    orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
    workgraphs: [{
      _id: "graph-a", owner_user_id: "user-a", id: "workgraph_default",
      defaults: { agent: "planner-agent", model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" },
    }],
    work_sources: [{ _id: "source-row", owner_user_id: "user-a", id: "source-a", title: "Ship cloud", latest_revision_id: "revision-a" }],
    work_source_revisions: [{ _id: "revision-row", owner_user_id: "user-a", id: "revision-a", work_source_id: "source-a", content: "Deploy cloud", content_hash: "a".repeat(64) }],
    workgraph_streams: [],
    workgraph_outcomes: [],
    workgraph_work_items: [],
    workgraph_admission_proposals: [{
      _id: "proposal-row", owner_user_id: "user-a", id: "proposal-a", state: "planning",
      source: { work_source_id: "source-a", revision_id: "revision-a", content_hash: "a".repeat(64) },
      planning_evidence: { placementMatches: [], duplicateMatches: [] },
      generation: { method: "planning", attempt: 0, queuedAt: 1 }, row_version: 1,
    }],
    workgraph_due_jobs: [{
      _id: "job-row", owner_user_id: "user-a", id: "source-plan-job", job_type: "source_plan",
      subject_id: "proposal-a", due_at: 1, status: "pending", lease_epoch: 0, row_version: 1,
      payload: { proposalId: "proposal-a", source: { work_source_id: "source-a", revision_id: "revision-a", content_hash: "a".repeat(64) } },
    }],
  })
}

function recapClaimDb() {
  return new BackgroundDb({
    orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
    workgraphs: [{
      _id: "graph-a", owner_user_id: "user-a", id: "workgraph_default", defaults: {}, recap_defaults: {},
    }],
    workgraph_streams: [{
      _id: "stream-row", owner_user_id: "user-a", id: "stream-a", title: "Ship cloud",
      lifecycle_state: "active", execution_defaults: {}, recap_defaults: {}, updated_at: 1,
    }],
    workgraph_events: [{
      _id: "event-row", owner_user_id: "user-a", stream_id: "stream-a", sequence: 1,
      event_type: "work_item_created", payload: { workItemId: "item-a" },
    }],
    workgraph_due_jobs: [{
      _id: "job-row", owner_user_id: "user-a", id: "recap-job", stream_id: "stream-a", job_type: "recap",
      subject_id: "stream-a:1", due_at: 1, status: "pending", lease_epoch: 0, row_version: 1,
      payload: { streamId: "stream-a", fromSequence: 1, toSequence: 1, quietSince: 1 },
    }],
    workgraph_recaps: [],
    workgraph_notifications: [],
  })
}

function sourceAgentPlan(): AdmissionAgentPlan {
  return {
    source: { workSourceId: "source-a" as never, revisionId: "revision-a" as never, contentHash: "a".repeat(64) as never },
    suggestedPlacement: { mode: "new_stream", streamTitle: "Ship cloud" },
    placementMatches: [],
    proposedOutcomes: [{ key: "ship", title: "Cloud shipped", successCriteria: ["Healthy"], execution: { effort: "high" } }],
    proposedWorkItems: [{
      key: "deploy", outcomeKey: "ship", title: "Deploy", dependencyKeys: [], execution: { effort: "medium" },
      completionContract: { version: 1, mode: "all", requirements: [{ id: "healthy" as never, kind: "owner_confirmation", description: "Owner verifies health" }] },
    }],
    duplicateMatches: [],
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (context: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

class BackgroundDb {
  rows: Record<string, Array<Record<string, any>>>

  constructor(rows: Record<string, Array<Record<string, any>>>) {
    this.rows = rows
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

  async get(id: string) {
    return (
      Object.values(this.rows)
        .flat()
        .find((candidate) => candidate._id === id) ?? null
    )
  }
}
