import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  claimControlEffects,
  claimLaunches,
  completeControlEffect,
  listRunning,
  markAttention,
  recordFailure,
  recordResult,
  renewWorkGraphAttemptLease,
  settleRejectedProvision,
} from "../../../../convex/workgraphRuntime"
import { ensureWorkGraph } from "../../../../convex/workspaces"
import { syncWorkGraphSession } from "../../../../convex/sessions"
import { createHostedWorkGraphRuntime, parseHostedRecapOutput, workGraphWorkspaceId } from "./hosted-runtime"
import type { ControlPlaneServices } from "../control-plane/services"
import { StreamReplacementResetSchema, WorkGraphAttemptToolNames } from "@claxedo/workgraph/contracts"

const previousToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "service-secret"
})
afterEach(() => {
  if (previousToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousToken
})

describe("hosted WorkGraph runtime outbox", () => {
  test("partitions workspace identity by organization, owner, and Stream scope", async () => {
    const first = await workGraphWorkspaceId("org-a", "owner-a", "stream-a")
    expect(await workGraphWorkspaceId("org-a", "owner-a", "stream-a")).toBe(first)
    expect(await workGraphWorkspaceId("org-b", "owner-a", "stream-a")).not.toBe(first)
    expect(await workGraphWorkspaceId("org-a", "owner-b", "stream-a")).not.toBe(first)
    expect(await workGraphWorkspaceId("org-a", "owner-a", "stream-b")).not.toBe(first)
  })

  test("retains hosted WorkGraph Sessions in the repository project", async () => {
    const db = new RuntimeDb({
      users: [{ _id: "user-a", token_identifier: "user-a" }],
      orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
      org_memberships: [{ _id: "org-member", org_id: "org-a", user_id: "user-a", role: "owner" }],
      projects: [{ _id: "project-row", project_id: "project-existing", org_id: "org-a", owner_user_id: "user-a" }],
      project_memberships: [{ _id: "project-member", project_id: "project-row", user_id: "user-a", role: "owner" }],
      workspaces: [
        {
          _id: "workspace-existing",
          workspace_id: "workspace-existing",
          org_id: "org-a",
          owner_user_id: "user-a",
          project_id: "project-existing",
          backing: "cloud-vm",
          access: "cloud",
          display_name: "Existing",
          repo_url: "https://github.com/claxedo/workgraph-target.git",
        },
      ],
      workspace_memberships: [],
      session_history: [],
      session_messages: [],
    })
    await handler(ensureWorkGraph)({ db } as never, {
      service_token: "service-secret",
      organization_id: "org-a",
      owner_user_id: "user-a",
      workspace_id: "wg-stream-a",
      display_name: "WorkGraph · Review",
      repo_url: "https://github.com/claxedo/workgraph-target.git",
      git_branch: "dev",
      home_region: "us-east",
    })
    expect(db.row("workspaces", "workspaces-2")).toMatchObject({
      workspace_id: "wg-stream-a",
      project_id: "project-existing",
      display_name: "WorkGraph · Review",
      repo_url: "https://github.com/claxedo/workgraph-target.git",
      git_branch: "dev",
    })
    await handler(ensureWorkGraph)({ db } as never, {
      service_token: "service-secret",
      organization_id: "org-a",
      owner_user_id: "user-a",
      workspace_id: "wg-stream-a",
    })
    expect(db.row("workspaces", "workspaces-2")).toMatchObject({
      project_id: "project-existing",
      display_name: "WorkGraph · Review",
      repo_url: "https://github.com/claxedo/workgraph-target.git",
    })
    await handler(syncWorkGraphSession)({ db } as never, {
      service_token: "service-secret",
      organization_id: "org-a",
      owner_user_id: "user-a",
      workspace_id: "wg-stream-a",
      session_id: "session-a",
      title: "Review",
      created_at: 10,
      updated_at: 20,
      messages: [
        { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "Review it" }] },
        { info: { id: "msg-assistant", role: "assistant" }, parts: [{ type: "text", text: "Done" }] },
      ],
    })
    expect(db.row("session_history", "session_history-1")).toMatchObject({
      session_id: "session-a",
      title: "Review",
      workspace_id: "workspaces-2",
    })
    expect(db.rowsFor("session_messages")).toHaveLength(2)
    expect(db.rowsFor("session_messages")[1]).toMatchObject({
      session_id: "session-a",
      role: "assistant",
      data: { info: { id: "msg-assistant" } },
    })
  })

  test("lets the synchronous admin pass reconcile Attempts without draining background queues", async () => {
    const mutations: Record<string, unknown>[] = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      {} as ControlPlaneServices,
      {
        executor: {
          mutation: async (_fn, args) => {
            mutations.push(args)
            if (args.limit === 500) return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            return []
          },
        },
      },
    )

    await expect(runtime?.reconcile({ background: false })).resolves.toEqual({ launched: [], results: [] })
    expect(mutations).toHaveLength(3)
    expect(mutations.some((args) => args.limit === 25)).toBe(false)
  })

  test("accepts only strict structured ordinary-Session Recap output", () => {
    expect(
      parseHostedRecapOutput(
        JSON.stringify({ summary: "Ready", actionableReferences: [{ type: "stream", id: "stream-a" }] }),
      ),
    ).toEqual({ summary: "Ready", actionableReferences: [{ type: "stream", id: "stream-a" }] })
    for (const value of [
      "plain text summary",
      JSON.stringify({ summary: "Missing references" }),
      JSON.stringify({ summary: "Unknown reference", actionableReferences: [{ type: "issue", id: "issue-a" }] }),
      JSON.stringify({
        summary: "Duplicate",
        actionableReferences: [
          { type: "stream", id: "stream-a" },
          { type: "stream", id: "stream-a" },
        ],
      }),
    ])
      expect(() => parseHostedRecapOutput(value)).toThrow()
  })

  test("recovers an expired durable Attempt after restart and fences stale completion", async () => {
    const db = new RuntimeDb({
      workgraph_attempts: [
        {
          _id: "attempt-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "attempt-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          state: "running",
          session_id: "session-a",
          envelope_id: "workspace-a",
          row_version: 1,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "attempt-a",
          epoch: 1,
          expires_at: 10,
          row_version: 1,
        },
      ],
      workgraph_work_items: [
        {
          _id: "item-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "item-a",
          state: "active",
          row_version: 1,
        },
      ],
      orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
    })
    await expect(
      renewWorkGraphAttemptLease({ db } as never, {
        organizationId: "org-a" as never,
        ownerUserId: "user-b" as never,
        attemptId: "attempt-a",
        expectedLeaseEpoch: 1,
        now: 20,
        durationMs: 300_000,
      }),
    ).resolves.toBeUndefined()

    const restarted = (await handler(listRunning)({ db } as never, {
      service_token: "service-secret",
      limit: 10,
      now: 20,
    })) as Array<{ attemptId: string; leaseEpoch: number }>
    expect(restarted).toMatchObject([
      {
        attemptId: "attempt-a",
        leaseEpoch: 2,
        activeLeaseAgeMs: 0,
        expiredRecovery: true,
      },
    ])
    expect(db.row("workgraph_leases", "lease-row")).toMatchObject({ epoch: 2, expires_at: 300_020 })
    await expect(
      renewWorkGraphAttemptLease({ db } as never, {
        organizationId: "org-a" as never,
        ownerUserId: "user-a" as never,
        attemptId: "attempt-a",
        expectedLeaseEpoch: 1,
        now: 21,
        durationMs: 300_000,
      }),
    ).resolves.toBeUndefined()
    await expect(
      handler(recordResult)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        attempt_id: "attempt-a",
        lease_epoch: 1,
        session_id: "session-a",
        summary: "stale",
        artifacts: [],
        now: 21,
      }),
    ).resolves.toEqual({ settled: false })
    const result = {
      service_token: "service-secret",
      organization_id: "org-a",
      owner_user_id: "user-a",
      attempt_id: "attempt-a",
      lease_epoch: 2,
      session_id: "session-a",
      summary: "current",
      artifacts: ["commit:abc"],
      now: 21,
    }
    await expect(handler(recordResult)({ db } as never, { ...result, summary: " " })).rejects.toThrow(
      "Attempt result summary must be non-empty",
    )
    await expect(handler(recordResult)({ db } as never, { ...result, artifacts: [" "] })).rejects.toThrow(
      "Attempt result artifacts must contain non-empty references",
    )
    await expect(handler(recordResult)({ db } as never, result)).resolves.toEqual({ settled: true })
    await expect(handler(recordResult)({ db } as never, result)).resolves.toEqual({ settled: true })
    expect(db.row("workgraph_attempts", "attempt-row")).toMatchObject({
      state: "result",
      result: { summary: "current" },
    })
    expect(db.row("workgraph_work_items", "item-row")).toMatchObject({ state: "result_ready" })
    expect(db.row("workgraph_attention_entries", "workgraph_attention_entries-1")).toMatchObject({
      owner_user_id: "user-a",
      kind: "work_item",
      id: "item-a",
      source_type: "workgraph_work_items",
    })
    expect(db.row("workgraph_attention_summaries", "workgraph_attention_summaries-1")).toMatchObject({ total: 1 })
  })

  test("projects a semantic Session failure as a retryable Task requiring owner attention", async () => {
    const db = new RuntimeDb({
      workgraph_attempts: [
        {
          _id: "attempt-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "attempt-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          state: "running",
          session_id: "session-a",
          row_version: 1,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "attempt-a",
          epoch: 1,
          expires_at: 100,
          row_version: 1,
        },
      ],
      workgraph_work_items: [
        {
          _id: "item-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "item-a",
          state: "active",
          row_version: 1,
        },
      ],
    })

    await expect(
      handler(recordFailure)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        attempt_id: "attempt-a",
        lease_epoch: 1,
        session_id: "session-a",
        reason: "Session execution failed",
        now: 20,
      }),
    ).resolves.toEqual({ settled: true })

    expect(db.row("workgraph_attempts", "attempt-row")).toMatchObject({ state: "failed", finished_at: 20 })
    expect(db.row("workgraph_work_items", "item-row")).toMatchObject({ state: "failed" })
    expect(db.row("workgraph_attention_entries", "workgraph_attention_entries-1")).toMatchObject({
      kind: "work_item",
      id: "item-a",
    })
  })

  test("records interrupt HTTP failure instead of acknowledging cancellation", async () => {
    const mutations = await runControlEffect({
      effectType: "interrupt_attempt",
      payload: { finalize: "cancel", sessionId: "session-a" },
      fetch: async () => new Response("failed", { status: 500 }),
    })
    expect(mutations[3]).toMatchObject({ ok: false, reason: expect.stringContaining("500") })
  })

  test("does not acknowledge interruption when Session placement is non-ready", async () => {
    const mutations = await runControlEffect({
      effectType: "interrupt_attempt",
      payload: { finalize: "cancel", sessionId: "session-a" },
      targetStatus: "provisioning",
    })
    expect(mutations[3]).toMatchObject({ ok: false, reason: expect.stringContaining("not ready") })
  })

  test("finalizes close by interrupting Sessions without destroying or releasing the workspace", async () => {
    const destroyed: string[] = []
    const released: string[] = []
    const mutations = await runControlEffect({
      effectType: "finalize_stream",
      payload: { finalize: "close", sessions: ["session-a"] },
      destroy: async () => {
        destroyed.push("destroyed")
        return { ok: true, status: "destroyed" }
      },
      release: async (workspaceId) => {
        released.push(workspaceId)
      },
    })
    expect(mutations[3]).toMatchObject({ ok: true })
    expect(destroyed).toEqual([])
    expect(released).toEqual([])
  })

  test("releases workspace ownership without destroying compute when deletion finalizes", async () => {
    const released: string[] = []
    const mutations = await runControlEffect({
      effectType: "finalize_stream",
      payload: { finalize: "delete", sessions: [] },
      destroy: async () => {
        throw new Error("delete finalization must not destroy compute")
      },
      release: async (workspaceId) => {
        released.push(workspaceId)
      },
    })
    expect(mutations[3]).toMatchObject({ ok: true })
    expect(released).toHaveLength(1)
  })

  test("does not acknowledge replacement reset when workspace destruction is rejected", async () => {
    const mutations = await runControlEffect({
      effectType: "cleanup_stream",
      payload: { finalize: "replace", sessions: [] },
      destroy: async () => ({ ok: false as const, reason: "runtime_lease_not_ready" }),
    })
    expect(mutations[3]).toMatchObject({
      ok: false,
      reason: "Hosted WorkGraph replacement reset failed: runtime_lease_not_ready",
    })
  })

  test("acknowledges an already-destroyed replacement workspace on retry", async () => {
    const mutations = await runControlEffect({
      effectType: "cleanup_stream",
      payload: { finalize: "replace", sessions: ["session-a"] },
      targetStatus: "provisioning",
      destroy: async () => ({ ok: false as const, reason: "runtime_lease_missing" }),
    })
    expect(mutations[3]).toMatchObject({ ok: true })
  })

  test("destroys a late claimed placement before settling its rejected launch fence", async () => {
    const mutations: Record<string, unknown>[] = []
    const destroyed: string[] = []
    const released: string[] = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
        CLAXEDO_PUBLIC_URL: "https://central.test",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
            destroy: async (workspaceId: string) => {
              destroyed.push(workspaceId)
              return { ok: true as const, status: "destroyed" as const }
            },
            release: async (workspaceId: string) => {
              released.push(workspaceId)
            },
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
            getRelayEndpoint: async () => "https://relay.test",
          },
        },
      } as unknown as ControlPlaneServices,
      {
        background: false,
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            if (mutations.length === 1)
              return [
                {
                  ownerUserId: "user-a",
                  orgId: "org-a",
                  outboxId: "launch-a",
                  attemptId: "attempt-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 1,
                  title: "Late work",
                  prompt: "Late work",
                  profile: {
                    environment: { kind: "hosted_workspace" },
                    harness: "claxedo-v2",
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "high",
                    tools: [],
                    connectionIds: [],
                  },
                },
              ]
            if (mutations.length === 2) return { accepted: false }
            if (mutations.length === 3) return { settled: true }
            return []
          },
        },
      },
    )

    await expect(runtime?.reconcile()).resolves.toMatchObject({
      launched: [{ settled: false, state: "cancelled" }],
    })
    expect(destroyed).toHaveLength(1)
    expect(released).toEqual(destroyed)
    expect(mutations[2]).toMatchObject({ outbox_id: "launch-a", attempt_id: "attempt-a" })
  })

  test("settles a rejected claimed placement behind the launch worker fence", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "launch-row",
          owner_user_id: "user-a",
          id: "launch-a",
          status: "claimed",
          claimed_by: "worker-a",
          claim_expires_at: 100,
          payload: { attemptId: "attempt-a" },
        },
      ],
    })
    await expect(
      handler(settleRejectedProvision)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "launch-a",
        attempt_id: "attempt-a",
        worker_id: "worker-a",
        now: 20,
      }),
    ).resolves.toEqual({ settled: true })
    expect(db.row("workgraph_outbox", "launch-row")).toMatchObject({
      status: "cancelled",
      claimed_by: undefined,
      claim_expires_at: undefined,
    })
  })

  test("publishes a schema-valid ordered replacement cleanup attention transition", async () => {
    const reset = {
      state: "pending" as const,
      proposalId: "proposal-a",
      previousSource: { workSourceId: "source-a", revisionId: "revision-a", contentHash: "a".repeat(64) },
      source: { workSourceId: "source-a", revisionId: "revision-b", contentHash: "b".repeat(64) },
      requestedAt: 10,
    }
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "control-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "control-a",
          stream_id: "stream-a",
          status: "claimed",
          claimed_by: "worker-a",
          attempt_count: 3,
          payload: { finalize: "replace", proposalId: "proposal-a" },
        },
      ],
      workgraph_streams: [
        {
          _id: "stream-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "stream-a",
          replacement_reset: reset,
          row_version: 4,
          updated_at: 10,
        },
      ],
      workgraph_change_cursors: [],
      workgraph_stream_sequences: [],
      workgraph_events: [],
      workgraph_changes: [],
    })
    await expect(
      handler(completeControlEffect)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        outbox_id: "control-a",
        worker_id: "worker-a",
        ok: false,
        reason: "workspace cleanup unavailable",
        now: 20,
      }),
    ).resolves.toEqual({ settled: true })
    expect(
      StreamReplacementResetSchema.parse(db.row("workgraph_streams", "stream-row")?.replacement_reset),
    ).toMatchObject({ state: "attention", proposalId: "proposal-a" })
    expect(db.row("workgraph_streams", "stream-row")).toMatchObject({ row_version: 5, updated_at: 20 })
    expect(db.rowsFor("workgraph_changes")).toMatchObject([
      {
        cursor: 1,
        resource_type: "stream",
        resource_id: "stream-a",
        change_type: "stream_replacement_reset_attention",
        payload: { reason: "workspace cleanup unavailable" },
      },
    ])
  })

  test("reclaims a claimed control effect only after its worker fence expires", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "control-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "control-a",
          stream_id: "stream-a",
          effect_type: "cleanup_stream",
          status: "claimed",
          claimed_by: "dead-worker",
          claim_expires_at: 1,
          available_at: 0,
          attempt_count: 1,
          payload: { finalize: "delete" },
        },
      ],
      orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
    })
    await expect(
      handler(claimControlEffects)({ db } as never, {
        service_token: "service-secret",
        worker_id: "worker-b",
        now: 10,
        limit: 10,
      }),
    ).resolves.toMatchObject([{ outboxId: "control-a" }])
    expect(db.row("workgraph_outbox", "control-row")).toMatchObject({ claimed_by: "worker-b", attempt_count: 2 })
  })

  test("keeps cancellation pending until the fenced interrupt acknowledgment", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "control-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "control-a",
          status: "claimed",
          claimed_by: "worker-a",
          payload: { finalize: "cancel", attemptId: "attempt-a" },
        },
      ],
      workgraph_attempts: [
        {
          _id: "attempt-row",
          owner_user_id: "user-a",
          id: "attempt-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          state: "running",
          cancellation: { state: "pending", requestedAt: 10 },
          row_version: 2,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "attempt-a",
        },
      ],
    })
    expect(db.row("workgraph_attempts", "attempt-row")).toMatchObject({
      state: "running",
      cancellation: { state: "pending" },
    })
    await expect(
      handler(completeControlEffect)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "control-a",
        worker_id: "worker-a",
        ok: true,
        now: 20,
      }),
    ).resolves.toEqual({ settled: true })
    expect(db.row("workgraph_attempts", "attempt-row")).toMatchObject({ state: "cancelled", finished_at: 20 })
    expect(db.row("workgraph_leases", "lease-row")).toBeUndefined()
  })

  test("does not finalize a no-session cancellation while its launch claim is still in flight", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "launch-row",
          owner_user_id: "user-a",
          id: "launch-a",
          idempotency_key: "attempt-a:launch",
          status: "claimed",
          claimed_by: "worker-launch",
        },
        {
          _id: "control-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "control-a",
          idempotency_key: "attempt-a:interrupt",
          status: "claimed",
          claimed_by: "worker-control",
          payload: { finalize: "cancel", attemptId: "attempt-a" },
        },
      ],
      workgraph_attempts: [
        {
          _id: "attempt-row",
          owner_user_id: "user-a",
          id: "attempt-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          state: "admitted",
          cancellation: { state: "pending" },
          row_version: 2,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "attempt-a",
        },
      ],
    })
    await expect(
      handler(completeControlEffect)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "control-a",
        worker_id: "worker-control",
        ok: true,
        now: 20,
      }),
    ).resolves.toEqual({ settled: false })
    expect(db.row("workgraph_attempts", "attempt-row")).toMatchObject({
      state: "admitted",
      cancellation: { state: "pending" },
    })

    await db.patch("launch-row", { status: "cancelled" })
    await db.patch("control-row", {
      payload: { finalize: "cancel", attemptId: "attempt-a", sessionId: "session-race" },
    })
    await expect(
      handler(completeControlEffect)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "control-a",
        worker_id: "worker-control",
        ok: true,
        observed_session_id: "session-race",
        now: 21,
      }),
    ).resolves.toEqual({ settled: true })
    expect(db.row("workgraph_attempts", "attempt-row")?.state).toBe("cancelled")
  })

  test("keeps a deleting Stream durable until workspace ownership release is acknowledged", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "control-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "control-a",
          stream_id: "stream-a",
          status: "claimed",
          claimed_by: "worker-a",
          payload: { finalize: "delete" },
        },
      ],
      workgraph_streams: [
        {
          _id: "stream-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "stream-a",
          lifecycle_state: "active",
          deletion: { state: "pending", requestedAt: 10 },
        },
      ],
      workgraph_attempts: [
        {
          _id: "attempt-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "attempt-a",
          stream_id: "stream-a",
          state: "running",
          cancellation: { state: "pending" },
        },
      ],
    })
    expect(db.row("workgraph_streams", "stream-row")).toMatchObject({
      lifecycle_state: "active",
      deletion: { state: "pending" },
    })
    await expect(
      handler(completeControlEffect)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        outbox_id: "control-a",
        worker_id: "worker-a",
        ok: true,
        now: 20,
      }),
    ).resolves.toEqual({ settled: true })
    expect(db.row("workgraph_streams", "stream-row")).toBeUndefined()
    expect(db.row("workgraph_attempts", "attempt-row")).toBeUndefined()
    await expect(
      handler(completeControlEffect)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        outbox_id: "control-a",
        worker_id: "worker-a",
        ok: true,
        now: 21,
      }),
    ).resolves.toEqual({ settled: true })
  })

  test("keeps close pending in valid public states and finalizes only after Session interruption acknowledgment", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "control-row",
          owner_user_id: "user-a",
          id: "control-a",
          stream_id: "stream-a",
          status: "claimed",
          claimed_by: "worker-a",
          payload: { finalize: "close" },
        },
      ],
      workgraph_streams: [
        {
          _id: "stream-row",
          owner_user_id: "user-a",
          id: "stream-a",
          lifecycle_state: "active",
          closure: { state: "pending", reason: "Done" },
          row_version: 2,
        },
      ],
      workgraph_attempts: [
        {
          _id: "attempt-row",
          owner_user_id: "user-a",
          id: "attempt-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          state: "running",
          cancellation: { state: "pending" },
          row_version: 2,
        },
      ],
      workgraph_work_items: [
        {
          _id: "item-row",
          owner_user_id: "user-a",
          id: "item-a",
          stream_id: "stream-a",
          state: "active",
          row_version: 2,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          owner_user_id: "user-a",
          stream_id: "stream-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "attempt-a",
        },
      ],
    })
    expect(db.row("workgraph_streams", "stream-row")).toMatchObject({
      lifecycle_state: "active",
      closure: { state: "pending" },
    })
    expect(db.row("workgraph_work_items", "item-row")?.state).toBe("active")
    await handler(completeControlEffect)({ db } as never, {
      service_token: "service-secret",
      owner_user_id: "user-a",
      outbox_id: "control-a",
      worker_id: "worker-a",
      ok: true,
      now: 20,
    })
    expect(db.row("workgraph_streams", "stream-row")).toMatchObject({
      lifecycle_state: "closed",
      closure: { state: "completed" },
    })
    expect(db.row("workgraph_work_items", "item-row")?.state).toBe("abandoned")
    expect(db.row("workgraph_attempts", "attempt-row")?.state).toBe("cancelled")
  })

  test("reconciles a hosted Recap whose terminal event is on the second history page", async () => {
    const mutations: Record<string, unknown>[] = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
            target: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
            getRelayEndpoint: async () => "https://relay.test",
          },
        },
        defaultHomeRegion: "us-east",
      } as unknown as ControlPlaneServices,
      {
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            if (mutations.length <= 3) return []
            if (mutations.length === 4) return { completed: 1 }
            if (mutations.length === 5)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  jobId: "recap-job",
                  leaseEpoch: 1,
                  streamId: "stream-a",
                  prompt: "Summarize bounded changes",
                  profile: {
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "medium",
                    tools: [],
                  },
                },
              ]
            if (mutations.length === 6 || mutations.length === 7) return { settled: true }
            if (mutations.length === 8)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  jobId: "recap-job",
                  leaseEpoch: 1,
                  sessionId: "ses_workgraph_recap_recap-job_1",
                  workspaceId: String(mutations[5]?.workspace_id),
                },
              ]
            if (mutations.length === 9) return { settled: true }
            return []
          },
        },
        fetch: async (input, init) => {
          const url = new URL(String(input))
          if (url.pathname.endsWith("/api/session")) {
            const body = JSON.parse(String(init?.body))
            expect(body).toMatchObject({
              id: "ses_workgraph_recap_recap-job_1",
              tools: [],
              location: { directory: "/workspace" },
            })
            return Response.json({ id: body.id })
          }
          if (url.pathname.endsWith("/history") && url.searchParams.get("after") === "0")
            return Response.json({
              data: [
                {
                  type: "session.next.text.ended",
                  durable: { seq: 1 },
                  data: {
                    text: JSON.stringify({ summary: "Launch is ready; billing remains.", actionableReferences: [] }),
                  },
                },
              ],
              hasMore: true,
            })
          if (url.pathname.endsWith("/history") && url.searchParams.get("after") === "1")
            return Response.json({
              data: [{ type: "session.next.step.ended", durable: { seq: 2 }, data: {} }],
              hasMore: false,
            })
          return Response.json({ data: { admitted: true } })
        },
      },
    )

    await expect(runtime?.reconcile()).resolves.toMatchObject({
      background: {
        controls: [],
        intake: { completed: 1 },
        launched: [{ state: "running" }],
        results: [{ settled: true }],
      },
    })
    expect(mutations).toContainEqual(
      expect.objectContaining({ job_id: "recap-job", summary: "Launch is ready; billing remains." }),
    )
  })

  test("replays the same hosted Recap Session and prompt after a lost prompt response", async () => {
    const mutations: Record<string, unknown>[] = []
    const sessionBodies: Array<Record<string, unknown>> = []
    const promptBodies: Array<Record<string, unknown>> = []
    const admittedMessages = new Set<string>()
    const claim = (leaseEpoch: number) => ({
      ownerUserId: "internal-user-a",
      orgId: "org-a",
      jobId: "recap-lost",
      leaseEpoch,
      streamId: "stream-a",
      ...(leaseEpoch === 2 ? { sessionId: "ses_workgraph_recap_recap-lost_1" } : {}),
      prompt: "Summarize bounded changes",
      profile: {
        agent: "build",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "medium",
        tools: [],
      },
    })
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
            target: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
            getRelayEndpoint: async () => "https://relay.test",
          },
        },
        defaultHomeRegion: "us-east",
      } as unknown as ControlPlaneServices,
      {
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            const call = mutations.length
            if ([1, 2, 3, 7, 8, 9, 10, 11, 12, 19, 20].includes(call)) return []
            if (call === 4 || call === 13) return { completed: 0 }
            if (call === 5) return [claim(1)]
            if (call === 14) return [claim(2)]
            if ([6, 15, 16, 18].includes(call)) return { settled: true }
            if (call === 17)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  jobId: "recap-lost",
                  leaseEpoch: 2,
                  sessionId: "ses_workgraph_recap_recap-lost_1",
                  workspaceId: String(mutations[14]?.workspace_id),
                },
              ]
            throw new Error(`Unexpected mutation ${call}`)
          },
        },
        fetch: async (input, init) => {
          const url = new URL(String(input))
          if (url.pathname.endsWith("/api/session")) {
            const body = JSON.parse(String(init?.body))
            sessionBodies.push(body)
            return Response.json({ id: body.id })
          }
          if (url.pathname.endsWith("/prompt")) {
            const body = JSON.parse(String(init?.body))
            promptBodies.push(body)
            admittedMessages.add(body.id)
            if (promptBodies.length === 1) throw new Error("response lost after durable prompt admission")
            return Response.json({ data: { admitted: true } })
          }
          if (url.pathname.endsWith("/history"))
            return Response.json({
              data: [
                {
                  type: "session.next.text.ended",
                  data: {
                    text: JSON.stringify({ summary: "Launch is ready.", actionableReferences: [] }),
                  },
                },
                { type: "session.next.step.ended", data: {} },
              ],
              hasMore: false,
            })
          return Response.json({ data: {} })
        },
      },
    )

    await expect(runtime?.reconcile()).resolves.toMatchObject({
      background: { launched: [{ state: "running", settled: false }], results: [] },
    })
    await expect(runtime?.reconcile()).resolves.toMatchObject({
      background: { launched: [{ state: "running", settled: true }], results: [{ settled: true }] },
    })
    expect(sessionBodies).toEqual([
      expect.objectContaining({ id: "ses_workgraph_recap_recap-lost_1" }),
      expect.objectContaining({ id: "ses_workgraph_recap_recap-lost_1" }),
    ])
    expect(promptBodies).toEqual([
      expect.objectContaining({ id: "msg_recap_recap-lost" }),
      expect.objectContaining({ id: "msg_recap_recap-lost" }),
    ])
    expect(admittedMessages.size).toBe(1)
    expect(mutations.filter((mutation) => "summary" in mutation)).toHaveLength(1)
  })

  test("reconciles hosted source planning whose terminal event is on the second history page", async () => {
    const mutations: Record<string, unknown>[] = []
    const prompts: Array<Record<string, unknown>> = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
            target: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
            getRelayEndpoint: async () => "https://relay.test",
          },
        },
        defaultHomeRegion: "us-east",
      } as unknown as ControlPlaneServices,
      {
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            if (mutations.length <= 3) return []
            if (mutations.length === 4) return { completed: 0 }
            if (mutations.length <= 6) return []
            if (mutations.length === 7)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  jobId: "source-plan-job",
                  leaseEpoch: 1,
                  proposalId: "proposal-a",
                  prompt: "Analyze exact source",
                  profile: {
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "medium",
                    tools: [],
                  },
                },
              ]
            if (mutations.length === 8 || mutations.length === 9) return { settled: true }
            if (mutations.length === 10)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  jobId: "source-plan-job",
                  leaseEpoch: 1,
                  sessionId: "ses_workgraph_source-plan-job_1",
                  workspaceId: String(mutations[7]?.workspace_id),
                },
              ]
            return { settled: true }
          },
        },
        fetch: async (input, init) => {
          const url = new URL(String(input))
          if (url.pathname.endsWith("/api/session")) {
            expect(JSON.parse(String(init?.body))).toMatchObject({ id: "ses_workgraph_source-plan-job_1", tools: [] })
            return Response.json({ id: "ses_workgraph_source-plan-job_1" })
          }
          if (url.pathname.endsWith("/prompt")) {
            prompts.push(JSON.parse(String(init?.body)))
            return Response.json({ data: { admitted: true } })
          }
          if (url.pathname.endsWith("/history") && url.searchParams.get("after") === "0")
            return Response.json({
              data: [
                {
                  type: "session.next.text.ended",
                  durable: { seq: 1 },
                  data: {
                    text: JSON.stringify({
                      source: { workSourceId: "source-a", revisionId: "revision-a", contentHash: "a".repeat(64) },
                      suggestedPlacement: { mode: "new_stream", streamTitle: "Ship cloud" },
                      placementMatches: [],
                      proposedOutcomes: [
                        { key: "ship", title: "Cloud shipped", successCriteria: ["Healthy"], execution: {} },
                      ],
                      proposedWorkItems: [
                        {
                          key: "deploy",
                          outcomeKey: "ship",
                          title: "Deploy",
                          dependencyKeys: [],
                          execution: {},
                          completionContract: {
                            version: 1,
                            mode: "all",
                            requirements: [
                              { id: "healthy", kind: "owner_confirmation", description: "Owner verifies health" },
                            ],
                          },
                        },
                      ],
                      duplicateMatches: [],
                    }),
                  },
                },
              ],
              hasMore: true,
            })
          if (url.pathname.endsWith("/history") && url.searchParams.get("after") === "1")
            return Response.json({
              data: [{ type: "session.next.step.ended", durable: { seq: 2 }, data: {} }],
              hasMore: false,
            })
          return Response.json({ data: {} })
        },
      },
    )

    await expect(runtime?.reconcile()).resolves.toMatchObject({
      background: { sourcePlanning: { launched: [{ state: "running" }], results: [{ settled: true }] } },
    })
    expect(prompts).toEqual([
      expect.objectContaining({
        id: "msg_workgraph_source-plan-job",
        delivery: "steer",
        resume: true,
      }),
    ])
    expect(mutations).toContainEqual(
      expect.objectContaining({
        job_id: "source-plan-job",
        session_id: "ses_workgraph_source-plan-job_1",
        plan: expect.objectContaining({ proposedWorkItems: [expect.objectContaining({ title: "Deploy" })] }),
      }),
    )
  })

  test("replays the same hosted source-planning Session and prompt after a lost prompt response", async () => {
    const mutations: Record<string, unknown>[] = []
    const sessionBodies: Array<Record<string, unknown>> = []
    const promptBodies: Array<Record<string, unknown>> = []
    const claim = (leaseEpoch: number) => ({
      ownerUserId: "internal-user-a",
      orgId: "org-a",
      jobId: "source-plan-lost",
      leaseEpoch,
      proposalId: "proposal-a",
      ...(leaseEpoch === 2 ? { sessionId: "ses_workgraph_source-plan-lost_1" } : {}),
      prompt: "Analyze exact source",
      profile: {
        agent: "build",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "medium",
        tools: [],
      },
    })
    const runtime = createHostedWorkGraphRuntime(
      { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test", CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
            target: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
            getRelayEndpoint: async () => "https://relay.test",
          },
        },
        defaultHomeRegion: "us-east",
      } as unknown as ControlPlaneServices,
      {
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            const call = mutations.length
            if ([1, 2, 3, 5, 6, 9, 10, 11, 12, 14, 15].includes(call)) return []
            if (call === 4 || call === 13) return { completed: 0 }
            if (call === 7) return [claim(1)]
            if (call === 16) return [claim(2)]
            if ([8, 17, 18, 20].includes(call)) return { settled: true }
            if (call === 19)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  jobId: "source-plan-lost",
                  leaseEpoch: 2,
                  sessionId: "ses_workgraph_source-plan-lost_1",
                  workspaceId: String(mutations[16]?.workspace_id),
                },
              ]
            throw new Error(`Unexpected mutation ${call}`)
          },
        },
        fetch: async (input, init) => {
          const url = new URL(String(input))
          if (url.pathname.endsWith("/api/session")) {
            const body = JSON.parse(String(init?.body))
            sessionBodies.push(body)
            return Response.json({ id: body.id })
          }
          if (url.pathname.endsWith("/prompt")) {
            promptBodies.push(JSON.parse(String(init?.body)))
            if (promptBodies.length === 1) throw new Error("response lost after durable prompt admission")
            return Response.json({ data: { admitted: true } })
          }
          if (url.pathname.endsWith("/history"))
            return Response.json({
              data: [
                {
                  type: "session.next.text.ended",
                  data: {
                    text: JSON.stringify({
                      source: { workSourceId: "source-a", revisionId: "revision-a", contentHash: "a".repeat(64) },
                      suggestedPlacement: { mode: "new_stream", streamTitle: "Ship cloud" },
                      placementMatches: [],
                      proposedOutcomes: [
                        { key: "ship", title: "Cloud shipped", successCriteria: ["Healthy"], execution: {} },
                      ],
                      proposedWorkItems: [
                        {
                          key: "deploy",
                          outcomeKey: "ship",
                          title: "Deploy",
                          dependencyKeys: [],
                          execution: {},
                          completionContract: {
                            version: 1,
                            mode: "all",
                            requirements: [
                              { id: "healthy", kind: "owner_confirmation", description: "Owner verifies health" },
                            ],
                          },
                        },
                      ],
                      duplicateMatches: [],
                    }),
                  },
                },
                { type: "session.next.step.ended", data: {} },
              ],
              hasMore: false,
            })
          return Response.json({ data: {} })
        },
      },
    )

    await expect(runtime?.reconcile()).resolves.toMatchObject({
      background: { sourcePlanning: { launched: [{ state: "running", settled: false }], results: [] } },
    })
    await expect(runtime?.reconcile()).resolves.toMatchObject({
      background: { sourcePlanning: { launched: [{ state: "running", settled: true }], results: [{ settled: true }] } },
    })
    expect(sessionBodies).toEqual([
      expect.objectContaining({ id: "ses_workgraph_source-plan-lost_1" }),
      expect.objectContaining({ id: "ses_workgraph_source-plan-lost_1" }),
    ])
    expect(promptBodies).toEqual([
      expect.objectContaining({ id: "msg_workgraph_source-plan-lost" }),
      expect.objectContaining({ id: "msg_workgraph_source-plan-lost" }),
    ])
    expect(mutations.filter((mutation) => "plan" in mutation)).toHaveLength(1)
  })

  test("fails a Connection-bound claim closed without provisioning an unbound Session", async () => {
    let provisioned = false
    const mutations: Record<string, unknown>[] = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => {
              provisioned = true
              throw new Error("unexpected")
            },
          },
        },
        relay: {},
      } as unknown as ControlPlaneServices,
      {
        background: false,
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            if (mutations.length === 1)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  outboxId: "outbox-a",
                  attemptId: "attempt-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 2,
                  title: "Connected",
                  prompt: "Use it",
                  profile: {
                    environment: { kind: "hosted_workspace" },
                    harness: "opencode",
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "high",
                    tools: ["terminal"],
                    connectionIds: ["connection-a"],
                  },
                },
              ]
            if (mutations.length === 2) return { settled: true }
            return []
          },
        },
      },
    )

    await runtime?.reconcile()
    expect(provisioned).toBe(false)
    expect(mutations[1]).toMatchObject({ reason: expect.stringContaining("explicit Connection tools") })
  })

  test("binds scoped Attempt and Connection tools before prompting without inferring completion", async () => {
    const mutations: Record<string, unknown>[] = []
    const mintedTokens: Record<string, unknown>[] = []
    const ensureInputs: Record<string, unknown>[] = []
    const publishedLaunches: Record<string, unknown>[] = []
    const publishedSnapshots: Record<string, unknown>[] = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
        CLAXEDO_PUBLIC_URL: "https://central.test",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async (_workspaceId: string, input: Record<string, unknown>) => {
              ensureInputs.push(input)
              return {
                status: "ready",
                sandboxId: "sandbox",
                url: "https://runtime.test",
                hostId: "host-a",
                epoch: 1,
                homeRegion: "us-east",
              }
            },
            target: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: async (input: Record<string, unknown>) => {
              mintedTokens.push(input)
              return { token: "runtime-token", expiresAt: 1000, jti: "jti" }
            },
            getRelayEndpoint: async () => "https://relay.test",
          },
        },
        defaultHomeRegion: "us-east",
      } as unknown as ControlPlaneServices,
      {
        background: false,
        now: (() => {
          let value = 10
          return () => value++
        })(),
        sessionPublisher: {
          launch: async (input) => {
            publishedLaunches.push(input)
          },
          snapshot: async (input) => {
            publishedSnapshots.push(input)
          },
        },
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            if (mutations.length === 1)
              return [
                {
                  ownerUserId: "internal-user-a",
                  ownerSubject: "clerk-user-a",
                  orgId: "org-a",
                  outboxId: "outbox-a",
                  attemptId: "attempt-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 2,
                  title: "No-op",
                  prompt: "Return done",
                  profile: {
                    environment: {
                      kind: "hosted_workspace",
                      repositoryUrl: "https://github.com/claxedo/workgraph-target.git",
                    },
                    repository: { baseRevision: "release" },
                    harness: "opencode",
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "high",
                    tools: ["connection_work_source_list"],
                    connectionIds: ["connection-a"],
                  },
                },
              ]
            if (mutations.length === 2) return { accepted: true }
            if (mutations.length === 5)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  attemptId: "attempt-a",
                  leaseEpoch: 2,
                  sessionId: "session-a",
                  workspaceId: String(mutations[2]?.workspace_id),
                },
              ]
            return { settled: true }
          },
        },
        fetch: async (input, init) => {
          const url = new URL(String(input))
          expect(init?.headers).toBeDefined()
          if (url.pathname.endsWith("/api/session")) {
            expect(JSON.parse(String(init?.body))).toEqual({
              agent: "build",
              model: { providerID: "openai", id: "gpt-5", variant: "high" },
              tools: ["connection_work_source_list", ...WorkGraphAttemptToolNames],
              location: { directory: "/workspace" },
            })
            return Response.json({ id: "session-a" }, { status: 201 })
          }
          if (url.pathname.endsWith("/api/workgraph/connection-binding")) {
            expect(new Headers(init?.headers).get("x-claxedo-workgraph-broker-token")).toBe("runtime-token")
            expect(JSON.parse(String(init?.body))).toEqual({
              version: 1,
              identity: {
                attemptId: "attempt-a",
                sessionId: "session-a",
                workspaceId: String(mutations[2]?.workspace_id),
              },
              connectionIds: ["connection-a"],
              tools: ["connection_work_source_list"],
              brokerUrl: "https://central.test",
            })
            return Response.json({ bound: true })
          }
          if (url.pathname.endsWith("/api/workgraph/attempt-binding")) {
            expect(new Headers(init?.headers).get("x-claxedo-workgraph-broker-token")).toBe("runtime-token")
            expect(JSON.parse(String(init?.body))).toEqual({
              version: 1,
              identity: {
                attemptId: "attempt-a",
                sessionId: "session-a",
                workspaceId: String(mutations[2]?.workspace_id),
                leaseEpoch: 2,
              },
              brokerUrl: "https://central.test",
            })
            return Response.json({ bound: true })
          }
          if (url.pathname.endsWith("/prompt")) {
            expect(JSON.parse(String(init?.body))).toMatchObject({
              prompt: {
                text: expect.stringContaining("A text response without this tool call does not complete the Attempt"),
              },
            })
            expect(JSON.parse(String(init?.body))).toMatchObject({
              prompt: { text: expect.stringContaining('"evidence":{"kind":"test_result"') },
            })
            return Response.json({ data: { admitted: true } })
          }
          if (url.pathname.endsWith("/history"))
            return Response.json({
              data: [
                { type: "session.next.text.ended", data: { text: "done" } },
                { type: "session.next.step.ended", data: { files: ["result.txt"] } },
              ],
              hasMore: false,
            })
          if (url.pathname.endsWith("/message")) {
            expect(url.searchParams.get("snapshot")).toBe("1")
            return Response.json([
              { info: { id: "msg_user", role: "user" }, parts: [{ type: "text", text: "Return done" }] },
              { info: { id: "msg_assistant", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
            ])
          }
          return Response.json({ data: { admitted: true } })
        },
      },
    )
    await expect(runtime?.reconcile()).resolves.toMatchObject({
      launched: [{ state: "running" }],
      results: [{ settled: false, state: "awaiting_explicit_completion" }],
    })
    expect(mintedTokens[0]).toMatchObject({ subject: "clerk-user-a", orgId: "org-a" })
    expect(mutations).toHaveLength(5)
    expect(ensureInputs[0]).toMatchObject({
      env: {
        WORKSPACE_RUNTIME_RUNNER: "opencode",
        WORKSPACE_RUNTIME_WORKGRAPH_BROKER_ORIGIN: "https://central.test",
      },
      source: {
        kind: "git",
        repoUrl: "https://github.com/claxedo/workgraph-target.git",
        branch: "release",
      },
    })
    expect(mutations[2]).toMatchObject({ workspace_id: expect.stringMatching(/^wg-/), session_id: "session-a" })
    expect(mutations[3]).toMatchObject({
      attemptId: "attempt-a",
      sessionId: "session-a",
      connectionIds: ["connection-a"],
      tools: ["connection_work_source_list"],
    })
    expect(mutations).not.toContainEqual(expect.objectContaining({ summary: "done", artifacts: ["file:result.txt"] }))
    expect(publishedLaunches).toEqual([
      expect.objectContaining({
        organizationId: "org-a",
        ownerUserId: "internal-user-a",
        sessionId: "session-a",
        title: "No-op",
        repoUrl: "https://github.com/claxedo/workgraph-target.git",
        branch: "release",
      }),
    ])
    expect(publishedSnapshots).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        messages: [
          expect.objectContaining({ info: expect.objectContaining({ id: "msg_user" }) }),
          expect.objectContaining({ info: expect.objectContaining({ id: "msg_assistant" }) }),
        ],
      }),
    ])
  })

  test("records session_output_missing instead of fabricating hosted success", async () => {
    for (const data of [
      [{ type: "session.next.step.ended", data: { files: [] } }],
      [
        { type: "session.next.text.ended", data: { text: "   " } },
        { type: "session.next.step.ended", data: { files: [] } },
      ],
    ]) {
      const { mutations, result } = await reconcileAttemptHistory({ data, hasMore: false })
      expect(result).toMatchObject({ results: [{ settled: true }] })
      expect(mutations[2]).toMatchObject({
        session_id: "session-a",
        reason: "session_output_missing",
      })
      expect(mutations[2]).not.toHaveProperty("summary")
    }
  })

  test("records session_history_invalid for malformed or missing hosted history data", async () => {
    for (const history of [
      { hasMore: false },
      { data: [], hasMore: "false" },
      { data: [{ type: "session.next.step.ended", data: null }], hasMore: false },
    ]) {
      const { mutations, result } = await reconcileAttemptHistory(history)
      expect(result).toMatchObject({ results: [{ settled: true }] })
      expect(mutations[2]).toMatchObject({
        session_id: "session-a",
        reason: "session_history_invalid",
      })
    }
  })

  test("durably compensates when cancellation wins after the final launch fence", async () => {
    const mutations: Record<string, unknown>[] = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
        CLAXEDO_PUBLIC_URL: "https://central.test",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
            getRelayEndpoint: async () => "https://relay.test",
          },
        },
      } as unknown as ControlPlaneServices,
      {
        background: false,
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            if (mutations.length === 1)
              return [
                {
                  ownerUserId: "user-a",
                  orgId: "org-a",
                  outboxId: "outbox-a",
                  attemptId: "attempt-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 2,
                  title: "Race",
                  prompt: "Run",
                  profile: {
                    environment: { kind: "hosted_workspace" },
                    harness: "opencode",
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "high",
                    tools: [],
                    connectionIds: [],
                  },
                },
              ]
            if (mutations.length === 2) return { accepted: true }
            if (mutations.length === 3) return { settled: false }
            if (mutations.length === 4) return { settled: true }
            return []
          },
        },
        fetch: async (url) =>
          String(url).endsWith("/api/session") ? Response.json({ id: "session-race" }) : Response.json({}),
      },
    )
    await runtime?.reconcile()
    expect(mutations[3]).toMatchObject({
      attempt_id: "attempt-a",
      session_id: "session-race",
      workspace_id: expect.stringMatching(/^wg-/),
    })
  })

  test("durably compensates an indeterminate mark-running failure after Session creation", async () => {
    const mutations: Record<string, unknown>[] = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
        CLAXEDO_PUBLIC_URL: "https://central.test",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
            getRelayEndpoint: async () => "https://relay.test",
          },
        },
      } as unknown as ControlPlaneServices,
      {
        background: false,
        executor: {
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            if (mutations.length === 1)
              return [
                {
                  ownerUserId: "user-a",
                  orgId: "org-a",
                  outboxId: "launch-a",
                  attemptId: "attempt-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 1,
                  title: "Indeterminate launch",
                  prompt: "Run",
                  profile: {
                    environment: { kind: "hosted_workspace" },
                    harness: "claxedo-v2",
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "high",
                    tools: [],
                    connectionIds: [],
                  },
                },
              ]
            if (mutations.length === 2) return { accepted: true }
            if (mutations.length === 3) throw new Error("mark-running response lost")
            if (mutations.length === 4) return { settled: true }
            return []
          },
        },
        fetch: async (url) =>
          String(url).endsWith("/api/session") ? Response.json({ id: "session-indeterminate" }) : Response.json({}),
      },
    )

    await expect(runtime?.reconcile()).resolves.toMatchObject({
      launched: [{ settled: false, state: "compensating", reason: "mark-running response lost" }],
    })
    expect(mutations[3]).toMatchObject({
      attempt_id: "attempt-a",
      session_id: "session-indeterminate",
      workspace_id: expect.stringMatching(/^wg-/),
    })
  })

  test("claims an admitted fenced Attempt and records truthful attention", async () => {
    const db = new RuntimeDb({
      users: [{ _id: "user-a", clerk_subject: "clerk-user-a" }],
      workgraph_outbox: [
        {
          _id: "outbox-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "outbox-a",
          effect_type: "launch_attempt",
          status: "pending",
          available_at: 1,
          attempt_count: 0,
          payload: { attemptId: "attempt-a", leaseEpoch: 2 },
        },
      ],
      workgraph_attempts: [
        {
          _id: "attempt-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "attempt-a",
          work_item_id: "item-a",
          stream_id: "stream-a",
          state: "admitted",
          resolved_execution: {
            environment: { kind: "hosted_workspace" },
            connectionIds: ["connection-source"],
          },
          row_version: 1,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "attempt-a",
          epoch: 2,
          expires_at: 1_000,
          row_version: 1,
        },
      ],
      workgraph_work_items: [
        {
          _id: "item-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "item-a",
          title: "Resolve CLX-101",
          description: "Provider issue CLX-101 requests a launch-readiness fix.",
          completion_contract: {
            version: 1,
            mode: "all",
            requirements: [{ id: "proof", kind: "test", description: "Tests pass" }],
          },
        },
      ],
      orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
    })
    const claims = (await handler(claimLaunches)({ db } as never, {
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    })) as Array<{ outboxId: string; attemptId: string; leaseEpoch: number; prompt: string; ownerSubject: string }>
    expect(claims).toMatchObject([
      {
        outboxId: "outbox-a",
        attemptId: "attempt-a",
        ownerSubject: "clerk-user-a",
        leaseEpoch: 2,
        queueLagMs: 9,
        activeLeaseAgeMs: 0,
        expiredRecovery: false,
        retryCount: 0,
      },
    ])
    expect(claims[0]?.prompt).toContain("Resolve CLX-101")
    expect(claims[0]?.prompt).toContain("Provider issue CLX-101 requests a launch-readiness fix.")
    expect(claims[0]?.prompt).toContain('"id":"proof"')
    expect(claims[0]?.prompt).toContain("Trusted Connection handles:\n- connection-source")
    expect(db.row("workgraph_outbox", "outbox-row")).toMatchObject({
      status: "claimed",
      claimed_by: "worker-a",
      attempt_count: 1,
    })

    await expect(
      handler(markAttention)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        attempt_id: "attempt-a",
        lease_epoch: 2,
        worker_id: "worker-a",
        reason: "Session API missing",
        now: 20,
      }),
    ).resolves.toEqual({ settled: true })
    expect(db.row("workgraph_attempts", "attempt-row")).toMatchObject({
      state: "attention",
      attention_reason: "Session API missing",
      row_version: 2,
    })
    expect(db.row("workgraph_outbox", "outbox-row")).toMatchObject({
      status: "failed",
      last_error: "Session API missing",
    })
  })

  test("rejects a stale lease epoch without mutating the Attempt", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        { _id: "outbox-row", owner_user_id: "user-a", id: "outbox-a", status: "claimed", claimed_by: "worker-a" },
      ],
      workgraph_attempts: [
        {
          _id: "attempt-row",
          owner_user_id: "user-a",
          id: "attempt-a",
          work_item_id: "item-a",
          state: "admitted",
          row_version: 1,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "attempt-a",
          epoch: 3,
        },
      ],
    })
    await expect(
      handler(markAttention)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        attempt_id: "attempt-a",
        lease_epoch: 2,
        worker_id: "worker-a",
        reason: "stale",
        now: 20,
      }),
    ).resolves.toEqual({ settled: false })
    expect(db.row("workgraph_attempts", "attempt-row")).toMatchObject({ state: "admitted", row_version: 1 })
  })

  test("recovers an expired admitted launch after restart and fences its old callback epoch", async () => {
    const db = new RuntimeDb({
      users: [{ _id: "user-a", clerk_subject: "clerk-user-a" }],
      workgraph_outbox: [
        {
          _id: "outbox-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "outbox-a",
          effect_type: "launch_attempt",
          status: "pending",
          available_at: 1,
          attempt_count: 0,
          payload: { attemptId: "attempt-a", leaseEpoch: 1 },
        },
      ],
      workgraph_attempts: [
        {
          _id: "attempt-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "attempt-a",
          work_item_id: "item-a",
          stream_id: "stream-a",
          state: "admitted",
          resolved_execution: { environment: { kind: "hosted_workspace" } },
          row_version: 1,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "attempt-a",
          epoch: 1,
          expires_at: 5,
          row_version: 1,
        },
      ],
      workgraph_work_items: [
        { _id: "item-row", organization_id: "org-a", owner_user_id: "user-a", id: "item-a", title: "Resume launch" },
      ],
      orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
    })
    const claims = (await handler(claimLaunches)({ db } as never, {
      service_token: "service-secret",
      worker_id: "worker-restarted",
      now: 10,
      limit: 10,
    })) as Array<{ attemptId: string; leaseEpoch: number }>
    expect(claims).toMatchObject([{ attemptId: "attempt-a", leaseEpoch: 2 }])
    expect(db.row("workgraph_leases", "lease-row")).toMatchObject({ epoch: 2, expires_at: 600_010 })
    expect(db.row("workgraph_outbox", "outbox-row")).toMatchObject({
      status: "claimed",
      claimed_by: "worker-restarted",
      payload: { attemptId: "attempt-a", leaseEpoch: 2 },
    })
    await expect(
      handler(markAttention)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        attempt_id: "attempt-a",
        lease_epoch: 1,
        worker_id: "worker-restarted",
        reason: "stale callback",
        now: 11,
      }),
    ).resolves.toEqual({ settled: false })
    expect(db.row("workgraph_attempts", "attempt-row")).toMatchObject({ state: "admitted", row_version: 2 })
    expect(db.row("workgraph_leases", "lease-row")).toMatchObject({ epoch: 2 })
  })
})

function handler(fn: unknown) {
  const run = (fn as { _handler: (context: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
  return (context: unknown, args: Record<string, unknown>) =>
    run(context, {
      organization_id: "org-a",
      owner_user_id: "user-a",
      ...args,
    })
}

async function reconcileAttemptHistory(history: unknown) {
  const mutations: Record<string, unknown>[] = []
  const runtime = createHostedWorkGraphRuntime(
    { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test", CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
    {
      sandbox: {
        sandboxManager: {
          target: async () => ({
            status: "ready",
            sandboxId: "sandbox",
            url: "https://runtime.test",
            hostId: "host-a",
            epoch: 1,
            homeRegion: "us-east",
          }),
        },
      },
      relay: {
        provider: {
          mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
          getRelayEndpoint: async () => "https://relay.test",
        },
      },
    } as unknown as ControlPlaneServices,
    {
      background: false,
      executor: {
        mutation: async (_fn, args) => {
          if (args.limit === 500 && Object.keys(args).length === 2)
            return [{ organizationId: "org-a", ownerUserId: "user-a" }]
          mutations.push(args)
          if (mutations.length === 1) return []
          if (mutations.length === 2)
            return [
              {
                ownerUserId: "user-a",
                orgId: "org-a",
                attemptId: "attempt-a",
                leaseEpoch: 2,
                sessionId: "session-a",
                workspaceId: "workspace-a",
              },
            ]
          return { settled: true }
        },
      },
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith("/history")) return Response.json(history)
        if (url.pathname.includes("/connection-binding/") || url.pathname.includes("/attempt-binding/")) {
          return new Response(null, { status: 204 })
        }
        throw new Error(`Unexpected hosted runtime request ${url.pathname}`)
      },
    },
  )
  return { mutations, result: await runtime!.reconcile() }
}

async function runControlEffect(input: {
  effectType: "interrupt_attempt" | "finalize_stream" | "cleanup_stream"
  payload: Record<string, unknown>
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  destroy?: () => Promise<unknown>
  release?: (workspaceId: string) => Promise<void>
  targetStatus?: "ready" | "provisioning"
}) {
  const mutations: Record<string, unknown>[] = []
  const runtime = createHostedWorkGraphRuntime(
    { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test", CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
    {
      sandbox: {
        sandboxManager: {
          target: async () =>
            input.targetStatus === "provisioning"
              ? { status: "provisioning", retryAfterMs: 1000 }
              : {
                  status: "ready",
                  sandboxId: "sandbox",
                  url: "https://runtime.test",
                  hostId: "host-a",
                  epoch: 1,
                  homeRegion: "us-east",
                },
          destroy: input.destroy ?? (async () => ({ ok: true, status: "destroyed" })),
          release: input.release ?? (async () => undefined),
        },
      },
      relay: {
        provider: {
          mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
          getRelayEndpoint: async () => "https://relay.test",
        },
      },
    } as unknown as ControlPlaneServices,
    {
      executor: {
        mutation: async (_fn, args) => {
          if (args.limit === 500 && Object.keys(args).length === 2)
            return [{ organizationId: "org-a", ownerUserId: "user-a" }]
          mutations.push(args)
          if (mutations.length <= 2) return []
          if (mutations.length === 3)
            return [
              {
                ownerUserId: "user-a",
                orgId: "org-a",
                outboxId: "control-a",
                streamId: "stream-a",
                effectType: input.effectType,
                payload: input.payload,
              },
            ]
          if (mutations.length === 4) return { settled: true }
          if (mutations.length === 5) return { completed: 0 }
          return []
        },
      },
      fetch: input.fetch ?? (async () => Response.json({})),
    },
  )
  await runtime?.reconcile()
  return mutations
}

class RuntimeDb {
  private readonly rows: Record<string, Array<Record<string, any>>>

  constructor(rows: Record<string, Array<Record<string, any>>>) {
    this.rows = Object.fromEntries(
      Object.entries(rows).map(([table, values]) => [
        table,
        values.map((row) => ({
          ...(table.startsWith("workgraph_") || table === "workgraphs" ? { organization_id: "org-a" } : {}),
          ...row,
        })),
      ]),
    )
  }

  row(table: string, id: string) {
    return this.rows[table]?.find((row) => row._id === id)
  }

  rowsFor(table: string) {
    return this.rows[table] ?? []
  }

  async get(id: string) {
    return (
      Object.values(this.rows)
        .flat()
        .find((row) => row._id === id) ?? null
    )
  }

  query(table: string) {
    let selected = [...(this.rows[table] ?? [])]
    const chain = {
      withIndex: (_name: string, build: (query: any) => unknown) => {
        const conditions: Array<[string, unknown]> = []
        const query = {
          eq: (field: string, value: unknown) => {
            conditions.push([field, value])
            return query
          },
        }
        build(query)
        selected = selected.filter((row) => conditions.every(([field, value]) => row[field] === value))
        return chain
      },
      filter: (build: (query: any) => (row: Record<string, unknown>) => boolean) => {
        const query = {
          field: (field: string) => field,
          eq: (field: string, value: unknown) => (row: Record<string, unknown>) => row[field] === value,
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
      take: async (limit: number) => selected.slice(0, limit),
      collect: async () => selected,
      unique: async () => selected[0] ?? null,
    }
    return chain
  }

  async patch(id: string, patch: Record<string, unknown>) {
    const row = Object.values(this.rows)
      .flat()
      .find((candidate) => candidate._id === id)
    if (!row) throw new Error(`Missing ${id}`)
    Object.assign(row, patch)
  }

  async insert(table: string, value: Record<string, unknown>) {
    const row = { _id: `${table}-${(this.rows[table] ?? []).length + 1}`, ...value }
    ;(this.rows[table] ??= []).push(row)
    return row._id
  }

  async delete(id: string) {
    for (const rows of Object.values(this.rows)) {
      const index = rows.findIndex((row) => row._id === id)
      if (index >= 0) rows.splice(index, 1)
    }
  }
}
