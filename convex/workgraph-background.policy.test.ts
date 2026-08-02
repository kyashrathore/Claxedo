import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import type { AdmissionAgentPlan } from "@claxedo/workgraph/contracts"
import { api } from "./_generated/api"
import { appendSourceRevision } from "./workgraphCommands"
import { enqueueIndependentSessionIntake } from "./workgraphBackground"
import type { Id } from "./_generated/dataModel"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

beforeEach(() => {
  vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
})

afterEach(() => vi.unstubAllEnvs())

/**
 * Convex omits a field entirely once it's been patched away — there is no
 * key left to match, so `toMatchObject({ field: undefined })` fails against
 * a real row even though the field is genuinely absent. Assert absence
 * directly instead of folding it into the `toMatchObject` call.
 */
const expectAbsentKeys = (row: Record<string, unknown> | null | undefined, keys: readonly string[]) => {
  for (const key of keys) {
    expect(row?.[key]).toBeUndefined()
  }
}

/**
 * Hosted WorkGraph background jobs: session-intake enqueueing and the
 * source-planning job/proposal state machine.
 *
 * The previous version of this suite drove a hand-written multi-table `db`
 * double (`BackgroundDb`) through a `handler(fn)._handler` reach-in that
 * auto-injected `organization_id: "org-a", owner_user_id: "user-a"` string
 * literals into every call. The real schema declares
 * `organization_id: v.id("orgs")` / `owner_user_id: v.id("users")` on every
 * WorkGraph table, so this conversion seeds real `orgs`/`users` rows via
 * `convex-test` and threads the real generated ids through every call and
 * assertion instead.
 */
describe("hosted WorkGraph background jobs", () => {
  test("keeps confirmed source revisions on existing Streams without duplicating exact revisions", () => {
    const first = { work_source_id: "source-a", revision_id: "revision-1", content_hash: "hash-1" }
    const second = { work_source_id: "source-a", revision_id: "revision-2", content_hash: "hash-2" }
    expect(appendSourceRevision([first], second)).toEqual([first, second])
    expect(appendSourceRevision([first, second], second)).toEqual([first, second])
  })

  test("enqueues meaningful independent Sessions once and excludes WorkGraph execution Sessions", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await seedTenant(t)
    const input = {
      organizationId: orgId,
      ownerUserId: userId,
      sessionId: "session-independent",
      title: "Launch planning",
      summary: "Billing remains.",
      observedAt: 10,
    }

    await expect(t.run((ctx) => enqueueIndependentSessionIntake(ctx, input))).resolves.toBe("created")
    await expect(t.run((ctx) => enqueueIndependentSessionIntake(ctx, input))).resolves.toBe("existing")
    await t.run(async (ctx) => {
      await ctx.db.insert("workgraph_runs", {
        organization_id: orgId,
        owner_user_id: userId,
        id: "run-a",
        stream_id: "stream-a",
        work_item_id: "item-a",
        run_number: 1,
        generation: 1,
        state: "running",
        resolved_execution: {},
        admitted_at: 1,
        session_id: "session-workgraph",
        source_revision_refs: [],
        provenance: {},
        row_version: 1,
        schema_version: 1,
        created_at: 1,
        updated_at: 1,
      } as never)
    })
    await expect(
      t.run((ctx) => enqueueIndependentSessionIntake(ctx, { ...input, sessionId: "session-workgraph" })),
    ).resolves.toBe("ignored")
    const jobs = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
    expect(jobs).toHaveLength(1)
  })

  test("claims an exact source revision and publishes one fenced agent proposal", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)

    const claims = (await t.mutation(api.workgraphBackground.claimSourcePlans, {
      organization_id: orgId,
      owner_user_id: userId,
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    } as never)) as Array<Record<string, unknown>>
    expect(claims).toEqual([
      expect.objectContaining({
        ownerUserId: String(userId),
        orgId: String(orgId),
        jobId: "source-plan-job",
        leaseEpoch: 1,
        queueLagMs: 9,
        // Real schema requires `updated_at` on every WorkGraph row (unlike
        // the old fake, which happily left it undefined so this computed as
        // 0). The fixture stamps `updated_at: 1`, so at `now: 10` this is 9 —
        // the same lag as queueLagMs because the job has never been claimed.
        activeLeaseAgeMs: 9,
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
    await expect(markSourcePlanSession(t, orgId, userId, { admission_confirmed: false, now: 11 })).resolves.toEqual({
      settled: true,
    })
    await expect(markSourcePlanSession(t, orgId, userId, { admission_confirmed: true, now: 12 })).resolves.toEqual({
      settled: true,
    })
    await expect(completeSourcePlan(t, orgId, userId, { plan: sourceAgentPlan(), now: 13 })).resolves.toEqual({
      settled: true,
    })
    await expect(completeSourcePlan(t, orgId, userId, { plan: sourceAgentPlan(), now: 13 })).resolves.toEqual({
      settled: false,
    })

    const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
    expect(proposal).toMatchObject({
      state: "proposed",
      row_version: 3,
      generation: { method: "agent_session", sessionId: "session-a", generatedAt: 13 },
      proposed_outcomes: [expect.objectContaining({ execution: { effort: "high" } })],
      proposed_work_items: [expect.objectContaining({ completionContract: expect.objectContaining({ version: 1 }) })],
    })
    const [job] = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
    expect(job).toMatchObject({ status: "completed" })
    const changes = await t.run((ctx) => ctx.db.query("workgraph_changes").collect())
    expect(changes).toEqual([
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
    const events = await t.run((ctx) => ctx.db.query("workgraph_events").collect())
    expect(events).toEqual([
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
    const t = convexTest(schema, modules)
    const { orgId, userId } = await targetedSourcePlanningFixture(t)
    const [claim] = await startSourcePlanningSession(t, orgId, userId)
    expect(claim).toMatchObject({
      prompt: expect.stringContaining('"targetStreamId":"stream-target"'),
    })
    expect((claim as { prompt: string }).prompt).toContain("suggestedPlacement must be existing with that exact Stream ID")
    const plan = sourceAgentPlan()
    plan.suggestedPlacement = { mode: "existing", streamId: "stream-target" as never }

    await expect(completeSourcePlan(t, orgId, userId, { plan, now: 13 })).resolves.toEqual({ settled: true })
    const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
    expect(proposal).toMatchObject({
      state: "proposed",
      suggested_placement: { mode: "existing", streamId: "stream-target" },
      generation: { method: "agent_session", sessionId: "session-a", generatedAt: 13 },
    })
    const [job] = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
    expect(job).toMatchObject({ status: "completed" })
  })

  test.each([
    ["a new Stream", { mode: "new_stream", streamTitle: "Incorrect replacement" }],
    ["another existing Stream", { mode: "existing", streamId: "stream-different" }],
  ] as const)(
    "publishes planning_failed instead of substituting %s for an explicit hosted target",
    async (_label, suggestedPlacement) => {
      const t = convexTest(schema, modules)
      const { orgId, userId } = await targetedSourcePlanningFixture(t)
      await startSourcePlanningSession(t, orgId, userId)
      const plan = sourceAgentPlan()
      plan.suggestedPlacement = suggestedPlacement as AdmissionAgentPlan["suggestedPlacement"]

      await expect(completeSourcePlan(t, orgId, userId, { plan, now: 13 })).resolves.toEqual({ settled: true })
      const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
      expect(proposal).toMatchObject({
        state: "planning_failed",
        generation: {
          method: "planning_failed",
          tryNumber: 1,
          reason: "Source planning result did not honor the exact target Stream",
          failedAt: 13,
          retryable: true,
        },
      })
      expectAbsentKeys(proposal, ["suggested_placement", "proposed_outcomes", "proposed_work_items"])
      const [job] = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
      expect(job).toMatchObject({
        status: "failed",
        last_error: "Source planning result did not honor the exact target Stream",
      })
      const changes = await t.run((ctx) => ctx.db.query("workgraph_changes").collect())
      expect(changes.at(-1)).toMatchObject({
        change_type: "admission_proposal_updated",
        payload: expect.objectContaining({ generation: expect.objectContaining({ method: "planning_failed" }) }),
      })
    },
  )

  test("fences hosted source-plan publication after the source head changes", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)
    await t.mutation(api.workgraphBackground.claimSourcePlans, {
      organization_id: orgId,
      owner_user_id: userId,
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    } as never)
    await markSourcePlanSession(t, orgId, userId, { admission_confirmed: false, now: 11 })
    await markSourcePlanSession(t, orgId, userId, { admission_confirmed: true, now: 12 })
    await t.run(async (ctx) => {
      const source = await ctx.db
        .query("work_sources")
        .withIndex("by_tenant_id", (q) => q.eq("organization_id", orgId).eq("owner_user_id", userId).eq("id", "source-a"))
        .unique()
      if (source) await ctx.db.patch(source._id, { latest_revision_id: "revision-b" })
    })
    await expect(completeSourcePlan(t, orgId, userId, { plan: sourceAgentPlan(), now: 13 })).resolves.toEqual({
      settled: false,
    })
    const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
    expect(proposal).toMatchObject({
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
    const [job] = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
    expect(job).toMatchObject({ status: "cancelled" })
  })

  test("reclaims an indeterminate hosted prompt with the same Session and hides it from result polling until confirmed", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)
    await t.run(async (ctx) => {
      const job = await sourcePlanJobRow(ctx, orgId, userId)
      if (job) {
        await ctx.db.patch(job._id, {
          status: "running",
          claimed_by: "worker-before",
          claim_expires_at: 1,
          lease_epoch: 1,
          payload: {
            ...(job.payload as object),
            workspaceId: "workspace-a",
            sessionId: "session-a",
            sessionAdmissionConfirmed: false,
          },
        })
      }
    })
    const claims = (await t.mutation(api.workgraphBackground.claimSourcePlans, {
      organization_id: orgId,
      owner_user_id: userId,
      service_token: "service-secret",
      worker_id: "worker-after",
      now: 10,
      limit: 10,
    } as never)) as Array<Record<string, unknown>>
    expect(claims).toEqual([expect.objectContaining({ leaseEpoch: 2, sessionId: "session-a" })])
    await expect(
      t.mutation(api.workgraphBackground.listRunningSourcePlans, {
        organization_id: orgId,
        owner_user_id: userId,
        service_token: "service-secret",
        now: 10,
        limit: 10,
      } as never),
    ).resolves.toEqual([])
    await t.run(async (ctx) => {
      const job = await sourcePlanJobRow(ctx, orgId, userId)
      if (job) await ctx.db.patch(job._id, { payload: { ...(job.payload as object), sessionAdmissionConfirmed: true } })
    })
    await expect(
      t.mutation(api.workgraphBackground.listRunningSourcePlans, {
        organization_id: orgId,
        owner_user_id: userId,
        service_token: "service-secret",
        now: 10,
        limit: 10,
      } as never),
    ).resolves.toEqual([expect.objectContaining({ sessionId: "session-a", leaseEpoch: 2 })])
  })

  test("rejects a two-node hosted agent dependency cycle before proposal publication", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)
    await t.mutation(api.workgraphBackground.claimSourcePlans, {
      organization_id: orgId,
      owner_user_id: userId,
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    } as never)
    await markSourcePlanSession(t, orgId, userId, { admission_confirmed: false, now: 11 })
    await markSourcePlanSession(t, orgId, userId, { admission_confirmed: true, now: 12 })
    const plan = sourceAgentPlan()
    plan.proposedWorkItems.push({
      ...plan.proposedWorkItems[0]!,
      key: "verify",
      title: "Verify",
      dependencyKeys: ["deploy"],
    })
    plan.proposedWorkItems[0]!.dependencyKeys = ["verify"]
    await expect(completeSourcePlan(t, orgId, userId, { plan, now: 13 })).rejects.toThrow("dependency cycle")
    await expect(
      t.mutation(api.workgraphBackground.failSourcePlan, {
        organization_id: orgId,
        owner_user_id: userId,
        service_token: "service-secret",
        job_id: "source-plan-job",
        lease_epoch: 1,
        session_id: "session-a",
        reason: "Source planning result contains a dependency cycle",
        now: 13,
      } as never),
    ).resolves.toEqual({ settled: true })
    const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
    expect(proposal).toMatchObject({
      state: "planning_failed",
      row_version: 3,
      generation: { method: "planning_failed", tryNumber: 1, retryable: true, failedAt: 13 },
    })
    const [job] = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
    expect(job).toMatchObject({ status: "failed", last_error: "Source planning result contains a dependency cycle" })
  })

  test("bounds hosted source planning failures at three attempts and leaves a truthful attention state", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)
    for (const [index, now] of [10, 60_011, 120_012].entries()) {
      const claims = (await t.mutation(api.workgraphBackground.claimSourcePlans, {
        organization_id: orgId,
        owner_user_id: userId,
        service_token: "service-secret",
        worker_id: "worker-a",
        now,
        limit: 10,
      } as never)) as Array<Record<string, unknown>>
      const [claim] = claims
      expect(claim).toMatchObject({ leaseEpoch: index + 1, proposalId: "proposal-a" })
      await expect(
        t.mutation(api.workgraphBackground.retrySourcePlanLaunch, {
          organization_id: orgId,
          owner_user_id: userId,
          service_token: "service-secret",
          job_id: "source-plan-job",
          lease_epoch: index + 1,
          worker_id: "worker-a",
          reason: "workspace unavailable",
          now: now + 1,
        } as never),
      ).resolves.toEqual({ settled: true })
    }
    const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
    expect(proposal).toMatchObject({
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
    expectAbsentKeys(proposal, ["proposed_outcomes", "proposed_work_items", "duplicate_matches"])
    const [job] = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
    expect(job).toMatchObject({
      status: "failed_terminal",
      last_error: "workspace unavailable",
      payload: expect.objectContaining({ automaticFailureCount: 3 }),
    })
  })

  test("does not claim source-planning Sessions without explicit settings and terminates after bounded retries", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)
    await t.run(async (ctx) => {
      const root = await workgraphRootRow(ctx, orgId, userId)
      if (root) await ctx.db.patch(root._id, { defaults: {} })
    })
    for (const now of [10, 60_010, 120_010]) {
      await expect(
        t.mutation(api.workgraphBackground.claimSourcePlans, {
          organization_id: orgId,
          owner_user_id: userId,
          service_token: "service-secret",
          worker_id: "worker-a",
          now,
          limit: 10,
        } as never),
      ).resolves.toEqual([])
    }
    const [job] = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
    expect(job).toMatchObject({
      status: "failed_terminal",
      lease_epoch: 0,
      last_error: "Source planning requires explicit valid agent configuration",
      payload: expect.objectContaining({
        automaticFailureCount: 3,
        configurationRequirement: { type: "generation", purpose: "source_planning", scope: { type: "workgraph" } },
      }),
    })
    expectAbsentKeys(job, ["claimed_by", "claim_expires_at"])
    expect(job?.payload).not.toHaveProperty("sessionId")
    const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
    expect(proposal).toMatchObject({
      state: "planning_failed",
      generation: expect.objectContaining({
        method: "planning_failed",
        reason: "Source planning requires explicit valid agent configuration",
        retryable: true,
      }),
    })
    expectAbsentKeys(proposal, ["proposed_outcomes", "proposed_work_items"])
  })

  test("rejects invalid explicit source-planning settings before claiming", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)
    await t.run(async (ctx) => {
      const root = await workgraphRootRow(ctx, orgId, userId)
      if (root) {
        await ctx.db.patch(root._id, {
          defaults: { agent: "planner-agent", model: { providerId: "openai", modelId: "gpt-5" }, effort: " " },
        })
      }
    })
    await expect(
      t.mutation(api.workgraphBackground.claimSourcePlans, {
        organization_id: orgId,
        owner_user_id: userId,
        service_token: "service-secret",
        worker_id: "worker-a",
        now: 10,
        limit: 10,
      } as never),
    ).resolves.toEqual([])
    const [job] = await t.run((ctx) => ctx.db.query("workgraph_due_jobs").collect())
    expect(job).toMatchObject({
      status: "failed",
      lease_epoch: 0,
      last_error: "Source planning requires explicit valid effort configuration",
      payload: expect.objectContaining({
        configurationRequirement: expect.objectContaining({ type: "generation", purpose: "source_planning" }),
      }),
    })
  })

  test("invalidates a legacy proposal before reclaiming its exact source for Session planning", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)
    await t.run(async (ctx) => {
      const proposal = await sourcePlanProposalRow(ctx, orgId, userId)
      if (proposal) {
        await ctx.db.patch(proposal._id, {
          state: "proposed",
          suggested_placement: { mode: "new_stream", streamTitle: "Legacy" },
          placement_matches: [],
          proposed_outcomes: [{ key: "legacy", title: "Legacy result" }],
          proposed_work_items: [],
          duplicate_matches: [],
          generation: { method: "deterministic_fallback", reason: "legacy" },
        })
      }
    })

    await expect(
      t.mutation(api.workgraphBackground.claimSourcePlans, {
        organization_id: orgId,
        owner_user_id: userId,
        service_token: "service-secret",
        worker_id: "worker-a",
        now: 10,
        limit: 10,
      } as never),
    ).resolves.toEqual([expect.objectContaining({ proposalId: "proposal-a", leaseEpoch: 1 })])
    const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
    expect(proposal).toMatchObject({
      state: "planning",
      row_version: 3,
      generation: { method: "planning", tryNumber: 0, queuedAt: 10 },
      planning_evidence: { placementMatches: [], duplicateMatches: [] },
    })
    expectAbsentKeys(proposal, ["suggested_placement", "proposed_outcomes", "proposed_work_items"])
    const changes = await t.run((ctx) => ctx.db.query("workgraph_changes").collect())
    expect(changes).toEqual([
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
    const t = convexTest(schema, modules)
    const { orgId, userId } = await sourcePlanningFixture(t)
    await t.run(async (ctx) => {
      const proposal = await sourcePlanProposalRow(ctx, orgId, userId)
      if (proposal) {
        await ctx.db.patch(proposal._id, {
          state: "proposed",
          source: undefined,
          generation: { method: "deterministic_fallback", reason: "legacy" },
        })
      }
    })

    await t.mutation(api.workgraphBackground.claimSourcePlans, {
      organization_id: orgId,
      owner_user_id: userId,
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    } as never)

    const [proposal] = await t.run((ctx) => ctx.db.query("workgraph_admission_proposals").collect())
    expect(proposal).toMatchObject({ state: "planning_failed" })
    const changes = await t.run((ctx) => ctx.db.query("workgraph_changes").collect())
    expect(JSON.stringify(changes)).not.toContain("unknown_source")
  })
})

// ── fixtures ──────────────────────────────────────────────────────────────

async function seedTenant(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", { name: "Acme", kind: "personal", created_at: 1, updated_at: 1 } as never)
    const userId = await ctx.db.insert("users", { token_identifier: "user-a", created_at: 1, updated_at: 1 } as never)
    return { orgId: orgId as Id<"orgs">, userId: userId as Id<"users"> }
  })
}

/**
 * Seeds one WorkGraph root (with a valid generation profile), one Work
 * Source at revision "revision-a", and one "planning"-state admission
 * proposal with a "source-plan-job" already queued against it — the same
 * fixture shape the old `sourcePlanningDb()` built, but with real Convex ids
 * for `organization_id`/`owner_user_id` instead of string literals.
 */
async function sourcePlanningFixture(t: ReturnType<typeof convexTest>) {
  const { orgId, userId } = await seedTenant(t)
  await t.run(async (ctx) => {
    await ctx.db.insert("workgraphs", {
      organization_id: orgId,
      owner_user_id: userId,
      id: "workgraph_default",
      defaults: { agent: "planner-agent", model: { providerId: "openai", modelId: "gpt-5" }, effort: "high" },
      row_version: 1,
      schema_version: 1,
      created_at: 1,
      updated_at: 1,
    } as never)
    await ctx.db.insert("work_sources", {
      organization_id: orgId,
      owner_user_id: userId,
      id: "source-a",
      workgraph_id: "workgraph_default",
      title: "Ship cloud",
      source_kind: "manual",
      metadata: {},
      latest_revision_id: "revision-a",
      latest_revision_number: 1,
      row_version: 1,
      schema_version: 1,
      created_at: 1,
      updated_at: 1,
    } as never)
    await ctx.db.insert("work_source_revisions", {
      organization_id: orgId,
      owner_user_id: userId,
      id: "revision-a",
      work_source_id: "source-a",
      revision_number: 1,
      content: "Deploy cloud",
      content_hash: "a".repeat(64),
      origin: {},
      created_by: { type: "system", id: "test" },
      schema_version: 1,
      created_at: 1,
    } as never)
    await ctx.db.insert("workgraph_admission_proposals", {
      organization_id: orgId,
      owner_user_id: userId,
      id: "proposal-a",
      workgraph_id: "workgraph_default",
      state: "planning",
      source: { work_source_id: "source-a", revision_id: "revision-a", content_hash: "a".repeat(64) },
      proposal_kind: "source_plan",
      planning_evidence: { placementMatches: [], duplicateMatches: [] },
      generation: { method: "planning", tryNumber: 0, queuedAt: 1 },
      provenance: {},
      row_version: 1,
      schema_version: 1,
      created_at: 1,
      updated_at: 1,
    } as never)
    await ctx.db.insert("workgraph_due_jobs", {
      organization_id: orgId,
      owner_user_id: userId,
      id: "source-plan-job",
      job_type: "source_plan",
      subject_id: "proposal-a",
      due_at: 1,
      status: "pending",
      lease_epoch: 0,
      payload: {
        proposalId: "proposal-a",
        source: { work_source_id: "source-a", revision_id: "revision-a", content_hash: "a".repeat(64) },
      },
      row_version: 1,
      schema_version: 1,
      created_at: 1,
      updated_at: 1,
    } as never)
  })
  return { orgId, userId }
}

async function targetedSourcePlanningFixture(t: ReturnType<typeof convexTest>) {
  const { orgId, userId } = await sourcePlanningFixture(t)
  await t.run(async (ctx) => {
    await ctx.db.insert("workgraph_streams", {
      organization_id: orgId,
      owner_user_id: userId,
      id: "stream-target",
      workgraph_id: "workgraph_default",
      title: "Existing launch Stream",
      lifecycle_state: "active",
      visibility: "visible",
      pinned: false,
      execution_defaults: {},
      activity: {},
      durable_effect_count: 0,
      source_revision_refs: [],
      provenance: {},
      row_version: 1,
      schema_version: 1,
      created_at: 1,
      updated_at: 1,
    } as never)
    const proposal = await sourcePlanProposalRow(ctx, orgId, userId)
    if (proposal) {
      await ctx.db.patch(proposal._id, {
        planning_evidence: { targetStreamId: "stream-target", placementMatches: [], duplicateMatches: [] },
      })
    }
  })
  return { orgId, userId }
}

async function startSourcePlanningSession(t: ReturnType<typeof convexTest>, orgId: Id<"orgs">, userId: Id<"users">) {
  const claims = (await t.mutation(api.workgraphBackground.claimSourcePlans, {
    organization_id: orgId,
    owner_user_id: userId,
    service_token: "service-secret",
    worker_id: "worker-a",
    now: 10,
    limit: 10,
  } as never)) as Array<Record<string, unknown>>
  await markSourcePlanSession(t, orgId, userId, { admission_confirmed: false, now: 11 })
  await markSourcePlanSession(t, orgId, userId, { admission_confirmed: true, now: 12 })
  return claims
}

function markSourcePlanSession(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  userId: Id<"users">,
  overrides: { admission_confirmed: boolean; now: number },
) {
  return t.mutation(api.workgraphBackground.markSourcePlanSession, {
    organization_id: orgId,
    owner_user_id: userId,
    service_token: "service-secret",
    job_id: "source-plan-job",
    lease_epoch: 1,
    worker_id: "worker-a",
    workspace_id: "workspace-a",
    session_id: "session-a",
    admission_confirmed: overrides.admission_confirmed,
    now: overrides.now,
  } as never)
}

function completeSourcePlan(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  userId: Id<"users">,
  overrides: { plan: unknown; now: number },
) {
  return t.mutation(api.workgraphBackground.completeSourcePlan, {
    organization_id: orgId,
    owner_user_id: userId,
    service_token: "service-secret",
    job_id: "source-plan-job",
    lease_epoch: 1,
    session_id: "session-a",
    plan: overrides.plan,
    now: overrides.now,
  } as never)
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

// ── row lookups (mirrors the production `by_tenant_id` access pattern) ────

function workgraphRootRow(ctx: { db: any }, orgId: Id<"orgs">, userId: Id<"users">) {
  return ctx.db
    .query("workgraphs")
    .withIndex("by_tenant_id", (q: any) => q.eq("organization_id", orgId).eq("owner_user_id", userId).eq("id", "workgraph_default"))
    .unique()
}

function sourcePlanJobRow(ctx: { db: any }, orgId: Id<"orgs">, userId: Id<"users">) {
  return ctx.db
    .query("workgraph_due_jobs")
    .withIndex("by_tenant_id", (q: any) => q.eq("organization_id", orgId).eq("owner_user_id", userId).eq("id", "source-plan-job"))
    .unique()
}

function sourcePlanProposalRow(ctx: { db: any }, orgId: Id<"orgs">, userId: Id<"users">) {
  return ctx.db
    .query("workgraph_admission_proposals")
    .withIndex("by_tenant_id", (q: any) => q.eq("organization_id", orgId).eq("owner_user_id", userId).eq("id", "proposal-a"))
    .unique()
}
