import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { defaultHomeRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { ControlPlaneServices } from "../../../authority/services"
import {
  AdmissionAgentPlanSchema,
  DEFAULT_STREAM_CHARTER_HINTS,
  ExecutionProfileDefaultsSchema,
  ResolvedExecutionProfileSchema,
  WorkGraphRunToolNames,
  WorkGraphMasterToolNames,
  WorkGraphBrokerTokenHeader,
  resolvedPlacement,
  runSessionId,
} from "@claxedo/workgraph/contracts"
import { clean, type HostedWorkerEnv } from "../../../authority/adapters/worker/hosted-compose"
import { buildMasterPrompt, charterClause } from "@claxedo/workgraph"
import { createWorkGraphOperationalReporter, type WorkGraphOperationalReporter, type WorkGraphReconciliationTrigger } from "../operational-telemetry"
import { createWorkGraphConvexExecutor } from "../convex/store"
import { settlementTenantKey, type SettlementTenant } from "../settlement-dispatcher"

type Mutation = FunctionReference<"mutation">
type Query = FunctionReference<"query">
const api = anyApi as unknown as {
  sessions: {
    syncWorkGraphSession: Mutation
    retainWorkGraphSessionTranscript: Mutation
  }
  workspaces: {
    ensureWorkGraph: Mutation
  }
  workgraphRuntime: {
    listDirtyTenants: Query
    listStaleTenants: Query
    markTenantDrained: Mutation
    claimLaunches: Mutation
    markRunning: Mutation
    retryLaunch: Mutation
    recordResult: Mutation
    listRunning: Mutation
    requestCompletionRetry: Mutation
    recordFailure: Mutation
    parkRunning: Mutation
    markParked: Mutation
    claimControlEffects: Mutation
    completeControlEffect: Mutation
    confirmLaunch: Mutation
    settleRejectedProvision: Mutation
    compensateRejectedLaunch: Mutation
    claimMasterTurn: Mutation
    reserveMasterAdmission: Mutation
    confirmMasterAdmission: Mutation
    completeMasterTurn: Mutation
    failMasterTurn: Mutation
  }
  workgraphBackground: {
    drainSessionIntake: Mutation
    claimSourcePlans: Mutation
    markSourcePlanSession: Mutation
    retrySourcePlanLaunch: Mutation
    listRunningSourcePlans: Mutation
    completeSourcePlan: Mutation
    failSourcePlan: Mutation
  }
  workgraphConnections: {
    bindRunConnections: Mutation
  }
}

type Claim = {
  ownerUserId: string
  ownerSubject: string
  orgId: string
  outboxId: string
  runId: string
  streamId: string
  parentStreamId?: string
  parentSource?: { repoUrl?: string; branch: string }
  workItemId: string
  leaseEpoch: number
  queueLagMs?: number
  activeLeaseAgeMs?: number
  expiredRecovery?: boolean
  retryCount?: number
  title: string
  prompt: string
  profile: {
    environment: {
      kind: "hosted_workspace"
      placement: "shared" | "worktree" | "sandbox"
      repositoryUrl?: string
      presetId?: string
    }
    repository?: { remoteUrl?: string; baseRevision: string }
    harness: string
    agent: string
    model: { providerId: string; modelId: string }
    effort: string
    tools: string[]
    connectionIds: string[]
  }
}

type Executor = {
  mutation: (fn: Mutation, args: Record<string, unknown>) => Promise<unknown>
  query?: (fn: Query, args: Record<string, unknown>) => Promise<unknown>
}
type RuntimeExecutor = Executor & Required<Pick<Executor, "query">>
type RuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type HostedSessionPublisher = {
  launch: (input: {
    organizationId: string
    ownerUserId: string
    workspaceId: string
    sessionId: string
    title: string
    repoUrl?: string
    branch?: string
    homeRegion?: string
    now: number
  }) => Promise<void>
  snapshot: (input: { organizationId: string; ownerUserId: string; workspaceId: string; sessionId: string; messages: unknown[]; now: number }) => Promise<void>
}
type BackgroundClaim = {
  ownerUserId: string
  orgId: string
  jobId: string
  leaseEpoch: number
  queueLagMs?: number
  activeLeaseAgeMs?: number
  expiredRecovery?: boolean
  retryCount?: number
  streamId: string
  sessionId?: string
  prompt: string
  profile: { harness: string; agent: string; model: { providerId: string; modelId: string }; effort: string; tools: string[] }
}
type RunningBackgroundSession = {
  ownerUserId: string
  orgId: string
  jobId: string
  leaseEpoch: number
  sessionId: string
  workspaceId: string
  activeLeaseAgeMs?: number
  expiredRecovery?: boolean
}
type SourcePlanClaim = Omit<BackgroundClaim, "streamId"> & { proposalId: string; sessionId?: string }
type RunningSourcePlan = RunningBackgroundSession
export type WorkerTenant = SettlementTenant
type DirtyWorkerTenant = WorkerTenant & Readonly<{ dirtyAt: number; dirtyToken: string }>
export const SWEEP_SUBREQUEST_BUDGET = 800
const SWEEP_MIN_SUBREQUESTS_PER_TENANT = 3
export type HostedMasterIntent = SettlementTenant &
  Readonly<{
    streamId: string
    trigger: "mailbox" | "task_settled" | "schedule"
  }>

/** Durable Worker dispatcher over SandboxManager → authenticated relay → the shared harness Session API. */
export function createHostedWorkGraphRuntime(
  env: HostedWorkerEnv,
  controlPlaneServices: ControlPlaneServices,
  options: {
    executor?: RuntimeExecutor
    fetch?: RuntimeFetch
    now?: () => number
    background?: boolean
    /** Enabled only after every production sandbox driver supports orphan enumeration. */
    sandboxPlacementEnabled?: boolean
    sessionPublisher?: HostedSessionPublisher
  } = {},
) {
  const url = clean(env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!url || !serviceToken) return
  const baseClient: RuntimeExecutor = options.executor ?? createWorkGraphConvexExecutor(url)
  const baseQuery = baseClient.query
  const baseRequest = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const workerId = clean(env.CLAXEDO_WORKGRAPH_WORKER_ID) ?? "claxedo-worker"
  const telemetry = createWorkGraphOperationalReporter({ telemetry: controlPlaneServices.telemetry, env, now })
  const sessionPublisher = options.sessionPublisher ?? (options.executor ? undefined : convexSessionPublisher(url, serviceToken))
  return {
    master: (intent: HostedMasterIntent) =>
      reconcileHostedMaster({
        client: baseClient,
        services: controlPlaneServices,
        request: baseRequest,
        serviceToken,
        workerId,
        now,
        intent,
        brokerUrl: clean(env.CLAXEDO_PUBLIC_URL) ?? clean(env.CLAXEDO_SERVER_URL) ?? clean(env.CLAXEDO_CENTRAL_URL),
      }),
    listStaleTenants: async (input: { now?: number; thresholdMs?: number; limit?: number } = {}) =>
      (await baseQuery(api.workgraphRuntime.listStaleTenants, {
        service_token: serviceToken,
        now: input.now ?? now(),
        ...(input.thresholdMs === undefined ? {} : { threshold_ms: input.thresholdMs }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })) as WorkerTenant[],
    reconcile: async (
      run: {
        background?: boolean
        tenants?: WorkerTenant[]
        trigger?: WorkGraphReconciliationTrigger
        controlOnly?: boolean
      } = {},
    ) => {
      const claimedAt = now()
      const trigger = run.trigger ?? "cron"
      const budget = run.tenants ? undefined : createSweepSubrequestBudget()
      const client = budget ? budgetExecutor(baseClient, budget) : baseClient
      const query = client.query
      const request: RuntimeFetch = budget ? (input, init) => budget.run(() => baseRequest(input, init)) : baseRequest
      const services = budget ? budgetServices(controlPlaneServices, budget) : controlPlaneServices
      let sweepRemaining = 0
      let sweepSelected = 0
      try {
        const [dirty, stale] = run.tenants
          ? ([[], []] as const)
          : await Promise.all([
              query(api.workgraphRuntime.listDirtyTenants, {
                service_token: serviceToken,
                limit: 500,
                before: claimedAt,
              }) as Promise<DirtyWorkerTenant[]>,
              query(api.workgraphRuntime.listStaleTenants, {
                service_token: serviceToken,
                now: claimedAt,
                limit: 500,
              }) as Promise<WorkerTenant[]>,
            ])
        const discovered = run.tenants ? run.tenants : [...dirty, ...stale]
        const unique = Array.from(new Map(discovered.map((tenant) => [settlementTenantKey(tenant), tenant])).values())
        const tenantLimit = run.tenants ? unique.length : Math.floor((budget?.remaining ?? 0) / SWEEP_MIN_SUBREQUESTS_PER_TENANT)
        const tenants = unique.slice(0, tenantLimit)
        sweepRemaining = unique.length - tenants.length
        sweepSelected = tenants.length
        if (unique.length > tenants.length) {
          console.warn(`[claxedo-server] WorkGraph sweep budget left ${unique.length - tenants.length} tenants dirty`)
        }
        const selectedTenantKeys = new Set(tenants.map(settlementTenantKey))
        const drainDirty = () =>
          Promise.all(
            dirty
              .filter((tenant) => typeof tenant.dirtyAt === "number")
              .filter((tenant) => selectedTenantKeys.has(settlementTenantKey(tenant)))
              .map((tenant, index) =>
                client.mutation(api.workgraphRuntime.markTenantDrained, {
                  service_token: serviceToken,
                  organization_id: tenant.organizationId,
                  owner_user_id: tenant.ownerUserId,
                  dirty_token: tenant.dirtyToken,
                  drained_at: now(),
                  ...(index === 0
                    ? {
                        prune_before: claimedAt - 7 * 24 * 60 * 60_000,
                        prune_limit: 500,
                      }
                    : {}),
                }),
              ),
          )
        // Fast control lane: a Stream delete/close/interrupt control effect has
        // ZERO launch dependency, yet on the shared per-tenant settle lane its
        // settle wake queues behind a 15-20s launch-provision + running-run
        // history-poll pass (measured: settle-wake fired_at - fire_at p90 22.8s,
        // p95 32.2s on staging), which blew a bare-Stream delete's <20s SLA.
        // The dedicated control WakeLane (serialKey `${tenant}:control`) nudges
        // this path so the delete drains on its own idle lane in ~1-2s, never
        // waiting on the launch lane. The launch lane + 15-min sweep still drain
        // any control effect this fast path misses, so it is purely additive.
        if (run.controlOnly) {
          const controls = await drainControlEffects(client, services, request, serviceToken, workerId, now, tenants, telemetry)
          await drainDirty()
          return {
            launched: [],
            results: [],
            background: { controls, intake: { completed: 0 }, sourcePlanning: { launched: [], results: [] } },
          }
        }
        const claims = (await tenantRows(client, api.workgraphRuntime.claimLaunches, tenants, {
          service_token: serviceToken,
          worker_id: workerId,
          now: claimedAt,
          limit: 10,
        })) as Claim[]
        // Control effects (stream deletion/interrupt) are fast, budget-gated
        // operations that used to drain LAST, behind slow launch provisioning and
        // running-run history polling. On the shared per-tenant settle lane a
        // launch-heavy pass takes 18-24s, so a bare-Stream delete blew its <20s
        // SLA even though its own `completeControlEffect` needs only ~1s. Start the
        // background drain CONCURRENTLY so the deletion settles independent of
        // launch load; it claims its own outbox rows, so there is no data
        // dependency on `launched`/`results`. Settle it to a tagged result so an
        // early throw in the launch phase can never orphan the promise.
        const backgroundEnabled = !(options.background === false || run.background === false)
        const backgroundSettled: Promise<{ ok: true; value: Awaited<ReturnType<typeof reconcileBackground>> | undefined } | { ok: false; error: unknown }> = backgroundEnabled
          ? reconcileBackground(client, services, request, serviceToken, workerId, now, tenants, telemetry).then(
              (value) => ({ ok: true as const, value }),
              (error) => ({ ok: false as const, error }),
            )
          : Promise.resolve({ ok: true as const, value: undefined })
        const launched = await Promise.all(
          claims.map(async (claim) => {
            let compensationTarget: { sessionId: string; workspaceId: string } | undefined
            try {
              const connectionTools = claim.profile.tools.filter(
                (tool) =>
                  tool === "connection_work_source_list" ||
                  tool === "connection_work_source_comment" ||
                  tool === "connection_work_source_update" ||
                  tool === "connection_code_host_open_pr",
              )
              const brokerUrl = clean(env.CLAXEDO_PUBLIC_URL) ?? clean(env.CLAXEDO_SERVER_URL) ?? clean(env.CLAXEDO_CENTRAL_URL)
              const brokerOrigin = brokerUrl ? new URL(brokerUrl).origin : undefined
              if (claim.profile.connectionIds.length > 0 && (!connectionTools.length || !brokerUrl)) {
                throw new Error("Connection-bound Runs require explicit Connection tools and a central broker URL")
              }
              if (!brokerUrl) throw new Error("Hosted Runs require a central broker URL")
              const manager = services.sandbox.sandboxManager
              const provider = services.relay.provider
              if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
              const placementKind = resolvedPlacement(claim.profile.environment.placement)
              if (placementKind === "worktree") {
                throw new Error("Worktree placement is unavailable in hosted WorkGraph execution")
              }
              if (placementKind === "sandbox" && !options.sandboxPlacementEnabled) {
                throw new Error("Sandbox placement is disabled until sandbox-driver orphan enumeration is available")
              }
              const envelopeWorkspaceId = await workGraphWorkspaceId(claim.orgId, claim.ownerUserId, claim.streamId)
              const workspaceId = placementKind === "sandbox" ? `${envelopeWorkspaceId}:run:${claim.runId}` : envelopeWorkspaceId
              const source = claim.parentSource?.repoUrl
                ? {
                    kind: "git" as const,
                    repoUrl: claim.parentSource.repoUrl,
                    branch: claim.parentSource.branch,
                  }
                : claim.profile.environment.kind === "hosted_workspace" && claim.profile.environment.repositoryUrl
                  ? {
                      kind: "git" as const,
                      repoUrl: claim.profile.environment.repositoryUrl,
                      branch: claim.profile.repository?.baseRevision ?? "HEAD",
                    }
                  : claim.profile.repository?.remoteUrl
                    ? {
                        kind: "git" as const,
                        repoUrl: claim.profile.repository.remoteUrl,
                        branch: claim.profile.repository.baseRevision,
                      }
                    : { kind: "empty" as const }
              const placement = await manager.ensure(workspaceId, {
                homeRegion: services.defaultHomeRegion ?? defaultHomeRegion(),
                labels: {
                  workload: "workgraph",
                  organizationId: claim.orgId,
                  ownerUserId: claim.ownerUserId,
                  streamId: claim.streamId,
                  ...(claim.parentStreamId ? { parentStreamId: claim.parentStreamId } : {}),
                  ...(placementKind === "sandbox" ? { runId: claim.runId } : {}),
                },
                runtimeCwd: "/workspace",
                env: {
                  WORKSPACE_RUNTIME_RUNNER: claim.profile.harness,
                  CLAXEDO_WORKGRAPH_STREAM_ID: claim.streamId,
                  CLAXEDO_WORKGRAPH_RUN_ID: claim.runId,
                  CLAXEDO_WORKGRAPH_WORK_ITEM_ID: claim.workItemId,
                  ...(brokerOrigin ? { WORKSPACE_RUNTIME_WORKGRAPH_BROKER_ORIGIN: brokerOrigin } : {}),
                },
                source,
                exposure: { kind: "relay" },
              })
              if (placement.status === "provisioning") {
                return await client.mutation(
                  api.workgraphRuntime.retryLaunch,
                  mutationArgs(claim, serviceToken, workerId, {
                    available_at: now() + placement.retryAfterMs,
                    reason: "Hosted workspace is provisioning",
                    now: now(),
                  }),
                )
              }
              if (placement.status !== "ready") throw new Error(placement.error ?? "Hosted workspace is unavailable")
              const token = await provider.mintRuntimeAccessToken({
                workspaceId,
                hostId: placement.hostId,
                subject: claim.ownerSubject,
                orgId: claim.orgId,
                role: "owner",
                ttlMs: 10 * 60_000,
              })
              const relay = await provider.getRelayEndpoint(workspaceId, placement.homeRegion as never)
              const runtime = runtimeRequest(request, relay, workspaceId, token.token)
              const confirmed = (await client.mutation(api.workgraphRuntime.confirmLaunch, mutationArgs(claim, serviceToken, workerId, { now: now() }))) as { accepted?: boolean }
              if (!confirmed.accepted) {
                const destroyed = await manager.destroy(workspaceId)
                if (!destroyed.ok && destroyed.reason !== "runtime_lease_missing") {
                  throw new Error(`Hosted WorkGraph rejected launch cleanup failed: ${destroyed.reason}`)
                }
                if (destroyed.ok) await manager.release(workspaceId)
                await client.mutation(api.workgraphRuntime.settleRejectedProvision, mutationArgs(claim, serviceToken, workerId, { now: now() }))
                return { settled: false, state: "cancelled" }
              }
              const created = await runtime(`/session?harness=${encodeURIComponent(claim.profile.harness)}`, {
                method: "POST",
                body: JSON.stringify({
                  id: runSessionId(claim.runId),
                  title: claim.title,
                  agent: claim.profile.agent,
                  model: {
                    providerID: claim.profile.model.providerId,
                    modelID: claim.profile.model.modelId,
                  },
                  variant: claim.profile.effort,
                }),
              })
              const createdBody = (await created.json()) as { id?: string }
              const sessionId = createdBody.id
              if (!sessionId) throw new Error("Hosted Session create response did not include a Session ID")
              compensationTarget = { sessionId, workspaceId }
              const running = (await client.mutation(
                api.workgraphRuntime.markRunning,
                mutationArgs(claim, serviceToken, workerId, {
                  workspace_id: workspaceId,
                  session_id: sessionId,
                  now: now(),
                }),
              )) as { settled?: boolean }
              if (!running.settled) {
                const compensation = (await client.mutation(api.workgraphRuntime.compensateRejectedLaunch, {
                  service_token: serviceToken,
                  organization_id: claim.orgId,
                  owner_user_id: claim.ownerUserId,
                  outbox_id: claim.outboxId,
                  run_id: claim.runId,
                  worker_id: workerId,
                  session_id: sessionId,
                  workspace_id: workspaceId,
                  now: now(),
                })) as { settled?: boolean }
                if (!compensation.settled) throw new Error("Durable launch compensation was rejected after the final launch fence")
                return { settled: false, state: "compensating" }
              }
              await sessionPublisher?.launch({
                organizationId: claim.orgId,
                ownerUserId: claim.ownerUserId,
                workspaceId,
                sessionId,
                title: claim.title,
                ...(source.kind === "git" ? { repoUrl: source.repoUrl, branch: source.branch } : {}),
                homeRegion: placement.homeRegion,
                now: now(),
              })
              await runtime("/api/workgraph/run-binding", {
                method: "POST",
                headers: { [WorkGraphBrokerTokenHeader]: token.token },
                body: JSON.stringify({
                  version: 1,
                  identity: {
                    runId: claim.runId,
                    sessionId,
                    workspaceId,
                    generation: claim.leaseEpoch,
                  },
                  brokerUrl,
                }),
              })
              if (claim.profile.connectionIds.length > 0) {
                await client.mutation(api.workgraphConnections.bindRunConnections, {
                  service_token: serviceToken,
                  ownerUserId: claim.ownerUserId,
                  orgId: claim.orgId,
                  runId: claim.runId,
                  sessionId,
                  workspaceId,
                  connectionIds: claim.profile.connectionIds,
                  tools: connectionTools,
                })
                await runtime("/api/workgraph/connection-binding", {
                  method: "POST",
                  headers: { [WorkGraphBrokerTokenHeader]: token.token },
                  body: JSON.stringify({
                    version: 1,
                    identity: { runId: claim.runId, sessionId, workspaceId },
                    connectionIds: claim.profile.connectionIds,
                    tools: connectionTools,
                    brokerUrl,
                  }),
                })
              }
              await runtime(`/session/${encodeURIComponent(sessionId)}/prompt_async?harness=${encodeURIComponent(claim.profile.harness)}`, {
                method: "POST",
                body: JSON.stringify({
                  messageID: `msg_workgraph_${claim.runId}`,
                  parts: [{ type: "text", text: managedRunPrompt(claim.prompt) }],
                  agent: claim.profile.agent,
                  model: {
                    providerID: claim.profile.model.providerId,
                    modelID: claim.profile.model.modelId,
                  },
                  variant: claim.profile.effort,
                }),
              })
              return { settled: true, state: "running" }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error)
              if (compensationTarget) {
                const compensation = (await client.mutation(api.workgraphRuntime.compensateRejectedLaunch, {
                  service_token: serviceToken,
                  organization_id: claim.orgId,
                  owner_user_id: claim.ownerUserId,
                  outbox_id: claim.outboxId,
                  run_id: claim.runId,
                  worker_id: workerId,
                  session_id: compensationTarget.sessionId,
                  workspace_id: compensationTarget.workspaceId,
                  now: now(),
                })) as { settled?: boolean }
                if (!compensation.settled) throw new Error(`${reason}; durable launch compensation was rejected`)
                return { settled: false, state: "compensating", reason }
              }
              return await client.mutation(
                api.workgraphRuntime.markParked,
                mutationArgs(claim, serviceToken, workerId, {
                  reason,
                  now: now(),
                }),
              )
            }
          }),
        )
        const running = (await tenantRows(client, api.workgraphRuntime.listRunning, tenants, {
          service_token: serviceToken,
          limit: 10,
          now: now(),
        })) as RunningRun[]
        const results = await Promise.all(
          running.map(async (run) => {
            try {
              const provider = services.relay.provider
              const manager = services.sandbox.sandboxManager
              if (!provider || !manager) throw new Error("Hosted sandbox manager and relay provider are required")
              const placement = await manager.target(run.workspaceId)
              if (placement.status !== "ready") throw new HostedSettlementTransportError("Hosted workspace is unavailable during result reconciliation")
              const token = await provider.mintRuntimeAccessToken({
                workspaceId: run.workspaceId,
                hostId: placement.hostId,
                subject: run.ownerUserId,
                orgId: run.orgId,
                role: "owner",
                ttlMs: 10 * 60_000,
              })
              const relay = await provider.getRelayEndpoint(run.workspaceId, placement.homeRegion as never)
              const runtime = runtimeRequest(request, relay, run.workspaceId, token.token)
              const snapshot = await hostedSessionSnapshot(runtime, run.sessionId)
              if (sessionPublisher && snapshot.messages.length > 0) {
                const snapshotInput = {
                  organizationId: run.orgId,
                  ownerUserId: run.ownerUserId,
                  workspaceId: run.workspaceId,
                  sessionId: run.sessionId,
                  messages: snapshot.messages,
                  now: now(),
                }
                await (budget ? budget.run(() => sessionPublisher.snapshot(snapshotInput)) : sessionPublisher.snapshot(snapshotInput))
              }
              const status = sessionString(snapshot.session.status)
              if (status === "busy" || status === "recovering" || status === "retry") {
                return { settled: false, state: "running" }
              }
              const lastTurn = record(snapshot.session.lastTurn)
              const outcome = sessionString(lastTurn?.status)
              if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") {
                return { settled: false, state: "running" }
              }
              if (outcome === "completed") {
                const terminalSeq = lastTurn?.completedAt
                if (typeof terminalSeq !== "number" || !Number.isSafeInteger(terminalSeq) || terminalSeq < 0) {
                  throw new HostedSessionSnapshotError("Hosted Session completed without a durable completion timestamp")
                }
                const retry = run.completionRetry
                  ? { accepted: true as const, ...run.completionRetry }
                  : ((await client.mutation(
                      api.workgraphRuntime.requestCompletionRetry,
                      resultArgs(run, serviceToken, {
                        terminal_seq: terminalSeq,
                        now: now(),
                      }),
                    )) as { accepted?: boolean; terminalSeq?: number; requestedAt?: number })
                if (!retry.accepted) return { settled: false, state: "already_settled" }
                if (terminalSeq <= Number(retry.terminalSeq)) {
                  try {
                    await runtime(`/session/${encodeURIComponent(run.sessionId)}/prompt_async`, {
                      method: "POST",
                      body: JSON.stringify({
                        messageID: `msg_workgraph_completion_${run.runId}`,
                        parts: [{
                          type: "text",
                          text: [
                            "Your previous turn ended without completing the active WorkGraph Run.",
                            "Call workgraph_complete_task now with a concise summary and evidence for every completion requirement.",
                            "Each evidence entry must use the exact requirementId from the Task. Do not finish with another text-only response.",
                          ].join("\n"),
                        }],
                      }),
                    })
                  } catch {
                    return { settled: false, state: "retrying_explicit_completion" }
                  }
                  return { settled: false, state: "retrying_explicit_completion" }
                }
              }
              const [connectionCleanup, runCleanup] = await Promise.all([
                request(`${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(run.workspaceId)}/api/workgraph/connection-binding/${encodeURIComponent(run.sessionId)}`, {
                  method: "DELETE",
                  headers: { authorization: `Bearer ${token.token}`, "x-opencode-directory": "/workspace" },
                }),
                request(`${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(run.workspaceId)}/api/workgraph/run-binding/${encodeURIComponent(run.sessionId)}`, {
                  method: "DELETE",
                  headers: { authorization: `Bearer ${token.token}`, "x-opencode-directory": "/workspace" },
                }),
              ])
              if (!connectionCleanup.ok) {
                throw new HostedSessionRequestError(connectionCleanup.status, await connectionCleanup.text(), { method: "DELETE", path: `/api/workgraph/connection-binding/${run.sessionId}` })
              }
              if (!runCleanup.ok) {
                throw new HostedSessionRequestError(runCleanup.status, await runCleanup.text(), { method: "DELETE", path: `/api/workgraph/run-binding/${run.sessionId}` })
              }
              if (outcome === "failed") {
                return await client.mutation(
                  api.workgraphRuntime.recordFailure,
                  resultArgs(run, serviceToken, {
                    reason: sessionString(lastTurn?.error) ?? "Hosted Session failed",
                    now: now(),
                  }),
                )
              }
              return await client.mutation(
                api.workgraphRuntime.recordFailure,
                resultArgs(run, serviceToken, {
                  reason: outcome === "cancelled"
                    ? (sessionString(lastTurn?.reason) ?? "Hosted Session was cancelled")
                    : "Hosted Session ended without workgraph_complete_task after one completion retry",
                  now: now(),
                }),
              )
            } catch (error) {
              const mutation = hostedSettlementFailureDisposition(error) === "park" ? api.workgraphRuntime.parkRunning : api.workgraphRuntime.recordFailure
              return await client.mutation(
                mutation,
                resultArgs(run, serviceToken, {
                  reason: error instanceof Error ? error.message : String(error),
                  now: now(),
                }),
              )
            }
          }),
        )
        const backgroundOutcome = await backgroundSettled
        if (!backgroundOutcome.ok) throw backgroundOutcome.error
        const background = backgroundOutcome.value
        recordRunTelemetry(telemetry, trigger, claims, running, launched, results, now() - claimedAt)
        await drainDirty()
        return { launched, results, ...(background ? { background } : {}) }
      } catch (error) {
        if (error instanceof SweepSubrequestBudgetExhausted) {
          console.warn(`[claxedo-server] WorkGraph sweep budget left ${Math.max(1, sweepRemaining + sweepSelected)} tenants dirty`)
          return { launched: [], results: [] }
        }
        telemetry.reconciliation({
          trigger,
          outcome: "failed",
          latencyMs: now() - claimedAt,
          lagMs: 0,
          claimed: 0,
          running: 0,
          settled: 0,
          failed: 1,
        })
        throw error
      }
    },
  }
}

type HostedMasterClaim = Readonly<{
  state: "settled" | "launch" | "monitor" | "deferred"
  retryAfterMs?: number
  ownerSubject?: string
  stream?: {
    id: string
    title: string
    charter?: { text: string; hash: string }
    executionDefaults: unknown
    rowVersion: number
  }
  sessionId?: string
  turnId?: string
  historyAfter?: number
  admissionConfirmed?: boolean
  failureCount?: number
  trigger?: "mailbox" | "task_settled" | "schedule"
  mailbox?: Array<{ id: string; message: string; provenance: unknown }>
  runs?: Array<{
    id: string
    workItemId: string
    state: string
    result?: unknown
    resolvedExecution: unknown
    updatedAt: number
  }>
  evidenceIds?: string[]
  artifactRefs?: string[]
}>

async function reconcileHostedMaster(
  input: Readonly<{
    client: Executor
    services: ControlPlaneServices
    request: RuntimeFetch
    serviceToken: string
    workerId: string
    now: () => number
    intent: HostedMasterIntent
    brokerUrl?: string
  }>,
) {
  const claim = (await input.client.mutation(api.workgraphRuntime.claimMasterTurn, {
    service_token: input.serviceToken,
    organization_id: input.intent.organizationId,
    owner_user_id: input.intent.ownerUserId,
    stream_id: input.intent.streamId,
    trigger: input.intent.trigger,
    now: input.now(),
  })) as HostedMasterClaim
  if (claim.state === "settled") return { settled: true, state: "hibernating" }
  // A live task Run owns the shared Stream workspace — the master turn
  // defers and the durable retry wake re-fires it after settlement.
  if (claim.state === "deferred") {
    return { settled: false, state: "deferred", retryAfterMs: claim.retryAfterMs ?? 30_000 }
  }
  if (!claim.stream || !claim.ownerSubject || !claim.sessionId || !claim.turnId || !claim.trigger) {
    throw new Error("Hosted master claim is incomplete")
  }
  try {
    const profile = resolveHostedMasterProfile(claim)
    const connectionTools = profile.tools.filter(
      (tool) =>
        tool === "connection_work_source_list" || tool === "connection_work_source_comment" || tool === "connection_work_source_update" || tool === "connection_code_host_open_pr",
    )
    if (!input.brokerUrl) throw new Error("Hosted masters require a central broker URL")
    if (profile.connectionIds.length > 0 && !connectionTools.length) {
      throw new Error("Connection-bound masters require explicit Connection tools and a central broker URL")
    }
    const brokerOrigin = input.brokerUrl ? new URL(input.brokerUrl).origin : undefined
    const manager = input.services.sandbox.sandboxManager
    const provider = input.services.relay.provider
    if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
    const workspaceId = await workGraphWorkspaceId(input.intent.organizationId, input.intent.ownerUserId, input.intent.streamId)
    const placement = await manager.ensure(workspaceId, {
      homeRegion: input.services.defaultHomeRegion ?? defaultHomeRegion(),
      labels: {
        workload: "workgraph-master",
        organizationId: input.intent.organizationId,
        ownerUserId: input.intent.ownerUserId,
        streamId: input.intent.streamId,
      },
      runtimeCwd: "/workspace",
      env: {
        WORKSPACE_RUNTIME_RUNNER: profile.harness,
        CLAXEDO_WORKGRAPH_STREAM_ID: input.intent.streamId,
        ...(brokerOrigin ? { WORKSPACE_RUNTIME_WORKGRAPH_BROKER_ORIGIN: brokerOrigin } : {}),
      },
      source:
        profile.environment.kind === "hosted_workspace" && profile.environment.repositoryUrl
          ? {
              kind: "git",
              repoUrl: profile.environment.repositoryUrl,
              branch: profile.repository?.baseRevision ?? "HEAD",
            }
          : profile.repository?.remoteUrl
            ? { kind: "git", repoUrl: profile.repository.remoteUrl, branch: profile.repository.baseRevision }
            : { kind: "empty" },
      exposure: { kind: "relay" },
    })
    if (placement.status === "provisioning") {
      return { settled: false, state: "provisioning", retryAfterMs: placement.retryAfterMs }
    }
    if (placement.status !== "ready") throw new Error(placement.error ?? "Hosted master workspace is unavailable")
    const token = await provider.mintRuntimeAccessToken({
      workspaceId,
      hostId: placement.hostId,
      subject: claim.ownerSubject,
      orgId: input.intent.organizationId,
      role: "owner",
      ttlMs: 10 * 60_000,
    })
    const relay = await provider.getRelayEndpoint(workspaceId, placement.homeRegion as never)
    const runtime = runtimeRequest(input.request, relay, workspaceId, token.token)
    if (claim.state === "launch") {
      const created = await runtime(`/session?harness=${encodeURIComponent(profile.harness)}`, {
        method: "POST",
        body: JSON.stringify({
          id: claim.sessionId,
          title: `Master · ${claim.stream.title}`,
          agent: profile.agent,
          model: { providerID: profile.model.providerId, modelID: profile.model.modelId },
          variant: profile.effort,
        }),
      })
      const body = (await created.json()) as { id?: string }
      if (body.id !== claim.sessionId) {
        throw new Error("Hosted master Session did not adopt its durable identity")
      }
      const runId = `master_${claim.stream.id}`
      await runtime("/api/workgraph/run-binding", {
        method: "POST",
        headers: { [WorkGraphBrokerTokenHeader]: token.token },
        body: JSON.stringify({
          version: 1,
          identity: { runId, streamId: claim.stream.id, sessionId: claim.sessionId, workspaceId, generation: 1 },
          tools: WorkGraphMasterToolNames,
          brokerUrl: input.brokerUrl,
        }),
      })
      if (profile.connectionIds.length > 0) {
        await input.client.mutation(api.workgraphConnections.bindRunConnections, {
          service_token: input.serviceToken,
          ownerUserId: input.intent.ownerUserId,
          orgId: input.intent.organizationId,
          runId,
          sessionId: claim.sessionId,
          workspaceId,
          connectionIds: profile.connectionIds,
          tools: connectionTools,
        })
        await runtime("/api/workgraph/connection-binding", {
          method: "POST",
          headers: { [WorkGraphBrokerTokenHeader]: token.token },
          body: JSON.stringify({
            version: 1,
            identity: { runId, sessionId: claim.sessionId, workspaceId },
            connectionIds: profile.connectionIds,
            tools: connectionTools,
            brokerUrl: input.brokerUrl,
          }),
        })
      }
      const historyAfter = claim.historyAfter ?? (await hostedSessionSnapshot(runtime, claim.sessionId)).maxEventOrdinal
      if (claim.historyAfter === undefined) {
        const reserved = (await input.client.mutation(api.workgraphRuntime.reserveMasterAdmission, {
          service_token: input.serviceToken,
          organization_id: input.intent.organizationId,
          owner_user_id: input.intent.ownerUserId,
          stream_id: input.intent.streamId,
          turn_id: claim.turnId,
          history_after: historyAfter,
          now: input.now(),
        })) as { accepted?: boolean }
        if (!reserved.accepted) return { settled: true, state: "superseded" }
      }
      await runtime(`/session/${encodeURIComponent(claim.sessionId)}/prompt_async?harness=${encodeURIComponent(profile.harness)}`, {
        method: "POST",
        body: JSON.stringify({
          messageID: `msg_${claim.turnId}`,
          parts: [{ type: "text", text: await hostedMasterPrompt(claim, profile.connectionIds) }],
          agent: profile.agent,
          model: { providerID: profile.model.providerId, modelID: profile.model.modelId },
          variant: profile.effort,
        }),
      })
      const confirmed = (await input.client.mutation(api.workgraphRuntime.confirmMasterAdmission, {
        service_token: input.serviceToken,
        organization_id: input.intent.organizationId,
        owner_user_id: input.intent.ownerUserId,
        stream_id: input.intent.streamId,
        turn_id: claim.turnId,
        now: input.now(),
      })) as { accepted?: boolean }
      if (!confirmed.accepted) return { settled: true, state: "superseded" }
      return { settled: false, state: "running", retryAfterMs: 1_000 }
    }
    const snapshot = await hostedSessionSnapshot(runtime, claim.sessionId)
    const turn = hostedSessionTurn(snapshot, `msg_${claim.turnId}`, claim.historyAfter ?? -1)
    if (!turn.settled) return { settled: false, state: "running", retryAfterMs: 1_000 }
    if (profile.connectionIds.length > 0) {
      await runtime(`/api/workgraph/connection-binding/${encodeURIComponent(claim.sessionId)}`, { method: "DELETE" })
    }
    await runtime(`/api/workgraph/run-binding/${encodeURIComponent(claim.sessionId)}`, { method: "DELETE" })
    if (turn.outcome === "failed") throw new Error(turn.error ?? "Hosted master Session failed")
    if (turn.outcome === "cancelled") throw new Error(turn.error ?? "Hosted master Session was cancelled")
    const charter = await hostedMasterCharter(claim.stream.charter)
    return await input.client.mutation(api.workgraphRuntime.completeMasterTurn, {
      service_token: input.serviceToken,
      organization_id: input.intent.organizationId,
      owner_user_id: input.intent.ownerUserId,
      stream_id: input.intent.streamId,
      turn_id: claim.turnId,
      trigger: claim.trigger,
      charter_hash: charter.hash,
      cited_charter_clause: charter.clause,
      model_version: `${profile.model.providerId}/${profile.model.modelId}`,
      reasoning_summary: turn.summary ?? "Completed the serialized master turn.",
      tool_calls: turn.toolCalls,
      resulting_diffs: claim.artifactRefs ?? [],
      evidence_ids: claim.evidenceIds ?? [],
      outcome: "completed",
      now: input.now(),
    })
  } catch (error) {
    return await input.client.mutation(api.workgraphRuntime.failMasterTurn, {
      service_token: input.serviceToken,
      organization_id: input.intent.organizationId,
      owner_user_id: input.intent.ownerUserId,
      stream_id: input.intent.streamId,
      turn_id: claim.turnId,
      reason: error instanceof Error ? error.message : String(error),
      now: input.now(),
    })
  }
}

function resolveHostedMasterProfile(claim: HostedMasterClaim) {
  for (const candidate of [claim.stream?.executionDefaults, ...(claim.runs ?? []).map((run) => run.resolvedExecution)]) {
    const parsed = ResolvedExecutionProfileSchema.safeParse(candidate)
    if (parsed.success && parsed.data.environment.kind === "hosted_workspace") return parsed.data
  }
  throw new Error("Hosted master requires a fully resolved hosted execution profile")
}

async function hostedMasterPrompt(claim: HostedMasterClaim, connectionIds: readonly string[]) {
  const mailbox = (claim.mailbox ?? []).filter((message) => {
    const value = message.provenance && typeof message.provenance === "object" ? (message.provenance as Record<string, unknown>) : undefined
    const actor = value?.actor && typeof value.actor === "object" ? (value.actor as Record<string, unknown>) : undefined
    return actor?.id !== claim.sessionId
  })
  return buildMasterPrompt({
    stream: { id: claim.stream?.id ?? "", title: claim.stream?.title ?? "" },
    charter: await hostedMasterCharter(claim.stream?.charter),
    mailbox,
    runs: (claim.runs ?? []).map((run) => ({
      id: run.id,
      workItemId: run.workItemId,
      state: run.state,
      result: JSON.stringify(run.result ?? null),
    })),
    agents: ExecutionProfileDefaultsSchema.safeParse(claim.stream?.executionDefaults).data?.agents ?? [],
    connectionIds,
    // Hosted masters have no landing tool: the prompt must not assign a
    // merge-queue duty they can only satisfy with ungated raw git.
    capabilities: { landing: false },
  })
}

async function hostedMasterCharter(charter: { text: string; hash: string } | undefined) {
  if (charter) return { ...charter, clause: charterClause(charter.text) }
  const text = DEFAULT_STREAM_CHARTER_HINTS.join("\n")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return {
    text,
    hash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    clause: DEFAULT_STREAM_CHARTER_HINTS[0]!,
  }
}

function managedRunPrompt(prompt: string) {
  return [
    prompt,
    "",
    "WorkGraph execution protocol:",
    "Before your final response, call workgraph_complete_task with a concise summary and evidence for every completion requirement.",
    "Each evidence entry must identify its requirementId. A text response without this tool call does not complete the Run.",
    'Use the exact input shape {"summary":"...","artifacts":[],"evidence":[{"requirementId":"<requirement id>","evidence":{"kind":"test_result","summary":"...","passed":true}}]} (select the appropriate supported evidence kind for the requirement).',
    "Use workgraph_report_progress only for meaningful intermediate boundaries.",
  ].join("\n")
}

// Drain ONLY the control-effect outbox (stream delete/close, run
// interrupt). Deliberately excludes session intake and source planning (both
// of which reconcileBackground also runs) because source planning can
// provision a sandbox — the control drain must stay fast (~1s) so the
// dedicated control WakeLane never inherits provisioning latency. Split out so
// the `controlOnly` reconcile path can run it in isolation.
async function drainControlEffects(
  client: Executor,
  services: ControlPlaneServices,
  request: RuntimeFetch,
  serviceToken: string,
  workerId: string,
  now: () => number,
  tenants: readonly WorkerTenant[],
  telemetry: WorkGraphOperationalReporter,
) {
  const controls = (await tenantRows(client, api.workgraphRuntime.claimControlEffects, tenants, {
    service_token: serviceToken,
    worker_id: workerId,
    now: now(),
    limit: 25,
  })) as Array<{
    ownerUserId: string
    orgId: string
    outboxId: string
    streamId: string
    effectType: "interrupt_run" | "finalize_stream" | "cleanup_stream"
    payload: { finalize?: "close" | "delete" | "replace"; sessionId?: string; sessions?: string[]; workspaceId?: string }
  }>
  const controlResults = await Promise.all(
    controls.map(async (control) => {
      const startedAt = now()
      const operation =
        control.effectType === "interrupt_run"
          ? ("cancel" as const)
          : control.payload.finalize === "delete"
            ? ("release" as const)
            : control.payload.finalize === "replace"
              ? ("cleanup" as const)
              : ("finalize" as const)
      try {
        const manager = services.sandbox.sandboxManager
        const provider = services.relay.provider
        if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
        // Sandbox placement launches into `${envelope}:run:${runId}`, so re-deriving
        // the envelope id here would address a workspace the Run never occupied and
        // interrupt a Session that only exists in the per-Run one. The enqueuing
        // mutation already recorded the id the launch actually used; prefer it.
        const workspaceId =
          control.payload.workspaceId ?? (await workGraphWorkspaceId(control.orgId, control.ownerUserId, control.streamId))
        const placement = await manager.target(workspaceId)
        if (control.effectType === "interrupt_run" && placement.status !== "ready") {
          throw new Error("Run Session placement is not ready for interruption")
        }
        if (placement.status === "ready") {
          const token = await provider.mintRuntimeAccessToken({
            workspaceId,
            hostId: placement.hostId,
            subject: control.ownerUserId,
            orgId: control.orgId,
            role: "owner",
            ttlMs: 10 * 60_000,
          })
          const relay = await provider.getRelayEndpoint(workspaceId, placement.homeRegion as never)
          const runtime = runtimeRequest(request, relay, workspaceId, token.token)
          const sessions = control.effectType === "interrupt_run" ? (control.payload.sessionId ? [control.payload.sessionId] : []) : (control.payload.sessions ?? [])
          await Promise.all(sessions.map((sessionId) => runtime(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" })))
        }
        if (control.payload.finalize === "replace") {
          const destroyed = await manager.destroy(workspaceId)
          if (!destroyed.ok && destroyed.reason !== "runtime_lease_missing") {
            throw new Error(`Hosted WorkGraph replacement reset failed: ${destroyed.reason}`)
          }
          if (destroyed.ok) await manager.release(workspaceId)
        }
        if (control.payload.finalize === "delete") await manager.release(workspaceId)
        telemetry.workspace({
          operation,
          outcome: "succeeded",
          latencyMs: now() - startedAt,
        })
        return await client.mutation(api.workgraphRuntime.completeControlEffect, {
          service_token: serviceToken,
          organization_id: control.orgId,
          owner_user_id: control.ownerUserId,
          outbox_id: control.outboxId,
          worker_id: workerId,
          ok: true,
          ...(control.payload.sessionId ? { observed_session_id: control.payload.sessionId } : {}),
          now: now(),
        })
      } catch (error) {
        telemetry.workspace({
          operation,
          outcome: "failed",
          latencyMs: now() - startedAt,
        })
        return await client.mutation(api.workgraphRuntime.completeControlEffect, {
          service_token: serviceToken,
          organization_id: control.orgId,
          owner_user_id: control.ownerUserId,
          outbox_id: control.outboxId,
          worker_id: workerId,
          ok: false,
          ...(control.payload.sessionId ? { observed_session_id: control.payload.sessionId } : {}),
          reason: error instanceof Error ? error.message : String(error),
          now: now(),
        })
      }
    }),
  )
  return controlResults
}

async function reconcileBackground(
  client: Executor,
  services: ControlPlaneServices,
  request: RuntimeFetch,
  serviceToken: string,
  workerId: string,
  now: () => number,
  tenants: readonly WorkerTenant[],
  telemetry: WorkGraphOperationalReporter,
) {
  const controlResults = await drainControlEffects(client, services, request, serviceToken, workerId, now, tenants, telemetry)
  const intakeRows = (await tenantResults(client, api.workgraphBackground.drainSessionIntake, tenants, {
    service_token: serviceToken,
    now: now(),
    limit: 25,
  })) as Array<{ completed: number; oldestAgeMs?: number }>
  const intake = { completed: intakeRows.reduce((total, result) => total + result.completed, 0) }
  telemetry.queue({
    kind: "session_intake",
    backlog: intake.completed,
    oldestAgeMs: maxNumber(intakeRows, "oldestAgeMs"),
    failed: 0,
    retried: 0,
    expiredRecoveries: 0,
    activeLeaseAgeMs: 0,
  })
  const sourcePlanning = await reconcileSourcePlanning(client, services, request, serviceToken, workerId, now, tenants, telemetry)
  return { controls: controlResults, intake, sourcePlanning }
}

async function reconcileSourcePlanning(
  client: Executor,
  services: ControlPlaneServices,
  request: RuntimeFetch,
  serviceToken: string,
  workerId: string,
  now: () => number,
  tenants: readonly WorkerTenant[],
  telemetry: WorkGraphOperationalReporter,
) {
  const claimed = await tenantRows(client, api.workgraphBackground.claimSourcePlans, tenants, {
    service_token: serviceToken,
    worker_id: workerId,
    now: now(),
    limit: 10,
  })
  const claims = claimed as SourcePlanClaim[]
  const launched = await Promise.all(
    claims.map(async (claim) => {
      let sessionId: string | undefined
      try {
        const manager = services.sandbox.sandboxManager
        const provider = services.relay.provider
        if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
        const workspaceId = await workGraphWorkspaceId(claim.orgId, claim.ownerUserId, claim.jobId)
        const placement = await manager.ensure(workspaceId, {
          homeRegion: services.defaultHomeRegion ?? defaultHomeRegion(),
          labels: {
            workload: "workgraph-source-plan",
            organizationId: claim.orgId,
            ownerUserId: claim.ownerUserId,
            proposalId: claim.proposalId,
          },
          runtimeCwd: "/workspace",
          env: {},
          source: { kind: "empty" },
          exposure: { kind: "relay" },
        })
        if (placement.status !== "ready")
          throw new Error(placement.status === "provisioning" ? "Source planning workspace is provisioning" : (placement.error ?? "Source planning workspace is unavailable"))
        const token = await provider.mintRuntimeAccessToken({
          workspaceId,
          hostId: placement.hostId,
          subject: claim.ownerUserId,
          orgId: claim.orgId,
          role: "owner",
          ttlMs: 10 * 60_000,
        })
        const relay = await provider.getRelayEndpoint(workspaceId, placement.homeRegion as never)
        const runtime = runtimeRequest(request, relay, workspaceId, token.token)
        const requestedSessionId = claim.sessionId ?? `ses_workgraph_${claim.jobId}_${claim.leaseEpoch}`
        sessionId = requestedSessionId
        const reserved = (await client.mutation(api.workgraphBackground.markSourcePlanSession, {
          organization_id: claim.orgId,
          service_token: serviceToken,
          owner_user_id: claim.ownerUserId,
          job_id: claim.jobId,
          lease_epoch: claim.leaseEpoch,
          worker_id: workerId,
          workspace_id: workspaceId,
          session_id: requestedSessionId,
          admission_confirmed: false,
          now: now(),
        })) as { settled?: boolean }
        if (!reserved.settled) return { settled: false }
        const created = await runtime(`/session?harness=${encodeURIComponent(claim.profile.harness)}`, {
          method: "POST",
          body: JSON.stringify({
            id: requestedSessionId,
            agent: claim.profile.agent,
            model: {
              providerID: claim.profile.model.providerId,
              modelID: claim.profile.model.modelId,
            },
            variant: claim.profile.effort,
          }),
        })
        const body = (await created.json()) as { id?: string }
        const adoptedId = body.id
        if (!adoptedId) throw new Error("Hosted source planning Session create response did not include a Session ID")
        if (adoptedId !== requestedSessionId) throw new Error("Hosted source planning Session did not adopt its caller-owned durable identity")
        try {
          await runtime(`/session/${encodeURIComponent(sessionId)}/prompt_async?harness=${encodeURIComponent(claim.profile.harness)}`, {
            method: "POST",
            body: JSON.stringify({
              messageID: `msg_workgraph_${claim.jobId}`,
              parts: [{ type: "text", text: claim.prompt }],
              agent: claim.profile.agent,
              model: {
                providerID: claim.profile.model.providerId,
                modelID: claim.profile.model.modelId,
              },
              variant: claim.profile.effort,
            }),
          })
        } catch (error) {
          if (error instanceof HostedSessionRequestError) throw error
          // A transport failure after prompt admission is indeterminate. Keep the
          // reserved durable identity fenced so the next lease replays the exact
          // same Session and message IDs instead of creating duplicate work.
          return { settled: false, state: "running" }
        }
        const marked = (await client.mutation(api.workgraphBackground.markSourcePlanSession, {
          organization_id: claim.orgId,
          service_token: serviceToken,
          owner_user_id: claim.ownerUserId,
          job_id: claim.jobId,
          lease_epoch: claim.leaseEpoch,
          worker_id: workerId,
          workspace_id: workspaceId,
          session_id: sessionId,
          admission_confirmed: true,
          now: now(),
        })) as { settled?: boolean }
        if (!marked.settled) {
          return { settled: false }
        }
        return { settled: true, state: "running" }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await client.mutation(sessionId ? api.workgraphBackground.failSourcePlan : api.workgraphBackground.retrySourcePlanLaunch, {
          organization_id: claim.orgId,
          service_token: serviceToken,
          owner_user_id: claim.ownerUserId,
          job_id: claim.jobId,
          lease_epoch: claim.leaseEpoch,
          ...(sessionId ? { session_id: sessionId } : { worker_id: workerId }),
          reason,
          now: now(),
        })
        return { settled: false, error: reason }
      }
    }),
  )
  const listed = await tenantRows(client, api.workgraphBackground.listRunningSourcePlans, tenants, {
    service_token: serviceToken,
    limit: 10,
    now: now(),
  })
  const running = listed as RunningSourcePlan[]
  const results = await Promise.all(
    running.map(async (plan) => {
      try {
        const provider = services.relay.provider
        const manager = services.sandbox.sandboxManager
        if (!provider || !manager) throw new Error("Hosted sandbox manager and relay provider are required")
        const placement = await manager.target(plan.workspaceId)
        if (placement.status !== "ready") throw new Error("Hosted source planning workspace is unavailable")
        const token = await provider.mintRuntimeAccessToken({
          workspaceId: plan.workspaceId,
          hostId: placement.hostId,
          subject: plan.ownerUserId,
          orgId: plan.orgId,
          role: "owner",
          ttlMs: 10 * 60_000,
        })
        const relay = await provider.getRelayEndpoint(plan.workspaceId, placement.homeRegion as never)
        const snapshot = await hostedSessionSnapshot(runtimeRequest(request, relay, plan.workspaceId, token.token), plan.sessionId)
        const turn = hostedSessionTurn(snapshot, `msg_workgraph_${plan.jobId}`)
        if (!turn.settled) return { settled: false, state: "running" }
        if (turn.outcome === "failed") throw new Error(turn.error ?? "Source planning Session failed")
        if (turn.outcome === "cancelled") throw new Error(turn.error ?? "Source planning Session was cancelled")
        if (!turn.summary) throw new Error("Source planning Session returned no structured result")
        const parsed = AdmissionAgentPlanSchema.parse(JSON.parse(turn.summary))
        return await client.mutation(api.workgraphBackground.completeSourcePlan, {
          organization_id: plan.orgId,
          service_token: serviceToken,
          owner_user_id: plan.ownerUserId,
          job_id: plan.jobId,
          lease_epoch: plan.leaseEpoch,
          session_id: plan.sessionId,
          plan: parsed,
          now: now(),
        })
      } catch (error) {
        telemetry.queue({
          kind: "source_plan",
          backlog: 1,
          oldestAgeMs: 0,
          failed: 1,
          retried: 0,
          expiredRecoveries: 0,
          activeLeaseAgeMs: plan.activeLeaseAgeMs ?? 0,
        })
        return await client.mutation(api.workgraphBackground.failSourcePlan, {
          organization_id: plan.orgId,
          service_token: serviceToken,
          owner_user_id: plan.ownerUserId,
          job_id: plan.jobId,
          lease_epoch: plan.leaseEpoch,
          session_id: plan.sessionId,
          reason: error instanceof Error ? error.message : String(error),
          now: now(),
        })
      }
    }),
  )
  recordQueueTelemetry(telemetry, "source_plan", claims, running, [...launched, ...results])
  recordWorkspaceLaunchTelemetry(telemetry, launched)
  return { launched, results }
}

function runtimeRequest(request: RuntimeFetch, relay: string, workspaceId: string, token: string) {
  return async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${token}`)
    headers.set("x-opencode-directory", "/workspace")
    if (init?.body) headers.set("content-type", "application/json")
    const response = await request(`${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}${path}`, { ...init, headers })
    if (response.ok) return response
    throw new HostedSessionRequestError(response.status, await response.text(), {
      method: init?.method ?? "GET",
      path,
    })
  }
}

// The status and body alone are not diagnosable: this reason is what a parked
// Run carries, and every hosted call funnels through here, so a bare "404" left
// the operator guessing which of a dozen paths the runtime rejected.
class HostedSessionRequestError extends Error {
  constructor(
    readonly status: number,
    body: string,
    route?: { method: string; path: string },
  ) {
    super(`Hosted Session request failed: ${route ? `${route.method} ${route.path} → ` : ""}${status} ${body}`)
  }
}

class HostedSettlementTransportError extends Error {
  readonly retryable = true
}

export function hostedSettlementFailureDisposition(error: unknown): "park" | "fail" {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status >= 500 ? "park" : "fail"
  }
  if (error instanceof TypeError || error instanceof HostedSettlementTransportError) return "park"
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "park"
  if (error && typeof error === "object" && "retryable" in error && error.retryable === true) return "park"
  return "fail"
}

type RunningRun = {
  ownerUserId: string
  orgId: string
  runId: string
  leaseEpoch: number
  sessionId: string
  workspaceId: string
  completionRetry?: { terminalSeq: number; requestedAt: number }
  activeLeaseAgeMs?: number
  expiredRecovery?: boolean
}

function mutationArgs(claim: Claim, serviceToken: string, workerId: string, extra: Record<string, unknown>) {
  return {
    service_token: serviceToken,
    organization_id: claim.orgId,
    owner_user_id: claim.ownerUserId,
    outbox_id: claim.outboxId,
    run_id: claim.runId,
    lease_epoch: claim.leaseEpoch,
    worker_id: workerId,
    ...extra,
  }
}

function resultArgs(run: RunningRun, serviceToken: string, extra: Record<string, unknown>) {
  return {
    service_token: serviceToken,
    organization_id: run.orgId,
    owner_user_id: run.ownerUserId,
    run_id: run.runId,
    lease_epoch: run.leaseEpoch,
    session_id: run.sessionId,
    ...extra,
  }
}

function tenantResults(client: Executor, mutation: Mutation, tenants: readonly WorkerTenant[], args: Record<string, unknown>) {
  return Promise.all(
    tenants.map((tenant) =>
      client.mutation(mutation, {
        ...args,
        organization_id: tenant.organizationId,
        owner_user_id: tenant.ownerUserId,
      }),
    ),
  )
}

class SweepSubrequestBudgetExhausted extends Error {}

type SweepSubrequestBudget = Readonly<{
  remaining: number
  run: <Result>(operation: () => Promise<Result>) => Promise<Result>
}>

function createSweepSubrequestBudget(): SweepSubrequestBudget {
  let remaining = SWEEP_SUBREQUEST_BUDGET
  return {
    get remaining() {
      return remaining
    },
    run(operation) {
      if (remaining === 0) throw new SweepSubrequestBudgetExhausted()
      remaining -= 1
      return operation()
    },
  }
}

function budgetExecutor(client: RuntimeExecutor, budget: SweepSubrequestBudget): RuntimeExecutor {
  return {
    mutation: (fn, args) => budget.run(() => client.mutation(fn, args)),
    query: (fn, args) => budget.run(() => client.query(fn, args)),
  }
}

function budgetServices(services: ControlPlaneServices, budget: SweepSubrequestBudget): ControlPlaneServices {
  const manager = services.sandbox?.sandboxManager
  const provider = services.relay?.provider
  return {
    ...services,
    sandbox: {
      ...services.sandbox,
      ...(manager ? { sandboxManager: budgetObject(manager, budget) } : {}),
    },
    relay: {
      ...services.relay,
      ...(provider ? { provider: budgetObject(provider, budget) } : {}),
    },
  }
}

function budgetObject<Value extends object>(value: Value, budget: SweepSubrequestBudget): Value {
  return new Proxy(value, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver)
      if (typeof member !== "function") return member
      return (...args: unknown[]) => budget.run(() => Promise.resolve(Reflect.apply(member, target, args)))
    },
  })
}

async function tenantRows(client: Executor, mutation: Mutation, tenants: readonly WorkerTenant[], args: Record<string, unknown>) {
  const results = await tenantResults(client, mutation, tenants, args)
  if (results.some((result) => !Array.isArray(result))) {
    throw new Error("Tenant WorkGraph worker mutation returned an invalid result")
  }
  return results.flat()
}

function recordRunTelemetry(
  telemetry: WorkGraphOperationalReporter,
  trigger: WorkGraphReconciliationTrigger,
  claims: readonly Claim[],
  running: readonly RunningRun[],
  launched: readonly unknown[],
  results: readonly unknown[],
  latencyMs: number,
) {
  const observations = [...launched, ...results]
  recordQueueTelemetry(telemetry, "run", claims, running, observations)
  telemetry.reconciliation({
    trigger,
    outcome: "succeeded",
    latencyMs,
    lagMs: maxNumber(claims, "queueLagMs"),
    claimed: claims.length,
    running: running.length,
    settled: observations.filter((value) => record(value)?.settled === true).length,
    failed: failureCount(observations),
  })
  const runningCount = launched.filter((value) => record(value)?.state === "running").length
  const cancelledCount = launched.filter((value) => record(value)?.state === "cancelled").length
  const failed = failureCount(launched)
  const pending = Math.max(0, launched.length - runningCount - cancelledCount - failed)
  if (runningCount) {
    telemetry.workspace({ operation: "provision", outcome: "succeeded", count: runningCount })
    telemetry.workspace({ operation: "launch", outcome: "succeeded", count: runningCount })
  }
  if (pending) telemetry.workspace({ operation: "provision", outcome: "pending", count: pending })
  if (cancelledCount) telemetry.workspace({ operation: "cancel", outcome: "rejected", count: cancelledCount })
  if (failed) telemetry.workspace({ operation: "launch", outcome: "failed", count: failed })
}

function recordQueueTelemetry(
  telemetry: WorkGraphOperationalReporter,
  kind: "run" | "source_plan",
  claims: readonly unknown[],
  running: readonly unknown[],
  observations: readonly unknown[],
) {
  telemetry.queue({
    kind,
    backlog: claims.length + running.length,
    oldestAgeMs: maxNumber(claims, "queueLagMs"),
    failed: failureCount(observations),
    retried: claims.filter((value) => (numberProperty(value, "retryCount") ?? 0) > 0).length,
    expiredRecoveries: [...claims, ...running].filter((value) => record(value)?.expiredRecovery === true).length,
    activeLeaseAgeMs: Math.max(maxNumber(claims, "activeLeaseAgeMs"), maxNumber(running, "activeLeaseAgeMs")),
  })
}

function recordWorkspaceLaunchTelemetry(telemetry: WorkGraphOperationalReporter, launched: readonly unknown[]) {
  const running = launched.filter((value) => record(value)?.state === "running").length
  const failed = failureCount(launched)
  const pending = Math.max(0, launched.length - running - failed)
  if (running) {
    telemetry.workspace({ operation: "provision", outcome: "succeeded", count: running })
    telemetry.workspace({ operation: "launch", outcome: "succeeded", count: running })
  }
  if (pending) telemetry.workspace({ operation: "provision", outcome: "pending", count: pending })
  if (failed) telemetry.workspace({ operation: "launch", outcome: "failed", count: failed })
}

function failureCount(values: readonly unknown[]) {
  return values.filter((value) => {
    const item = record(value)
    return !!item?.error || item?.outcome === "failed" || item?.status === "failed"
  }).length
}

function maxNumber(values: readonly unknown[], key: string) {
  return values.reduce<number>((maximum, value) => Math.max(maximum, numberProperty(value, key) ?? 0), 0)
}

function numberProperty(value: unknown, key: string) {
  const item = record(value)
  return typeof item?.[key] === "number" && Number.isFinite(item[key]) ? (item[key] as number) : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export async function workGraphWorkspaceId(organizationId: string, ownerUserId: string, scopeId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([organizationId, ownerUserId, scopeId])))
  return `wg-${Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

class HostedSessionSnapshotError extends Error {
  readonly code = "session_snapshot_invalid"

  constructor(message = "Hosted Session snapshot was invalid") {
    super(message)
  }
}

function sessionString(value: unknown) {
  return typeof value === "string" ? clean(value) : undefined
}

type HostedSessionSnapshot = Readonly<{
  session: Record<string, unknown>
  messages: unknown[]
  maxEventOrdinal: number
}>

async function hostedSessionSnapshot(
  runtime: (path: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
): Promise<HostedSessionSnapshot> {
  const encoded = encodeURIComponent(sessionId)
  const [sessionResponse, messageResponse] = await Promise.all([
    runtime(`/session/${encoded}`),
    runtime(`/session/${encoded}/message?snapshot=1`),
  ])
  const session = record(await sessionResponse.json())
  if (!session || sessionString(session.id) !== sessionId) {
    throw new HostedSessionSnapshotError("Hosted Session response did not match the requested Session")
  }
  const envelope = record(await messageResponse.json())
  const messages = envelope?.messages
  const maxEventOrdinal = envelope?.maxEventOrdinal
  if (
    !Array.isArray(messages)
    || typeof maxEventOrdinal !== "number"
    || !Number.isSafeInteger(maxEventOrdinal)
    || maxEventOrdinal < 0
  ) {
    throw new HostedSessionSnapshotError()
  }
  return { session, messages, maxEventOrdinal }
}

function hostedSessionTurn(
  snapshot: HostedSessionSnapshot,
  userMessageId: string,
  afterOrdinal = -1,
):
  | Readonly<{ settled: false }>
  | Readonly<{
      settled: true
      outcome: "completed" | "failed" | "cancelled"
      summary?: string
      error?: string
      toolCalls: string[]
    }> {
  if (snapshot.maxEventOrdinal <= afterOrdinal) return { settled: false }
  const status = sessionString(snapshot.session.status)
  if (status === "busy" || status === "recovering" || status === "retry") return { settled: false }
  const lastTurn = record(snapshot.session.lastTurn)
  const outcome = sessionString(lastTurn?.status)
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") return { settled: false }
  const userIndex = snapshot.messages.findIndex((message) => sessionString(record(record(message)?.info)?.id) === userMessageId)
  const assistantMessageId = sessionString(lastTurn?.assistantMessageId)
  if (userIndex < 0 || !assistantMessageId) return { settled: false }
  const assistantIndex = snapshot.messages.findIndex(
    (message, index) =>
      index > userIndex
      && sessionString(record(record(message)?.info)?.id) === assistantMessageId
      && sessionString(record(record(message)?.info)?.role) === "assistant",
  )
  if (assistantIndex < 0) return { settled: false }
  const turnMessages = snapshot.messages.slice(userIndex + 1, assistantIndex + 1)
  const summary = turnMessages.flatMap((message) => {
    const parts = record(message)?.parts
    if (!Array.isArray(parts)) return []
    return parts.flatMap((part) => {
      const value = record(part)
      return value?.type === "text" && sessionString(value.text) ? [sessionString(value.text)!] : []
    })
  }).join("\n").trim().slice(0, 10_000) || undefined
  const toolCalls = [...new Set(turnMessages.flatMap((message) => {
    const parts = record(message)?.parts
    if (!Array.isArray(parts)) return []
    return parts.flatMap((part) => {
      const value = record(part)
      const type = sessionString(value?.type)
      const name = sessionString(value?.tool) ?? sessionString(value?.name) ?? sessionString(value?.toolName)
      return type?.includes("tool") && name ? [name] : []
    })
  }))].slice(0, 100)
  return {
    settled: true,
    outcome,
    ...(summary ? { summary } : {}),
    ...(
      outcome === "failed"
        ? { error: sessionString(lastTurn?.error) ?? "Hosted Session failed" }
        : outcome === "cancelled"
          ? { error: sessionString(lastTurn?.reason) ?? "Hosted Session was cancelled" }
          : {}
    ),
    toolCalls,
  }
}

function hostedSessionMessages(value: unknown) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hosted Session transcript was invalid")
  const messages = (value as Record<string, unknown>).messages
  if (!Array.isArray(messages)) throw new Error("Hosted Session transcript was invalid")
  return messages
}

export class HostedTranscriptRetentionError extends Error {
  readonly code = "run_transcript_not_retained"
  readonly retryable = true

  constructor(message: string) {
    super(message)
    this.name = "HostedTranscriptRetentionError"
  }
}

/**
 * Durable transcript retention for hosted Run completion: pull the Session
 * transcript from the workspace runtime and sync it into the authority BEFORE
 * complete_run is accepted. Any failure — unavailable workspace, failed
 * pull, or a transcript without both user and assistant messages — is a
 * retryable HostedTranscriptRetentionError, so the Run stays incomplete
 * instead of settling without a durable transcript.
 *
 * The caller (the run-operation broker) only holds the runtime token's
 * Clerk subject, so the sync goes through the subject-resolving retention
 * mutation rather than the internal-id session publisher.
 */
export function createHostedSessionTranscriptRetention(
  env: HostedWorkerEnv,
  services: ControlPlaneServices,
  options: {
    fetch?: RuntimeFetch
    now?: () => number
    executor?: Executor
  } = {},
) {
  const url = clean(env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!serviceToken || (!url && !options.executor)) return
  const client = options.executor ?? createWorkGraphConvexExecutor(url!)
  const provider = services.relay.provider
  const manager = services.sandbox.sandboxManager
  if (!provider || !manager) return
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  return async (input: { organizationId: string; ownerSubject: string; workspaceId: string; sessionId: string }) => {
    try {
      const placement = await manager.target(input.workspaceId)
      if (placement.status !== "ready") throw new Error("Hosted workspace is unavailable for transcript retention")
      const token = await provider.mintRuntimeAccessToken({
        workspaceId: input.workspaceId,
        hostId: placement.hostId,
        subject: input.ownerSubject,
        orgId: input.organizationId,
        role: "owner",
        ttlMs: 10 * 60_000,
      })
      const relay = await provider.getRelayEndpoint(input.workspaceId, placement.homeRegion as never)
      const snapshot = await request(
        `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(input.workspaceId)}/session/${encodeURIComponent(input.sessionId)}/message?snapshot=1`,
        {
          headers: { authorization: `Bearer ${token.token}`, "x-opencode-directory": "/workspace" },
        },
      )
      if (!snapshot.ok) {
        throw new Error(`Hosted Session transcript failed: ${snapshot.status} ${await snapshot.text()}`)
      }
      const messages = hostedSessionMessages(await snapshot.json())
      const roles = new Set(messages.map(messageRole))
      if (!roles.has("user") || !roles.has("assistant")) {
        throw new Error("Hosted Session transcript does not contain both user and assistant messages")
      }
      await client.mutation(api.sessions.retainWorkGraphSessionTranscript, {
        service_token: serviceToken,
        organization_id: input.organizationId,
        owner_subject: input.ownerSubject,
        workspace_id: input.workspaceId,
        session_id: input.sessionId,
        updated_at: now(),
        messages,
      })
    } catch (error) {
      throw new HostedTranscriptRetentionError(error instanceof Error ? error.message : String(error))
    }
  }
}

function messageRole(message: unknown) {
  const info = record(record(message)?.info)
  return typeof info?.role === "string" ? info.role : undefined
}

function convexSessionPublisher(url: string, serviceToken: string): HostedSessionPublisher {
  const client = new ConvexHttpClient(url)
  return {
    launch: async (input) => {
      await client.mutation(api.workspaces.ensureWorkGraph, {
        service_token: serviceToken,
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        workspace_id: input.workspaceId,
        display_name: `WorkGraph · ${input.title}`,
        ...(input.repoUrl ? { repo_url: input.repoUrl, repo_name: repositoryName(input.repoUrl) } : {}),
        ...(input.branch ? { git_branch: input.branch } : {}),
        ...(input.homeRegion ? { home_region: input.homeRegion } : {}),
      })
      await client.mutation(api.sessions.syncWorkGraphSession, {
        service_token: serviceToken,
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        workspace_id: input.workspaceId,
        session_id: input.sessionId,
        title: input.title,
        created_at: input.now,
        updated_at: input.now,
        messages: [],
      })
    },
    snapshot: async (input) => {
      await client.mutation(api.workspaces.ensureWorkGraph, {
        service_token: serviceToken,
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        workspace_id: input.workspaceId,
      })
      await client.mutation(api.sessions.syncWorkGraphSession, {
        service_token: serviceToken,
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        workspace_id: input.workspaceId,
        session_id: input.sessionId,
        updated_at: input.now,
        messages: input.messages,
      })
    },
  }
}

function repositoryName(repoUrl: string) {
  const name = new URL(repoUrl).pathname
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/, "")
  return name || "WorkGraph"
}
