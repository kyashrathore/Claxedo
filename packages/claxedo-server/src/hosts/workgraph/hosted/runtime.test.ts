import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  claimControlEffects,
  claimLaunches,
  completeControlEffect,
  listStaleTenants,
  listRunning,
  markParked,
  parkRunning,
  recordFailure,
  recordResult,
  requestCompletionRetry,
  retryLaunch,
  renewWorkGraphRunLease,
  settleRejectedProvision,
} from "../../../../../../convex/workgraphRuntime"
import { ensureWorkGraph } from "../../../../../../convex/workspaces"
import { syncWorkGraphSession } from "../../../../../../convex/sessions"
import {
  createHostedSessionTranscriptRetention,
  createHostedWorkGraphRuntime,
  HostedTranscriptRetentionError,
  hostedSettlementFailureDisposition,
  SWEEP_SUBREQUEST_BUDGET,
  workGraphWorkspaceId,
} from "./runtime"
import type { ControlPlaneServices } from "../../../authority/services"
import { StreamReplacementResetSchema, WorkGraphRunToolNames } from "@claxedo/workgraph/contracts"

const querySingleTenant = async (_fn: unknown, args: Record<string, unknown>) =>
  "before" in args ? [] : [{ organizationId: "org-a", ownerUserId: "user-a" }]

const previousToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "service-secret"
})
afterEach(() => {
  if (previousToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousToken
})

describe("hosted WorkGraph runtime outbox", () => {
  test("replays a stable hosted master admission behind a history fence and audits only after terminal", async () => {
    const mutations: Record<string, unknown>[] = []
    let claimed = false
    let prompted = false
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
              status: "ready", sandboxId: "sandbox", url: "https://runtime.test", hostId: "host-a", epoch: 1, homeRegion: "us-east",
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
        now: () => 10_000,
        executor: {
          query: querySingleTenant,
          mutation: async (_fn, args) => {
            mutations.push(args)
            if ("trigger" in args && !("turn_id" in args)) {
              const state = claimed ? "monitor" : "launch"
              claimed = true
              return {
                state,
                ownerSubject: "owner-subject",
                stream: {
                  id: "stream-a", title: "Release train", rowVersion: 1,
                  charter: { text: "Open draft pull requests.", hash: "a".repeat(64) },
                  executionDefaults: {
                    environment: { kind: "hosted_workspace", placement: "shared", repositoryUrl: "https://github.test/acme/repo.git" },
                    repository: { baseRevision: "dev" },
                    harness: "opencode", agent: "build", model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "high", tools: ["bash"], connectionIds: [],
                  },
                },
                sessionId: "ses_master_stream-a",
                turnId: "master_turn_1",
                historyAfter: state === "monitor" ? 4 : undefined,
                admissionConfirmed: state === "monitor",
                trigger: "task_settled",
                mailbox: [], runs: [], evidenceIds: ["evidence-1"], artifactRefs: ["diff://task-1"],
              }
            }
            if ("history_after" in args) return { accepted: true }
            if ("charter_hash" in args) return { settled: true, state: "hibernating" }
            if ("turn_id" in args && !("reason" in args)) return { accepted: true }
            throw new Error(`Unexpected master mutation: ${JSON.stringify(args)}`)
          },
        },
        fetch: async (input, init) => {
          const url = new URL(String(input))
          if (url.pathname.endsWith("/api/session")) {
            expect(JSON.parse(String(init?.body))).toMatchObject({
              tools: ["bash", "workgraph_update_stream_notes", "workgraph_notify_owner"],
            })
            return Response.json({ id: "ses_master_stream-a" })
          }
          if (url.pathname.endsWith("/api/workgraph/run-binding")) {
            expect(JSON.parse(String(init?.body))).toMatchObject({
              identity: { runId: "master_stream-a", streamId: "stream-a", sessionId: "ses_master_stream-a" },
              tools: ["workgraph_update_stream_notes", "workgraph_notify_owner"],
            })
            return Response.json({ bound: true })
          }
          if (url.pathname.includes("/api/workgraph/run-binding/")) return Response.json({ unbound: true })
          if (url.pathname.endsWith("/prompt")) {
            expect(JSON.parse(String(init?.body))).toMatchObject({ id: "msg_master_turn_1", delivery: "steer", resume: true })
            prompted = true
            return Response.json({ admitted: true })
          }
          if (url.pathname.endsWith("/history")) {
            if (!prompted) return Response.json({ data: [{ type: "session.next.step.ended", durable: { seq: 4 }, data: {} }], hasMore: false })
            return Response.json({
              data: [
                { type: "session.next.text.ended", durable: { seq: 5 }, data: { text: "Rebased and validated the landing." } },
                { type: "session.next.step.ended", durable: { seq: 6 }, data: {} },
              ],
              hasMore: false,
            })
          }
          throw new Error(`Unexpected master runtime request ${url.pathname}`)
        },
      },
    )
    const intent = { organizationId: "org-a", ownerUserId: "user-a", streamId: "stream-a", trigger: "task_settled" as const }

    await expect(runtime!.master(intent)).resolves.toMatchObject({ settled: false, state: "running" })
    await expect(runtime!.master(intent)).resolves.toMatchObject({ settled: true })
    expect(mutations).toContainEqual(expect.objectContaining({ turn_id: "master_turn_1", history_after: 4 }))
    expect(mutations).toContainEqual(expect.objectContaining({
      charter_hash: "a".repeat(64),
      cited_charter_clause: "Open draft pull requests.",
      reasoning_summary: "Rebased and validated the landing.",
      resulting_diffs: ["diff://task-1"],
      evidence_ids: ["evidence-1"],
    }))
  })

  test("reads stale settlement tenants through the service-authenticated query", async () => {
    const queries: Record<string, unknown>[] = []
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      {} as ControlPlaneServices,
      {
        executor: {
          mutation: async () => [],
          query: async (_fn, args) => {
            queries.push(args)
            return [{ organizationId: "org-a", ownerUserId: "user-a" }]
          },
        },
      },
    )

    await expect(runtime?.listStaleTenants({ now: 100_000, thresholdMs: 45_000, limit: 25 })).resolves.toEqual([
      { organizationId: "org-a", ownerUserId: "user-a" },
    ])
    expect(queries).toEqual([{
      service_token: "service-secret",
      now: 100_000,
      threshold_ms: 45_000,
      limit: 25,
    }])
  })

  test("lists each tenant with stale unsettled outbox work once", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "stale-pending-a",
          organization_id: "org-a",
          owner_user_id: "user-a",
          status: "pending",
          available_at: 39_000,
        },
        {
          _id: "duplicate-stale-a",
          organization_id: "org-expired",
          owner_user_id: "user-expired",
          status: "claimed",
          available_at: 20_000,
          claim_expires_at: 90_000,
        },
        {
          _id: "stale-claimed-b",
          organization_id: "org-b",
          owner_user_id: "user-b",
          status: "claimed",
          available_at: 10_000,
          claim_expires_at: 100_001,
        },
        {
          _id: "fresh-pending",
          organization_id: "org-fresh",
          owner_user_id: "user-fresh",
          status: "pending",
          available_at: 40_001,
        },
        {
          _id: "terminal",
          organization_id: "org-terminal",
          owner_user_id: "user-terminal",
          status: "completed",
          available_at: 1,
        },
      ],
    })

    await expect(
      handler(listStaleTenants)({ db } as never, {
        service_token: "service-secret",
        now: 100_000,
      }),
    ).resolves.toEqual([
      { organizationId: "org-a", ownerUserId: "user-a" },
      { organizationId: "org-expired", ownerUserId: "user-expired" },
    ])
  })

  test("pages expired claims without letting active claims consume the budget", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "active-claim",
          organization_id: "org-active",
          owner_user_id: "user-active",
          status: "claimed",
          available_at: 1,
          claim_expires_at: 100_001,
        },
        {
          _id: "expired-claim",
          organization_id: "org-expired",
          owner_user_id: "user-expired",
          status: "claimed",
          available_at: 2,
          claim_expires_at: 99_999,
        },
      ],
    })

    await expect(
      handler(listStaleTenants)({ db } as never, {
        service_token: "service-secret",
        now: 100_000,
        limit: 1,
      }),
    ).resolves.toEqual([{ organizationId: "org-expired", ownerUserId: "user-expired" }])
  })

  test("does not let one tenant's row backlog consume the distinct-tenant result window", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        ...Array.from({ length: 501 }, (_, index) => ({
          _id: `noisy-${index}`,
          organization_id: "org-noisy",
          owner_user_id: "user-noisy",
          status: "pending",
          available_at: index,
        })),
        {
          _id: "quiet-tenant",
          organization_id: "org-quiet",
          owner_user_id: "user-quiet",
          status: "pending",
          available_at: 1,
        },
      ],
    })

    await expect(
      handler(listStaleTenants)({ db } as never, {
        service_token: "service-secret",
        now: 100_000,
        limit: 500,
      }),
    ).resolves.toEqual([
      { organizationId: "org-noisy", ownerUserId: "user-noisy" },
      { organizationId: "org-quiet", ownerUserId: "user-quiet" },
    ])
  })

  test("returns the production retry hint when provisioning requeues a launch", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [{
        _id: "outbox-row",
        owner_user_id: "user-a",
        id: "outbox-a",
        status: "claimed",
        claimed_by: "worker-a",
        payload: { runId: "run-a", leaseEpoch: 2 },
      }],
      workgraph_runs: [{
        _id: "run-row",
        owner_user_id: "user-a",
        id: "run-a",
        work_item_id: "item-a",
        generation: 2,
        state: "placing",
      }],
      workgraph_leases: [{
        _id: "lease-row",
        owner_user_id: "user-a",
        resource_type: "work_item",
        resource_id: "item-a",
        holder_id: "run-a",
        epoch: 2,
      }],
    })

    await expect(
      handler(retryLaunch)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        run_id: "run-a",
        lease_epoch: 2,
        worker_id: "worker-a",
        available_at: 11_500,
        reason: "Hosted workspace is provisioning",
        now: 10_000,
      }),
    ).resolves.toEqual({ settled: true, retryAfterMs: 1_500 })
  })

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
      projects: [{
        _id: "project-row",
        project_id: "project-existing",
        org_id: "org-a",
        repo_key: "https://github.com/claxedo/workgraph-target",
        owner_user_id: "user-a",
      }],
      project_memberships: [{ _id: "project-member", project_id: "project-existing", user_id: "user-a", role: "owner" }],
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

  test("meters hosted Run transcript turns into the usage ledger exactly once", async () => {
    // Hosted Runs execute in sandbox runtimes the central session runtime never
    // observes; the transcript sync is where their assistant turns must land as
    // usage facts. Two syncs of the same transcript may not double-count.
    const db = new RuntimeDb({
      users: [{ _id: "user-a", token_identifier: "user-a", clerk_subject: "clerk-user-a" }],
      orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "clerk", clerk_org_id: "clerk_org_metering" }],
      org_memberships: [{ _id: "org-member", org_id: "org-a", user_id: "user-a", role: "owner" }],
      workspaces: [
        {
          _id: "workspace-row",
          workspace_id: "wg-stream-a",
          org_id: "org-a",
          owner_user_id: "user-a",
          backing: "cloud-vm",
          access: "cloud",
          display_name: "WorkGraph · Review",
        },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          generation: 1,
          state: "running",
          row_version: 1,
        },
      ],
      session_history: [],
      session_messages: [],
      llm_usage_events: [],
    })
    const sync = () =>
      handler(syncWorkGraphSession)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        workspace_id: "wg-stream-a",
        session_id: "ses_wgrun_run-a",
        updated_at: 20,
        messages: [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "Do it" }] },
          {
            info: {
              id: "msg-assistant",
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-5",
              tokens: { input: 600, output: 400, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 30, completed: 45 },
            },
            parts: [{ type: "text", text: "Done" }],
          },
        ],
      })
    await sync()
    await sync()
    expect(db.rowsFor("llm_usage_events")).toEqual([
      expect.objectContaining({
        org_id: "clerk_org_metering",
        user_id: "clerk-user-a",
        session_id: "ses_wgrun_run-a",
        message_id: "msg-assistant",
        stream_id: "stream-a",
        run_id: "run-a",
        work_item_id: "item-a",
        harness: "workgraph",
        provider_id: "openai",
        model_id: "gpt-5",
        input_tokens: 600,
        output_tokens: 400,
        turn_status: "ok",
        latency_ms: 15,
        created_at: 45,
      }),
    ])
  })

  test("lets the synchronous admin pass reconcile Runs without draining background queues", async () => {
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
            return []
          },
          query: async (_fn, args) => "before" in args
            ? [{ organizationId: "org-a", ownerUserId: "user-a", dirtyAt: 1, dirtyToken: "dirty-a" }]
            : [],
        },
      },
    )

    await expect(runtime?.reconcile({ background: false })).resolves.toEqual({ launched: [], results: [] })
    expect(mutations).toHaveLength(3)
    expect(mutations.some((args) => args.limit === 25)).toBe(false)
  })

  test("leaves tenants dirty at the sweep budget and finishes them on the next tick", async () => {
    const dirty = Array.from({ length: 267 }, (_, index) => ({
      organizationId: `org-${index}`,
      ownerUserId: `user-${index}`,
      dirtyAt: index + 1,
      dirtyToken: `dirty-${index}`,
    }))
    const drained = new Set<string>()
    const mutations: Record<string, unknown>[] = []
    let queries = 0
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
      },
      {} as ControlPlaneServices,
      {
        background: false,
        executor: {
          mutation: async (_fn, args) => {
            mutations.push(args)
            if (typeof args.dirty_token === "string") {
              drained.add(`${args.organization_id}:${args.owner_user_id}`)
            }
            return []
          },
          query: async (_fn, args) => {
            queries += 1
            return "before" in args
              ? dirty.filter((tenant) => !drained.has(`${tenant.organizationId}:${tenant.ownerUserId}`))
              : []
          },
        },
      },
    )

    try {
      await runtime?.reconcile()
      expect(drained.size).toBe(266)
      expect(mutations).toHaveLength(798)
      expect(queries + mutations.length).toBe(SWEEP_SUBREQUEST_BUDGET)
      expect(warning).toHaveBeenCalledWith(
        "[claxedo-server] WorkGraph sweep budget left 1 tenants dirty",
      )

      await runtime?.reconcile()
      expect(drained.size).toBe(267)
      expect(mutations).toHaveLength(801)
      expect(queries).toBe(4)
    } finally {
      warning.mockRestore()
    }
  })

  test("hard-stops busy tenant fan-out at 800 external subrequests without clearing dirty markers", async () => {
    const dirty = Array.from({ length: 266 }, (_, index) => ({
      organizationId: `org-busy-${index}`,
      ownerUserId: `user-busy-${index}`,
      dirtyAt: index + 1,
      dirtyToken: `dirty-busy-${index}`,
    }))
    let queries = 0
    let mutations = 0
    let sandboxCalls = 0
    let drained = 0
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
        CLAXEDO_PUBLIC_URL: "https://central.test",
      },
      {
        sandbox: {
          sandboxManager: {
            ensure: async () => {
              sandboxCalls += 1
              return { status: "provisioning", retryAfterMs: 1_000 }
            },
          },
        },
        relay: {},
      } as unknown as ControlPlaneServices,
      {
        background: false,
        executor: {
          query: async (_fn, args) => {
            queries += 1
            return "before" in args ? dirty : []
          },
          mutation: async (_fn, args) => {
            mutations += 1
            if (typeof args.dirty_token === "string") {
              drained += 1
              return true
            }
            if (args.limit === 10 && "worker_id" in args) {
              return [{
                ownerUserId: args.owner_user_id,
                ownerSubject: args.owner_user_id,
                orgId: args.organization_id,
                outboxId: `outbox-${args.owner_user_id}`,
                runId: `run-${args.owner_user_id}`,
                streamId: `stream-${args.owner_user_id}`,
                workItemId: `item-${args.owner_user_id}`,
                leaseEpoch: 1,
                title: "Busy sweep",
                prompt: "Busy sweep",
                profile: {
                  environment: { kind: "hosted_workspace", placement: "shared" },
                  harness: "claxedo-v2",
                  agent: "build",
                  model: { providerId: "openai", modelId: "gpt-5" },
                  effort: "high",
                  tools: [],
                  connectionIds: [],
                },
              }]
            }
            return []
          },
        },
      },
    )

    try {
      await expect(runtime?.reconcile()).resolves.toEqual({ launched: [], results: [] })
      expect(queries + mutations + sandboxCalls).toBe(SWEEP_SUBREQUEST_BUDGET)
      expect(drained).toBe(0)
      expect(warning).toHaveBeenCalledWith(
        "[claxedo-server] WorkGraph sweep budget left 266 tenants dirty",
      )
    } finally {
      warning.mockRestore()
    }
  })

  test("settles launches and control effects only for an explicit tenant without listing tenants", async () => {
    const mutations: Record<string, unknown>[] = []
    const released: string[] = []
    let listWorkerTenantsCalls = 0
    let claimLaunchCalls = 0
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
            target: async () => ({
              status: "ready",
              sandboxId: "sandbox",
              url: "https://runtime.test",
              hostId: "host-a",
              epoch: 1,
              homeRegion: "us-east",
            }),
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
        executor: {
          query: querySingleTenant,
          mutation: async (_fn, args) => {
            if (!("organization_id" in args)) {
              listWorkerTenantsCalls++
              return [{ organizationId: "org-other", ownerUserId: "user-other" }]
            }
            mutations.push(args)
            if (args.organization_id !== "org-a" || args.owner_user_id !== "user-a") return []
            if (args.limit === 10 && "worker_id" in args) {
              claimLaunchCalls++
              if (claimLaunchCalls > 1) return []
              return [
                {
                  ownerUserId: "user-a",
                  ownerSubject: "user-a",
                  orgId: "org-a",
                  outboxId: "launch-a",
                  runId: "run-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 1,
                  title: "Explicit tenant work",
                  prompt: "Run explicit tenant work",
                  profile: {
                    environment: { kind: "hosted_workspace", placement: "shared" },
                    harness: "claxedo-v2",
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "high",
                    tools: [],
                    connectionIds: [],
                  },
                },
              ]
            }
            if (args.outbox_id === "launch-a" && "workspace_id" in args) return { settled: true }
            if (args.outbox_id === "launch-a") return { accepted: true }
            if (args.limit === 10) return []
            if (args.limit === 25 && "worker_id" in args)
              return [
                {
                  ownerUserId: "user-a",
                  orgId: "org-a",
                  outboxId: "control-a",
                  streamId: "stream-a",
                  effectType: "finalize_stream",
                  payload: { finalize: "delete", sessions: [] },
                },
              ]
            if (args.outbox_id === "control-a") return { settled: true }
            if (args.limit === 25) return { completed: 0 }
            return []
          },
        },
        fetch: async (input) => {
          if (new URL(String(input)).pathname.endsWith("/api/session")) return Response.json({ id: "session-a" })
          return Response.json({})
        },
      },
    )

    await expect(
      runtime?.reconcile({ tenants: [{ organizationId: "org-a", ownerUserId: "user-a" }] }),
    ).resolves.toMatchObject({
      launched: [{ settled: true, state: "running" }],
      background: { controls: [{ settled: true }] },
    })
    expect(listWorkerTenantsCalls).toBe(0)
    expect(released).toHaveLength(1)
    expect(mutations).not.toContainEqual(expect.objectContaining({ organization_id: "org-other" }))
    expect(mutations).toContainEqual(
      expect.objectContaining({ outbox_id: "launch-a", workspace_id: expect.any(String) }),
    )
    expect(mutations).toContainEqual(expect.objectContaining({ outbox_id: "control-a", ok: true }))
  })

  test("settles a control effect without waiting for a slow launch on the same tenant lane", async () => {
    // Staging regression: a bare-Stream deletion blew its <20s settlement SLA
    // because the control-effect drain used to run AFTER launch provisioning in
    // the same per-tenant reconcile pass. Here a launch's provisioning blocks
    // indefinitely; the delete's completeControlEffect must still fire (proving
    // the drain now runs concurrently, not head-of-line blocked behind launches).
    let releaseLaunch: () => void = () => {}
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve
    })
    let launchReleased = false
    let controlAckedWhileLaunchPending: boolean | undefined
    let launchClaims = 0
    const released: string[] = []
    const readyPlacement = {
      status: "ready" as const,
      sandboxId: "sandbox",
      url: "https://runtime.test",
      hostId: "host-a",
      epoch: 1,
      homeRegion: "us-east",
    }

    const runtime = createHostedWorkGraphRuntime(
      {
        CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
        CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret",
        CLAXEDO_PUBLIC_URL: "https://central.test",
      },
      {
        sandbox: {
          sandboxManager: {
            // Launch provisioning blocks until the gate is released.
            ensure: async () => {
              await launchGate
              return readyPlacement
            },
            target: async () => readyPlacement,
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
        executor: {
          query: querySingleTenant,
          mutation: async (_fn, args) => {
            // claimLaunches (first) → one gated launch; claimSourcePlans and any
            // re-claim → nothing. Both are limit-10 worker-fenced claims.
            if (args.limit === 10 && "worker_id" in args) {
              if (launchClaims++ > 0) return []
              return [
                {
                  ownerUserId: "user-a",
                  ownerSubject: "user-a",
                  orgId: "org-a",
                  outboxId: "launch-b",
                  runId: "run-b",
                  streamId: "stream-b",
                  workItemId: "item-b",
                  leaseEpoch: 1,
                  title: "Slow launch",
                  prompt: "Run slow launch",
                  profile: {
                    environment: { kind: "hosted_workspace", placement: "shared" },
                    harness: "claxedo-v2",
                    agent: "build",
                    model: { providerId: "openai", modelId: "gpt-5" },
                    effort: "high",
                    tools: [],
                    connectionIds: [],
                  },
                },
              ]
            }
            // claimControlEffects → one Stream delete on the same tenant.
            if (args.limit === 25 && "worker_id" in args)
              return [
                {
                  ownerUserId: "user-a",
                  orgId: "org-a",
                  outboxId: "control-a",
                  streamId: "stream-a",
                  effectType: "finalize_stream",
                  payload: { finalize: "delete", sessions: [] },
                },
              ]
            // completeControlEffect: capture whether the launch is still gated.
            if ("outbox_id" in args && "ok" in args) {
              if (args.outbox_id === "control-a") controlAckedWhileLaunchPending = !launchReleased
              return { settled: true }
            }
            if ("outbox_id" in args) return { accepted: true, settled: true }
            if (args.limit === 25) return { completed: 0 }
            return []
          },
        },
        fetch: async (input) => {
          if (new URL(String(input)).pathname.endsWith("/api/session")) return Response.json({ id: "session-b" })
          return Response.json({})
        },
      },
    )

    const reconcilePromise = runtime?.reconcile({ tenants: [{ organizationId: "org-a", ownerUserId: "user-a" }] })
    try {
      // While the launch is gated, the concurrent background drain must reach the
      // control ack. Poll briefly rather than await the (still-blocked) reconcile.
      const deadline = Date.now() + 1000
      while (controlAckedWhileLaunchPending === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(controlAckedWhileLaunchPending).toBe(true)
      expect(released).toHaveLength(1)
    } finally {
      // Always release so a regressed (sequential) runtime fails on the assertion
      // above instead of hanging on the never-settling reconcile promise.
      launchReleased = true
      releaseLaunch()
      await reconcilePromise
    }
  })


  test("recovers an expired durable Run after restart and fences stale completion", async () => {
    const db = new RuntimeDb({
      workgraph_runs: [
        {
          _id: "run-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          generation: 1,
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
          holder_id: "run-a",
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
      renewWorkGraphRunLease({ db } as never, {
        organizationId: "org-a" as never,
        ownerUserId: "user-b" as never,
        runId: "run-a",
        expectedLeaseEpoch: 1,
        now: 20,
        durationMs: 300_000,
      }),
    ).resolves.toBeUndefined()

    const restarted = (await handler(listRunning)({ db } as never, {
      service_token: "service-secret",
      limit: 10,
      now: 20,
    })) as Array<{ runId: string; leaseEpoch: number }>
    expect(restarted).toMatchObject([
      {
        runId: "run-a",
        leaseEpoch: 2,
        activeLeaseAgeMs: 0,
        expiredRecovery: true,
      },
    ])
    expect(db.row("workgraph_leases", "lease-row")).toMatchObject({ epoch: 2, expires_at: 300_020 })
    await expect(
      handler(requestCompletionRetry)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        run_id: "run-a",
        session_id: "session-a",
        lease_epoch: 2,
        terminal_seq: 7,
        now: 21,
      }),
    ).resolves.toMatchObject({ accepted: true, terminalSeq: 7, requestedAt: 21 })
    await expect(
      handler(requestCompletionRetry)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        run_id: "run-a",
        session_id: "session-a",
        lease_epoch: 2,
        terminal_seq: 99,
        now: 22,
      }),
    ).resolves.toMatchObject({ accepted: true, terminalSeq: 7, requestedAt: 21 })
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
      completion_retry: { terminal_seq: 7, requested_at: 21 },
    })
    await expect(
      renewWorkGraphRunLease({ db } as never, {
        organizationId: "org-a" as never,
        ownerUserId: "user-a" as never,
        runId: "run-a",
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
        run_id: "run-a",
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
      run_id: "run-a",
      lease_epoch: 2,
      session_id: "session-a",
      summary: "current",
      artifacts: ["commit:abc"],
      now: 21,
    }
    await expect(handler(recordResult)({ db } as never, { ...result, summary: " " })).rejects.toThrow(
      "Run result summary must be non-empty",
    )
    await expect(handler(recordResult)({ db } as never, { ...result, artifacts: [" "] })).rejects.toThrow(
      "Run result artifacts must contain non-empty references",
    )
    await expect(handler(recordResult)({ db } as never, result)).resolves.toEqual({ settled: true })
    await expect(handler(recordResult)({ db } as never, result)).resolves.toEqual({ settled: true })
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
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
      workgraph_runs: [
        {
          _id: "run-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          generation: 1,
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
          holder_id: "run-a",
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
        run_id: "run-a",
        lease_epoch: 1,
        session_id: "session-a",
        reason: "Session execution failed",
        now: 20,
      }),
    ).resolves.toEqual({ settled: true })

    expect(db.row("workgraph_runs", "run-row")).toMatchObject({ state: "failed", finished_at: 20 })
    expect(db.row("workgraph_work_items", "item-row")).toMatchObject({ state: "failed" })
    expect(db.row("workgraph_attention_entries", "workgraph_attention_entries-1")).toMatchObject({
      kind: "work_item",
      id: "item-a",
    })
  })

  test("records interrupt HTTP failure instead of acknowledging cancellation", async () => {
    const mutations = await runControlEffect({
      effectType: "interrupt_run",
      payload: { finalize: "cancel", sessionId: "session-a" },
      fetch: async () => new Response("failed", { status: 500 }),
    })
    expect(mutations.find((m) => "ok" in m)).toMatchObject({ ok: false, reason: expect.stringContaining("500") })
  })

  test("does not acknowledge interruption when Session placement is non-ready", async () => {
    const mutations = await runControlEffect({
      effectType: "interrupt_run",
      payload: { finalize: "cancel", sessionId: "session-a" },
      targetStatus: "provisioning",
    })
    expect(mutations.find((m) => "ok" in m)).toMatchObject({ ok: false, reason: expect.stringContaining("not ready") })
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
    expect(mutations.find((m) => "ok" in m)).toMatchObject({ ok: true })
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
    expect(mutations.find((m) => "ok" in m)).toMatchObject({ ok: true })
    expect(released).toHaveLength(1)
  })

  test("does not acknowledge replacement reset when workspace destruction is rejected", async () => {
    const mutations = await runControlEffect({
      effectType: "cleanup_stream",
      payload: { finalize: "replace", sessions: [] },
      destroy: async () => ({ ok: false as const, reason: "runtime_lease_not_ready" }),
    })
    expect(mutations.find((m) => "ok" in m)).toMatchObject({
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
    expect(mutations.find((m) => "ok" in m)).toMatchObject({ ok: true })
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
          query: querySingleTenant,
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
                  runId: "run-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 1,
                  title: "Late work",
                  prompt: "Late work",
                  profile: {
                    environment: { kind: "hosted_workspace", placement: "shared" },
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
    expect(mutations[2]).toMatchObject({ outbox_id: "launch-a", run_id: "run-a" })
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
          payload: { runId: "run-a" },
        },
      ],
    })
    await expect(
      handler(settleRejectedProvision)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "launch-a",
        run_id: "run-a",
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
    ).resolves.toEqual({ settled: true, retryAfterMs: 60_000 })
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
          payload: { finalize: "cancel", runId: "run-a" },
        },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          generation: 1,
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
          holder_id: "run-a",
        },
      ],
    })
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
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
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({ state: "cancelled", finished_at: 20 })
    expect(db.row("workgraph_leases", "lease-row")).toBeUndefined()
  })

  test("does not finalize a no-session cancellation while its launch claim is still in flight", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "launch-row",
          owner_user_id: "user-a",
          id: "launch-a",
          idempotency_key: "run-a:launch",
          status: "claimed",
          claimed_by: "worker-launch",
        },
        {
          _id: "control-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "control-a",
          idempotency_key: "run-a:interrupt",
          status: "claimed",
          claimed_by: "worker-control",
          payload: { finalize: "cancel", runId: "run-a" },
        },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          generation: 1,
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
          holder_id: "run-a",
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
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
      state: "admitted",
      cancellation: { state: "pending" },
    })

    await db.patch("launch-row", { status: "cancelled" })
    await db.patch("control-row", {
      payload: { finalize: "cancel", runId: "run-a", sessionId: "session-race" },
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
    expect(db.row("workgraph_runs", "run-row")?.state).toBe("cancelled")
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
      workgraph_runs: [
        {
          _id: "run-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          generation: 1,
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
    ).resolves.toEqual({ settled: true, retryAfterMs: 0 })
    expect(db.row("workgraph_streams", "stream-row")).toBeDefined()
    expect(db.row("workgraph_runs", "run-row")).toBeUndefined()
    expect(db.row("workgraph_outbox", "control-row")).toMatchObject({ status: "pending" })
    await db.patch("control-row", { status: "claimed", claimed_by: "worker-a" })
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
    expect(db.row("workgraph_streams", "stream-row")).toBeUndefined()
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
      workgraph_runs: [
        {
          _id: "run-row",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          generation: 1,
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
          holder_id: "run-a",
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
    expect(db.row("workgraph_runs", "run-row")?.state).toBe("cancelled")
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
          query: querySingleTenant,
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            if (mutations.length <= 3) return []
            if (mutations.length === 4) return { completed: 0 }
            if (mutations.length === 5)
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
            if (mutations.length === 6 || mutations.length === 7) return { settled: true }
            if (mutations.length === 8)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  jobId: "source-plan-job",
                  leaseEpoch: 1,
                  sessionId: "ses_workgraph_source-plan-job_1",
                  workspaceId: String(mutations[5]?.workspace_id),
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
          query: querySingleTenant,
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            mutations.push(args)
            const call = mutations.length
            if ([1, 2, 3, 7, 8, 9, 10].includes(call)) return []
            if (call === 4 || call === 11) return { completed: 0 }
            if (call === 5) return [claim(1)]
            if (call === 12) return [claim(2)]
            if ([6, 13, 14, 16].includes(call)) return { settled: true }
            if (call === 15)
              return [
                {
                  ownerUserId: "internal-user-a",
                  orgId: "org-a",
                  jobId: "source-plan-lost",
                  leaseEpoch: 2,
                  sessionId: "ses_workgraph_source-plan-lost_1",
                  workspaceId: String(mutations[12]?.workspace_id),
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
          query: querySingleTenant,
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
                  runId: "run-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 2,
                  title: "Connected",
                  prompt: "Use it",
                  profile: {
                    environment: { kind: "hosted_workspace", placement: "shared" },
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

  test("binds scoped Run and Connection tools before prompting without inferring completion", async () => {
    const mutations: Record<string, unknown>[] = []
    const mintedTokens: Record<string, unknown>[] = []
    const ensureInputs: Record<string, unknown>[] = []
    const publishedLaunches: Record<string, unknown>[] = []
    const publishedSnapshots: Record<string, unknown>[] = []
    const promptBodies: Array<{ id?: string; prompt?: { text?: string } }> = []
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
          query: querySingleTenant,
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
                  runId: "run-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 2,
                  title: "No-op",
                  parentStreamId: "stream-parent",
                  parentSource: {
                    repoUrl: "https://github.com/claxedo/parent-target.git",
                    branch: "parent-head",
                  },
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
                  runId: "run-a",
                  leaseEpoch: 2,
                  sessionId: "session-a",
                  workspaceId: String(mutations[2]?.workspace_id),
                },
              ]
            if ("terminal_seq" in args)
              return { accepted: true, terminalSeq: args.terminal_seq, requestedAt: 100 }
            return { settled: true }
          },
        },
        fetch: async (input, init) => {
          const url = new URL(String(input))
          expect(init?.headers).toBeDefined()
          if (url.pathname.endsWith("/api/session")) {
            expect(JSON.parse(String(init?.body))).toEqual({
              id: "ses_wgrun_run-a",
              agent: "build",
              model: { providerID: "openai", id: "gpt-5", variant: "high" },
              tools: ["connection_work_source_list", ...WorkGraphRunToolNames],
              location: { directory: "/workspace" },
            })
            return Response.json({ id: "session-a" }, { status: 201 })
          }
          if (url.pathname.endsWith("/api/workgraph/connection-binding")) {
            expect(new Headers(init?.headers).get("x-claxedo-workgraph-broker-token")).toBe("runtime-token")
            expect(JSON.parse(String(init?.body))).toEqual({
              version: 1,
              identity: {
                runId: "run-a",
                sessionId: "session-a",
                workspaceId: String(mutations[2]?.workspace_id),
              },
              connectionIds: ["connection-a"],
              tools: ["connection_work_source_list"],
              brokerUrl: "https://central.test",
            })
            return Response.json({ bound: true })
          }
          if (url.pathname.endsWith("/api/workgraph/run-binding")) {
            expect(new Headers(init?.headers).get("x-claxedo-workgraph-broker-token")).toBe("runtime-token")
            expect(JSON.parse(String(init?.body))).toEqual({
              version: 1,
              identity: {
                runId: "run-a",
                sessionId: "session-a",
                workspaceId: String(mutations[2]?.workspace_id),
                generation: 2,
              },
              brokerUrl: "https://central.test",
            })
            return Response.json({ bound: true })
          }
          if (url.pathname.endsWith("/prompt")) {
            const body = JSON.parse(String(init?.body))
            promptBodies.push(body)
            return Response.json({ data: { admitted: true } })
          }
          if (url.pathname.endsWith("/history"))
            return Response.json({
              data: [
                { type: "session.next.text.ended", durable: { seq: 1 }, data: { text: "done" } },
                { type: "session.next.step.ended", durable: { seq: 2 }, data: { files: ["result.txt"] } },
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
      results: [{ settled: false, state: "retrying_explicit_completion" }],
    })
    expect(mintedTokens[0]).toMatchObject({ subject: "clerk-user-a", orgId: "org-a" })
    expect(mutations).toHaveLength(6)
    expect(ensureInputs[0]).toMatchObject({
      env: {
        WORKSPACE_RUNTIME_RUNNER: "opencode",
        WORKSPACE_RUNTIME_WORKGRAPH_BROKER_ORIGIN: "https://central.test",
      },
      source: {
        kind: "git",
        repoUrl: "https://github.com/claxedo/parent-target.git",
        branch: "parent-head",
      },
      labels: { parentStreamId: "stream-parent" },
    })
    expect(mutations[2]).toMatchObject({ workspace_id: expect.stringMatching(/^wg-/), session_id: "session-a" })
    expect(mutations[3]).toMatchObject({
      runId: "run-a",
      sessionId: "session-a",
      connectionIds: ["connection-a"],
      tools: ["connection_work_source_list"],
    })
    expect(mutations.find((mutation) => "terminal_seq" in mutation)).toMatchObject({
      run_id: "run-a",
      session_id: "session-a",
      lease_epoch: 2,
      terminal_seq: 2,
    })
    expect(promptBodies).toEqual([
      expect.objectContaining({
        id: "msg_workgraph_run-a",
        prompt: {
          text: expect.stringContaining("A text response without this tool call does not complete the Run"),
        },
      }),
      expect.objectContaining({
        id: "msg_workgraph_completion_run-a",
        prompt: { text: expect.stringContaining("Call workgraph_complete_task now") },
      }),
    ])
    expect(promptBodies[0]).toMatchObject({
      prompt: { text: expect.stringContaining('"evidence":{"kind":"test_result"') },
    })
    expect(mutations).not.toContainEqual(expect.objectContaining({ summary: "done", artifacts: ["file:result.txt"] }))
    expect(publishedLaunches).toEqual([
      expect.objectContaining({
        organizationId: "org-a",
        ownerUserId: "internal-user-a",
        sessionId: "session-a",
        title: "No-op",
        repoUrl: "https://github.com/claxedo/parent-target.git",
        branch: "parent-head",
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

  test("never overwrites the retained transcript with an empty snapshot pull", async () => {
    const publishedSnapshots: Record<string, unknown>[] = []
    const runtime = createHostedWorkGraphRuntime(
      { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test", CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      transcriptServices(),
      {
        background: false,
        sessionPublisher: {
          launch: async () => {},
          snapshot: async (input) => {
            publishedSnapshots.push(input)
          },
        },
        executor: {
          query: querySingleTenant,
          mutation: async (_fn, args) => {
            if (args.limit === 500 && Object.keys(args).length === 2)
              return [{ organizationId: "org-a", ownerUserId: "user-a" }]
            if (args.limit === 10 && "worker_id" in args) return []
            if (args.limit === 10)
              return [
                {
                  ownerUserId: "user-a",
                  orgId: "org-a",
                  runId: "run-a",
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
          if (url.pathname.endsWith("/history")) return Response.json({ data: [], hasMore: false })
          if (url.pathname.endsWith("/message")) return Response.json({ messages: [], maxEventOrdinal: 0 })
          throw new Error(`Unexpected hosted runtime request ${url.pathname}`)
        },
      },
    )
    await expect(runtime?.reconcile()).resolves.toMatchObject({
      results: [{ settled: false, state: "running" }],
    })
    expect(publishedSnapshots).toEqual([])
  })

  test("retains the transcript durably before a hosted completion is accepted", async () => {
    const retained: Record<string, unknown>[] = []
    const resolvedActors: Record<string, unknown>[] = []
    const mintedTokens: Record<string, unknown>[] = []
    const snapshotRequests: string[] = []
    const retain = createHostedSessionTranscriptRetention(
      { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test", CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      transcriptServices(async (input) => {
        mintedTokens.push(input)
        return { token: "runtime-token", expiresAt: 1000, jti: "jti" }
      }),
      {
        now: () => 42,
        executor: {
          query: async (_fn, args) => {
            resolvedActors.push(args)
            return { actor_id: "internal-user-a", actor_kind: "human" }
          },
          mutation: async (_fn, args) => {
            retained.push(args)
            return { ok: true }
          },
        },
        fetch: async (input, init) => {
          snapshotRequests.push(String(input))
          expect(new Headers(init?.headers).get("x-opencode-directory")).toBe("/workspace")
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-token")
          return Response.json({
            messages: [
              { info: { id: "msg_user", role: "user" }, parts: [] },
              { info: { id: "msg_assistant", role: "assistant" }, parts: [] },
            ],
            maxEventOrdinal: 7,
          })
        },
      },
    )
    await retain!({
      organizationId: "org-a",
      ownerSubject: "clerk-user-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
    })
    expect(snapshotRequests).toEqual([
      "https://relay.test/workspaces/workspace-a/session/session-a/message?snapshot=1",
    ])
    expect(resolvedActors).toEqual([{ service_token: "service-secret", subject: "clerk-user-a" }])
    expect(mintedTokens).toEqual([expect.objectContaining({
      subject: "clerk-user-a",
      actorId: "internal-user-a",
      actorKind: "human",
    })])
    expect(retained).toEqual([
      {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_subject: "clerk-user-a",
        workspace_id: "workspace-a",
        session_id: "session-a",
        updated_at: 42,
        messages: [
          expect.objectContaining({ info: expect.objectContaining({ role: "user" }) }),
          expect.objectContaining({ info: expect.objectContaining({ role: "assistant" }) }),
        ],
      },
    ])
  })

  test("rejects completion retention until the transcript holds user and assistant messages", async () => {
    const retained: Record<string, unknown>[] = []
    const retain = createHostedSessionTranscriptRetention(
      { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test", CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      transcriptServices(),
      {
        executor: {
          query: async () => ({ actor_id: "internal-user-a", actor_kind: "human" }),
          mutation: async (_fn, args) => {
            retained.push(args)
            return { ok: true }
          },
        },
        fetch: async () => Response.json({ messages: [], maxEventOrdinal: 0 }),
      },
    )
    await expect(
      retain!({
        organizationId: "org-a",
        ownerSubject: "clerk-user-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
      }),
    ).rejects.toBeInstanceOf(HostedTranscriptRetentionError)
    expect(retained).toEqual([])
  })

  test("maps a failed transcript pull into a retryable retention error", async () => {
    const retain = createHostedSessionTranscriptRetention(
      { CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test", CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "service-secret" },
      transcriptServices(),
      {
        executor: {
          query: async () => ({ actor_id: "internal-user-a", actor_kind: "human" }),
          mutation: async () => ({ ok: true }),
        },
        fetch: async () => new Response("boom", { status: 502 }),
      },
    )
    const failure = await retain!({
      organizationId: "org-a",
      ownerSubject: "clerk-user-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
    }).catch((error) => error)
    expect(failure).toBeInstanceOf(HostedTranscriptRetentionError)
    expect((failure as HostedTranscriptRetentionError).retryable).toBe(true)
    expect((failure as HostedTranscriptRetentionError).message).toContain("502")
  })

  test("requests one explicit completion retry instead of fabricating hosted success", async () => {
    for (const data of [
      [{ type: "session.next.step.ended", durable: { seq: 1 }, data: { files: [] } }],
      [
        { type: "session.next.text.ended", durable: { seq: 1 }, data: { text: "   " } },
        { type: "session.next.step.ended", durable: { seq: 2 }, data: { files: [] } },
      ],
    ]) {
      const { mutations, result } = await reconcileRunHistory({ data, hasMore: false })
      expect(result).toMatchObject({ results: [{ settled: false, state: "retrying_explicit_completion" }] })
      expect(mutations[2]).toMatchObject({
        session_id: "session-a",
        terminal_seq: data.at(-1)!.durable.seq,
      })
      expect(mutations[2]).not.toHaveProperty("summary")
    }
  })

  test("parks hosted work when an admitted prompt stops before provider settlement", async () => {
    const { mutations, result } = await reconcileRunHistory({
      data: [{ type: "session.next.prompted", durable: { seq: 1 }, data: {} }],
      hasMore: false,
    })
    expect(result).toMatchObject({ results: [{ settled: true }] })
    expect(mutations[2]).toMatchObject({
      run_id: "run-a",
      session_id: "session-a",
      lease_epoch: 2,
      reason: "Session stopped before the provider step settled",
    })
  })

  test("leaves an admitted prompt running while the harness still owns its drain", async () => {
    // `session.next.prompted` lands on admission and the first step ends whole
    // seconds later, so history alone cannot tell a stopped Session from one
    // mid-turn. Parking on history alone parked every Run reconciled inside
    // that window -- the staging smoke parked 12s after admission.
    for (const active of [
      { data: { "session-a": { type: "running" } } },
      // Unrecognizable envelopes must fail toward "still active": the other
      // direction parks live work on a malformed response.
      { data: null },
      "not-an-object",
    ]) {
      const { mutations, result } = await reconcileRunHistory(
        { data: [{ type: "session.next.prompted", durable: { seq: 1 }, data: {} }], hasMore: false },
        undefined,
        active,
      )
      expect(result).toMatchObject({ results: [{ settled: false, state: "running" }] })
      expect(mutations[2]).toBeUndefined()
    }
  })

  test("parks an admitted prompt once the harness reports another session's drain but not this one", async () => {
    const { mutations, result } = await reconcileRunHistory(
      { data: [{ type: "session.next.prompted", durable: { seq: 1 }, data: {} }], hasMore: false },
      undefined,
      { data: { "session-b": { type: "running" } } },
    )
    expect(result).toMatchObject({ results: [{ settled: true }] })
    expect(mutations[2]).toMatchObject({
      session_id: "session-a",
      reason: "Session stopped before the provider step settled",
    })
  })

  test("records a truthful failure when the completion-only retry also ends without completion", async () => {
    const { mutations, result } = await reconcileRunHistory(
      {
        data: [
          { type: "session.next.text.ended", durable: { seq: 3 }, data: { text: "Still done" } },
          { type: "session.next.step.ended", durable: { seq: 4 }, data: { files: [] } },
        ],
        hasMore: false,
      },
      { terminalSeq: 2, requestedAt: 100 },
    )
    expect(result).toMatchObject({ results: [{ settled: true }] })
    expect(mutations[2]).toMatchObject({
      session_id: "session-a",
      reason: "Hosted Session ended without workgraph_complete_task after one completion retry",
    })
  })

  test("records session_history_invalid for malformed or missing hosted history data", async () => {
    for (const history of [
      { hasMore: false },
      { data: [], hasMore: "false" },
      { data: [{ type: "session.next.step.ended", data: null }], hasMore: false },
    ]) {
      const { mutations, result } = await reconcileRunHistory(history)
      expect(result).toMatchObject({ results: [{ settled: true }] })
      expect(mutations[2]).toMatchObject({
        session_id: "session-a",
        reason: "session_history_invalid",
      })
    }
  })

  test("parks transient settlement failures and fails deterministic ones immediately", () => {
    expect(hostedSettlementFailureDisposition(new TypeError("network unavailable"))).toBe("park")
    expect(hostedSettlementFailureDisposition(Object.assign(new Error("upstream"), { status: 503 }))).toBe("park")
    expect(hostedSettlementFailureDisposition(Object.assign(new Error("bad request"), { status: 400 }))).toBe("fail")
    expect(hostedSettlementFailureDisposition(new Error("session_history_invalid"))).toBe("fail")
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
          query: querySingleTenant,
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
                  runId: "run-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 2,
                  title: "Race",
                  prompt: "Run",
                  profile: {
                    environment: { kind: "hosted_workspace", placement: "shared" },
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
      run_id: "run-a",
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
          query: querySingleTenant,
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
                  runId: "run-a",
                  streamId: "stream-a",
                  workItemId: "item-a",
                  leaseEpoch: 1,
                  title: "Indeterminate launch",
                  prompt: "Run",
                  profile: {
                    environment: { kind: "hosted_workspace", placement: "shared" },
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
      run_id: "run-a",
      session_id: "session-indeterminate",
      workspace_id: expect.stringMatching(/^wg-/),
    })
  })

  test("claims an admitted fenced Run and records truthful attention", async () => {
    const db = new RuntimeDb({
      users: [{ _id: "user-a", clerk_subject: "clerk-user-a" }],
      workgraph_outbox: [
        {
          _id: "outbox-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "outbox-a",
          effect_type: "launch_run",
          status: "pending",
          available_at: 1,
          attempt_count: 0,
          payload: { runId: "run-a", leaseEpoch: 2 },
        },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "run-a",
          work_item_id: "item-a",
          stream_id: "stream-a",
          generation: 2,
          state: "admitted",
          resolved_execution: {
            environment: { kind: "hosted_workspace", placement: "sandbox" },
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
          holder_id: "run-a",
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
      workgraph_streams: [
        {
          _id: "stream-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "stream-a",
          parent_stream_id: "stream-parent",
        },
        {
          _id: "parent-stream-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "stream-parent",
          base_repository: "https://github.test/acme/parent.git",
          base_revision: "parent-head",
        },
      ],
      orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "personal" }],
    })
    const claims = (await handler(claimLaunches)({ db } as never, {
      service_token: "service-secret",
      worker_id: "worker-a",
      now: 10,
      limit: 10,
    })) as Array<{ outboxId: string; runId: string; leaseEpoch: number; prompt: string; ownerSubject: string }>
    expect(claims).toMatchObject([
      {
        outboxId: "outbox-a",
        runId: "run-a",
        ownerSubject: "clerk-user-a",
        leaseEpoch: 2,
        queueLagMs: 9,
        activeLeaseAgeMs: 0,
        expiredRecovery: false,
        retryCount: 0,
        parentStreamId: "stream-parent",
        parentSource: {
          repoUrl: "https://github.test/acme/parent.git",
          branch: "parent-head",
        },
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
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
      state: "placing",
      child_workspace_id: "run-a",
      row_version: 2,
    })

    await expect(
      handler(markParked)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        run_id: "run-a",
        lease_epoch: 2,
        worker_id: "worker-a",
        reason: "Session API missing",
        now: 20,
      }),
    ).resolves.toEqual({ settled: false, state: "parked", retryAfterMs: 1_000 })
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
      state: "parked",
      parked_reason: "Session API missing",
      resume_attempts: 1,
      row_version: 3,
    })
    expect(db.row("workgraph_outbox", "outbox-row")).toMatchObject({
      status: "pending",
      available_at: 1_020,
      last_error: "Session API missing",
    })
    expect(db.row("workgraph_leases", "lease-row")).toMatchObject({ epoch: 2, expires_at: 900_020 })
    expect(db.rowsFor("workgraph_attention_entries")).toEqual([
      expect.objectContaining({ kind: "run", id: "run-a" }),
    ])
    await expect(
      handler(claimLaunches)({ db } as never, {
        service_token: "service-secret",
        worker_id: "worker-resume",
        now: 1_020,
        limit: 10,
      }),
    ).resolves.toMatchObject([{ runId: "run-a", leaseEpoch: 2 }])
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
      state: "placing",
      generation: 2,
      resume_attempts: 1,
      row_version: 4,
    })
    expect(db.rowsFor("workgraph_attention_entries")).toEqual([])
  })

  test("rejects a stale lease epoch without mutating the Run", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        { _id: "outbox-row", owner_user_id: "user-a", id: "outbox-a", status: "claimed", claimed_by: "worker-a" },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          owner_user_id: "user-a",
          id: "run-a",
          work_item_id: "item-a",
          generation: 3,
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
          holder_id: "run-a",
          epoch: 3,
        },
      ],
    })
    await expect(
      handler(markParked)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        run_id: "run-a",
        lease_epoch: 2,
        worker_id: "worker-a",
        reason: "stale",
        now: 20,
      }),
    ).resolves.toEqual({ settled: false })
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({ state: "admitted", row_version: 1 })
  })

  test("fails a parked Run after the sixth resume failure and surfaces the Work Item in Needs-you", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "outbox-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "outbox-a",
          status: "claimed",
          claimed_by: "worker-a",
        },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          generation: 2,
          state: "placing",
          resume_attempts: 5,
          row_version: 8,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "run-a",
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
          stream_id: "stream-a",
          state: "active",
          row_version: 3,
        },
      ],
    })

    await expect(
      handler(markParked)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        run_id: "run-a",
        lease_epoch: 2,
        worker_id: "worker-a",
        reason: "relay unavailable",
        now: 20,
      }),
    ).resolves.toEqual({ settled: true, state: "failed" })

    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
      state: "failed",
      resume_attempts: 6,
      parked_reason: "relay unavailable",
      finished_at: 20,
    })
    expect(db.row("workgraph_work_items", "item-row")).toMatchObject({ state: "failed", row_version: 4 })
    expect(db.row("workgraph_outbox", "outbox-row")).toMatchObject({
      status: "failed",
      last_error: "relay unavailable",
    })
    expect(db.row("workgraph_leases", "lease-row")).toBeUndefined()
    expect(db.rowsFor("workgraph_attention_entries")).toEqual([
      expect.objectContaining({ kind: "work_item", id: "item-a" }),
    ])
  })

  test("allows the fifth transient resume failure to park the Run", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [{
        _id: "outbox-row",
        organization_id: "org-a",
        owner_user_id: "user-a",
        id: "outbox-a",
        status: "claimed",
        claimed_by: "worker-a",
      }],
      workgraph_runs: [{
        _id: "run-row",
        organization_id: "org-a",
        owner_user_id: "user-a",
        id: "run-a",
        stream_id: "stream-a",
        work_item_id: "item-a",
        generation: 2,
        state: "placing",
        resume_attempts: 4,
        row_version: 8,
      }],
      workgraph_leases: [{
        _id: "lease-row",
        organization_id: "org-a",
        owner_user_id: "user-a",
        resource_type: "work_item",
        resource_id: "item-a",
        holder_id: "run-a",
        epoch: 2,
        expires_at: 1_000,
        row_version: 1,
      }],
    })

    await expect(
      handler(markParked)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        run_id: "run-a",
        lease_epoch: 2,
        worker_id: "worker-a",
        reason: "relay temporarily unavailable",
        now: 20,
      }),
    ).resolves.toEqual({ settled: false, state: "parked", retryAfterMs: 16_000 })
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
      state: "parked",
      resume_attempts: 5,
      parked_reason: "relay temporarily unavailable",
    })
  })

  test("parks a running Run after lease expiry without changing its generation", async () => {
    const db = new RuntimeDb({
      workgraph_outbox: [
        {
          _id: "outbox-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "outbox-a",
          idempotency_key: "run-a:launch",
          status: "completed",
        },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "run-a",
          stream_id: "stream-a",
          work_item_id: "item-a",
          session_id: "ses_wgrun_run-a",
          generation: 3,
          state: "running",
          row_version: 5,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "run-a",
          epoch: 3,
          expires_at: 10,
          row_version: 2,
        },
      ],
    })

    await expect(
      handler(parkRunning)({ db } as never, {
        service_token: "service-secret",
        organization_id: "org-a",
        owner_user_id: "user-a",
        run_id: "run-a",
        lease_epoch: 3,
        session_id: "ses_wgrun_run-a",
        reason: "relay disconnected",
        now: 20,
      }),
    ).resolves.toEqual({ settled: false, state: "parked", retryAfterMs: 1_000 })

    expect(db.row("workgraph_runs", "run-row")).toMatchObject({
      state: "parked",
      generation: 3,
      resume_attempts: 1,
    })
    expect(db.row("workgraph_leases", "lease-row")).toMatchObject({ epoch: 3, expires_at: 900_020 })
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
          effect_type: "launch_run",
          status: "pending",
          available_at: 1,
          attempt_count: 0,
          payload: { runId: "run-a", leaseEpoch: 1 },
        },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          organization_id: "org-a",
          owner_user_id: "user-a",
          id: "run-a",
          work_item_id: "item-a",
          stream_id: "stream-a",
          generation: 1,
          state: "admitted",
          resolved_execution: {
            environment: { kind: "hosted_workspace", placement: "shared" },
            harness: "opencode",
            agent: "build",
            model: { providerId: "unknown", modelId: "unknown" },
            effort: "high",
            tools: [],
            connectionIds: [],
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
          holder_id: "run-a",
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
    })) as Array<{ runId: string; leaseEpoch: number }>
    expect(claims).toMatchObject([{ runId: "run-a", leaseEpoch: 2 }])
    expect(db.row("workgraph_leases", "lease-row")).toMatchObject({ epoch: 2, expires_at: 600_010 })
    expect(db.row("workgraph_outbox", "outbox-row")).toMatchObject({
      status: "claimed",
      claimed_by: "worker-restarted",
      payload: { runId: "run-a", leaseEpoch: 2 },
    })
    await expect(
      handler(markParked)({ db } as never, {
        service_token: "service-secret",
        owner_user_id: "user-a",
        outbox_id: "outbox-a",
        run_id: "run-a",
        lease_epoch: 1,
        worker_id: "worker-restarted",
        reason: "stale callback",
        now: 11,
      }),
    ).resolves.toEqual({ settled: false })
    expect(db.row("workgraph_runs", "run-row")).toMatchObject({ state: "placing", row_version: 3 })
    expect(db.row("workgraph_leases", "lease-row")).toMatchObject({ epoch: 2 })
  })

  test("folds hosted Stream spend once and holds launch at the hard token budget", async () => {
    const db = new RuntimeDb({
      users: [{ _id: "user-a", clerk_subject: "clerk-user-a" }],
      // The usage table is keyed on the CLERK org id (the metering id
      // space), not the Convex document id — the fold must translate, so this
      // fixture keeps the two ids distinct on purpose.
      orgs: [{ _id: "org-a", owner_user_id: "user-a", kind: "clerk", clerk_org_id: "clerk_org_budget" }],
      workgraph_outbox: [
        {
          _id: "outbox-row",
          owner_user_id: "user-a",
          id: "outbox-a",
          effect_type: "launch_run",
          status: "pending",
          available_at: 1,
          attempt_count: 0,
          payload: { runId: "run-a", leaseEpoch: 1 },
        },
      ],
      workgraph_runs: [
        {
          _id: "run-row",
          owner_user_id: "user-a",
          id: "run-a",
          work_item_id: "item-a",
          stream_id: "stream-a",
          generation: 1,
          state: "admitted",
          resolved_execution: {
            environment: { kind: "hosted_workspace", placement: "shared" },
            harness: "opencode",
            agent: "build",
            model: { providerId: "unknown", modelId: "unknown" },
            effort: "high",
            tools: [],
            connectionIds: [],
          },
          row_version: 1,
        },
      ],
      workgraph_leases: [
        {
          _id: "lease-row",
          owner_user_id: "user-a",
          resource_type: "work_item",
          resource_id: "item-a",
          holder_id: "run-a",
          epoch: 1,
          expires_at: 100_000,
          row_version: 1,
        },
      ],
      workgraph_work_items: [
        {
          _id: "item-row",
          owner_user_id: "user-a",
          id: "item-a",
          stream_id: "stream-a",
          state: "active",
          title: "Held by budget",
          row_version: 1,
        },
      ],
      workgraph_streams: [
        {
          _id: "stream-row",
          owner_user_id: "user-a",
          id: "stream-a",
          workgraph_id: "workgraph_default",
          lifecycle_state: "active",
          visibility: "visible",
          execution_defaults: {
            budget: { amount: 1_000, unit: "tokens", window: "day" },
            agents: [{
              name: "Builder",
              brief: "Build and verify the requested change.",
              generation: {
                harness: "opencode",
                agent: "build",
                model: { providerId: "unknown", modelId: "unknown" },
                effort: "high",
                tools: [],
                connectionIds: [],
              },
            }],
          },
          master_status: {
            state: "attention",
            escalation: "failure_halt",
            sessionId: "ses_master_stream-a",
            message: "Existing master failure",
            receiptRefs: ["receipt:failure"],
            updatedAt: 4,
          },
          row_version: 1,
          updated_at: 1,
        },
      ],
      llm_usage_events: [
        {
          _id: "usage-row",
          org_id: "clerk_org_budget",
          user_id: "clerk-user-a",
          session_id: "ses_wgrun_run-a",
          message_id: "msg-a",
          stream_id: "stream-a",
          run_id: "run-a",
          provider_id: "unknown",
          model_id: "unknown",
          input_tokens: 600,
          output_tokens: 400,
          reasoning_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          created_at: 5,
        },
      ],
    })

    await expect(
      handler(claimLaunches)({ db } as never, {
        service_token: "service-secret",
        worker_id: "worker-a",
        now: 10,
        limit: 10,
      }),
    ).resolves.toEqual([])
    expect(db.row("workgraph_streams", "stream-row")).toMatchObject({
      spend: { total_tokens: 1_000, as_of: 5 },
      master_status: {
        state: "attention",
        escalation: "budget_exhausted",
        budgetPriorStatus: {
          state: "attention",
          escalation: "failure_halt",
          message: "Existing master failure",
        },
      },
    })
    expect(db.rowsFor("workgraph_attention_entries")).toEqual([
      expect.objectContaining({ kind: "master_escalation", id: "stream-a" }),
    ])
    await expect(
      handler(claimLaunches)({ db } as never, {
        service_token: "service-secret",
        worker_id: "worker-a",
        now: 60_010,
        limit: 10,
      }),
    ).resolves.toEqual([])
    expect(db.row("workgraph_streams", "stream-row")?.spend).toMatchObject({
      total_tokens: 1_000,
      as_of: 5,
      as_of_message_id: "msg-a",
      day_tokens: 1_000,
      by_profile: [{ profile: "Builder", total_tokens: 1_000 }],
    })
    await expect(
      handler(claimLaunches)({ db } as never, {
        service_token: "service-secret",
        worker_id: "worker-a",
        now: 86_400_010,
        limit: 10,
      }),
    ).resolves.toHaveLength(1)
    expect(db.row("workgraph_streams", "stream-row")?.master_status).toEqual({
      state: "attention",
      escalation: "failure_halt",
      sessionId: "ses_master_stream-a",
      message: "Existing master failure",
      receiptRefs: ["receipt:failure"],
      updatedAt: 4,
    })
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

function transcriptServices(
  mintRuntimeAccessToken: (input: Record<string, unknown>) => Promise<{ token: string; expiresAt: number; jti: string }>
    = async () => ({ token: "runtime-token", expiresAt: 1000, jti: "jti" }),
) {
  return {
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
        mintRuntimeAccessToken,
        getRelayEndpoint: async () => "https://relay.test",
      },
    },
  } as unknown as ControlPlaneServices
}

async function reconcileRunHistory(
  history: unknown,
  completionRetry?: { terminalSeq: number; requestedAt: number },
  active?: unknown,
) {
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
        query: querySingleTenant,
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
                runId: "run-a",
                leaseEpoch: 2,
                sessionId: "session-a",
                workspaceId: "workspace-a",
                ...(completionRetry ? { completionRetry } : {}),
              },
            ]
          if ("terminal_seq" in args) {
            return { accepted: true, terminalSeq: args.terminal_seq, requestedAt: args.now }
          }
          return { settled: true }
        },
      },
      fetch: async (input) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith("/history")) return Response.json(history)
        // Defaults to no owned drains, so the settlement paths under test read
        // an idle harness unless a case says otherwise.
        if (url.pathname.endsWith("/api/session/active")) return Response.json(active ?? { data: {} })
        if (url.pathname.includes("/connection-binding/") || url.pathname.includes("/run-binding/")) {
          return new Response(null, { status: 204 })
        }
        if (url.pathname.endsWith("/prompt")) return Response.json({ data: { admitted: true } })
        throw new Error(`Unexpected hosted runtime request ${url.pathname}`)
      },
    },
  )
  return { mutations, result: await runtime!.reconcile() }
}

async function runControlEffect(input: {
  effectType: "interrupt_run" | "finalize_stream" | "cleanup_stream"
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
        query: querySingleTenant,
        mutation: async (_fn, args) => {
          if (args.limit === 500 && Object.keys(args).length === 2)
            return [{ organizationId: "org-a", ownerUserId: "user-a" }]
          mutations.push(args)
          // Dispatch on the request SHAPE, not call order: the background
          // control-effect drain now runs concurrently with the launch/running
          // phases, so `mutations.length` is no longer a stable sequencer.
          // claimControlEffects is the only worker-fenced limit-25 claim.
          if (args.limit === 25 && "worker_id" in args)
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
          // completeControlEffect ack (carries the `ok` field the tests inspect).
          if ("outbox_id" in args) return { settled: true }
          // drainSessionIntake backlog probe (limit-25, no worker fence).
          if (args.limit === 25) return { completed: 0 }
          // claimLaunches / listRunning / claimSourcePlans: nothing to do here.
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
          lte: (field: string, value: number) => {
            selected = selected.filter((row) => Number(row[field]) <= value)
            return query
          },
          gt: (field: string, value: number) => {
            selected = selected.filter((row) => Number(row[field]) > value)
            return query
          },
          gte: (field: string, value: number) => {
            selected = selected.filter((row) => Number(row[field]) >= value)
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
          neq: (field: string, value: unknown) => (row: Record<string, unknown>) => row[field] !== value,
          gt: (field: string, value: unknown) => (row: Record<string, unknown>) =>
            typeof value === "number" ? Number(row[field]) > value : String(row[field] ?? "") > String(value),
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
