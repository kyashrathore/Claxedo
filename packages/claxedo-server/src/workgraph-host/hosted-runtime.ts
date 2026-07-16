import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { defaultHomeRegion } from "../region"
import type { ControlPlaneServices } from "../control-plane/services"
import { AdmissionAgentPlanSchema, WorkGraphAttemptToolNames } from "@claxedo/workgraph/contracts"
import { clean, type HostedWorkerEnv } from "../control-plane/adapters/worker/hosted-compose"
import { createWorkGraphOperationalReporter, type WorkGraphOperationalReporter } from "./operational-telemetry"

type Mutation = FunctionReference<"mutation">
const api = anyApi as unknown as {
  sessions: {
    syncWorkGraphSession: Mutation
  }
  workspaces: {
    ensureWorkGraph: Mutation
  }
  workgraphRuntime: {
    listWorkerTenants: Mutation
    claimLaunches: Mutation
    markRunning: Mutation
    retryLaunch: Mutation
    recordResult: Mutation
    listRunning: Mutation
    recordFailure: Mutation
    markAttention: Mutation
    claimControlEffects: Mutation
    completeControlEffect: Mutation
    confirmLaunch: Mutation
    settleRejectedProvision: Mutation
    compensateRejectedLaunch: Mutation
  }
  workgraphBackground: {
    drainSessionIntake: Mutation
    claimRecaps: Mutation
    markRecapSession: Mutation
    retryRecapLaunch: Mutation
    listRunningRecaps: Mutation
    completeRecap: Mutation
    failRecap: Mutation
    claimSourcePlans: Mutation
    markSourcePlanSession: Mutation
    retrySourcePlanLaunch: Mutation
    listRunningSourcePlans: Mutation
    completeSourcePlan: Mutation
    failSourcePlan: Mutation
  }
  workgraphConnections: {
    bindAttemptConnections: Mutation
  }
}

type Claim = {
  ownerUserId: string
  orgId: string
  outboxId: string
  attemptId: string
  streamId: string
  workItemId: string
  leaseEpoch: number
  queueLagMs?: number
  activeLeaseAgeMs?: number
  expiredRecovery?: boolean
  retryCount?: number
  title: string
  prompt: string
  profile: {
    environment: { kind: "hosted_workspace"; repositoryUrl?: string; presetId?: string }
    repository?: { remoteUrl?: string; baseRevision: string }
    harness: string
    agent: string
    model: { providerId: string; modelId: string }
    effort: string
    tools: string[]
    connectionIds: string[]
  }
}

type Executor = { mutation: (fn: Mutation, args: Record<string, unknown>) => Promise<unknown> }
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
  snapshot: (input: {
    organizationId: string
    ownerUserId: string
    workspaceId: string
    sessionId: string
    messages: unknown[]
    now: number
  }) => Promise<void>
}
type RecapClaim = {
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
  profile: { agent: string; model: { providerId: string; modelId: string }; effort: string; tools: string[] }
}
type RunningRecap = {
  ownerUserId: string
  orgId: string
  jobId: string
  leaseEpoch: number
  sessionId: string
  workspaceId: string
  activeLeaseAgeMs?: number
  expiredRecovery?: boolean
}
type SourcePlanClaim = Omit<RecapClaim, "streamId"> & { proposalId: string; sessionId?: string }
type RunningSourcePlan = RunningRecap
type WorkerTenant = { organizationId: string; ownerUserId: string }

/** Durable Worker dispatcher over SandboxManager → authenticated relay → Session V2. */
export function createHostedWorkGraphRuntime(
  env: HostedWorkerEnv,
  services: ControlPlaneServices,
  options: {
    executor?: Executor
    fetch?: RuntimeFetch
    now?: () => number
    background?: boolean
    sessionPublisher?: HostedSessionPublisher
  } = {},
) {
  const url = clean(env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!url || !serviceToken) return
  const client = options.executor ?? convexExecutor(url)
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const workerId = clean(env.CLAXEDO_WORKGRAPH_WORKER_ID) ?? "claxedo-worker"
  const telemetry = createWorkGraphOperationalReporter({ telemetry: services.telemetry, env, now })
  const sessionPublisher =
    options.sessionPublisher ?? (options.executor ? undefined : convexSessionPublisher(url, serviceToken))
  return {
    reconcile: async (run: { background?: boolean } = {}) => {
      const claimedAt = now()
      try {
        const tenants = (await client.mutation(api.workgraphRuntime.listWorkerTenants, {
          service_token: serviceToken,
          limit: 500,
        })) as WorkerTenant[]
        const claims = (await tenantRows(client, api.workgraphRuntime.claimLaunches, tenants, {
          service_token: serviceToken,
          worker_id: workerId,
          now: claimedAt,
          limit: 10,
        })) as Claim[]
        const launched = await Promise.all(
          claims.map(async (claim) => {
            let compensationTarget: { sessionId: string; workspaceId: string } | undefined
            try {
              const connectionTools = claim.profile.tools.filter(
                (tool) =>
                  tool === "connection_work_source_list" ||
                  tool === "connection_work_source_comment" ||
                  tool === "connection_work_source_update",
              )
              const brokerUrl =
                clean(env.CLAXEDO_PUBLIC_URL) ?? clean(env.CLAXEDO_SERVER_URL) ?? clean(env.CLAXEDO_CENTRAL_URL)
              const brokerOrigin = brokerUrl ? new URL(brokerUrl).origin : undefined
              if (claim.profile.connectionIds.length > 0 && (!connectionTools.length || !brokerUrl)) {
                throw new Error("Connection-bound Attempts require explicit Connection tools and a central broker URL")
              }
              if (!brokerUrl) throw new Error("Hosted Attempts require a central broker URL")
              const manager = services.sandbox.sandboxManager
              const provider = services.relay.provider
              if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
              const workspaceId = await workGraphWorkspaceId(claim.orgId, claim.ownerUserId, claim.streamId)
              const placement = await manager.ensure(workspaceId, {
                homeRegion: services.defaultHomeRegion ?? defaultHomeRegion(),
                labels: {
                  workload: "workgraph",
                  organizationId: claim.orgId,
                  ownerUserId: claim.ownerUserId,
                  streamId: claim.streamId,
                },
                runtimeCwd: "/workspace",
                env: {
                  WORKSPACE_RUNTIME_RUNNER: claim.profile.harness,
                  ...(brokerOrigin ? { WORKSPACE_RUNTIME_WORKGRAPH_BROKER_ORIGIN: brokerOrigin } : {}),
                },
                source:
                  claim.profile.environment.kind === "hosted_workspace" && claim.profile.environment.repositoryUrl
                    ? {
                        kind: "git",
                        repoUrl: claim.profile.environment.repositoryUrl,
                        branch: claim.profile.repository?.baseRevision ?? "HEAD",
                      }
                    : claim.profile.repository?.remoteUrl
                      ? {
                          kind: "git",
                          repoUrl: claim.profile.repository.remoteUrl,
                          branch: claim.profile.repository.baseRevision,
                        }
                      : { kind: "empty" },
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
                subject: claim.ownerUserId,
                orgId: claim.orgId,
                role: "owner",
                ttlMs: 10 * 60_000,
              })
              const relay = await provider.getRelayEndpoint(workspaceId, placement.homeRegion as never)
              const runtime = async (path: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers)
                headers.set("authorization", `Bearer ${token.token}`)
                headers.set("x-opencode-directory", "/workspace")
                if (init?.body) headers.set("content-type", "application/json")
                const response = await request(
                  `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}${path}`,
                  { ...init, headers },
                )
                if (response.ok) return response
                throw new Error(`Hosted Session V2 request failed: ${response.status} ${await response.text()}`)
              }
              const confirmed = (await client.mutation(
                api.workgraphRuntime.confirmLaunch,
                mutationArgs(claim, serviceToken, workerId, { now: now() }),
              )) as { accepted?: boolean }
              if (!confirmed.accepted) {
                const destroyed = await manager.destroy(workspaceId)
                if (!destroyed.ok && destroyed.reason !== "runtime_lease_missing") {
                  throw new Error(`Hosted WorkGraph rejected launch cleanup failed: ${destroyed.reason}`)
                }
                if (destroyed.ok) await manager.release(workspaceId)
                await client.mutation(
                  api.workgraphRuntime.settleRejectedProvision,
                  mutationArgs(claim, serviceToken, workerId, { now: now() }),
                )
                return { settled: false, state: "cancelled" }
              }
              const created = await runtime("/api/session", {
                method: "POST",
                body: JSON.stringify({
                  agent: claim.profile.agent,
                  model: {
                    providerID: claim.profile.model.providerId,
                    id: claim.profile.model.modelId,
                    variant: claim.profile.effort,
                  },
                  tools: [...new Set([...claim.profile.tools, ...WorkGraphAttemptToolNames])],
                  location: { directory: "/workspace" },
                }),
              })
              const createdBody = (await created.json()) as { id?: string; data?: { id?: string } }
              const sessionId = createdBody.id ?? createdBody.data?.id
              if (!sessionId) throw new Error("Hosted Session V2 create response did not include a Session ID")
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
                  attempt_id: claim.attemptId,
                  worker_id: workerId,
                  session_id: sessionId,
                  workspace_id: workspaceId,
                  now: now(),
                })) as { settled?: boolean }
                if (!compensation.settled)
                  throw new Error("Durable launch compensation was rejected after the final launch fence")
                return { settled: false, state: "compensating" }
              }
              await sessionPublisher?.launch({
                organizationId: claim.orgId,
                ownerUserId: claim.ownerUserId,
                workspaceId,
                sessionId,
                title: claim.title,
                ...(claim.profile.environment.repositoryUrl
                  ? { repoUrl: claim.profile.environment.repositoryUrl }
                  : claim.profile.repository?.remoteUrl
                    ? { repoUrl: claim.profile.repository.remoteUrl }
                    : {}),
                ...(claim.profile.repository?.baseRevision ? { branch: claim.profile.repository.baseRevision } : {}),
                homeRegion: placement.homeRegion,
                now: now(),
              })
              await runtime("/api/workgraph/attempt-binding", {
                method: "POST",
                body: JSON.stringify({
                  version: 1,
                  identity: {
                    attemptId: claim.attemptId,
                    sessionId,
                    workspaceId,
                    leaseEpoch: claim.leaseEpoch,
                  },
                  brokerUrl,
                }),
              })
              if (claim.profile.connectionIds.length > 0) {
                await client.mutation(api.workgraphConnections.bindAttemptConnections, {
                  service_token: serviceToken,
                  ownerUserId: claim.ownerUserId,
                  orgId: claim.orgId,
                  attemptId: claim.attemptId,
                  sessionId,
                  workspaceId,
                  connectionIds: claim.profile.connectionIds,
                  tools: connectionTools,
                })
                await runtime("/api/workgraph/connection-binding", {
                  method: "POST",
                  body: JSON.stringify({
                    version: 1,
                    identity: { attemptId: claim.attemptId, sessionId, workspaceId },
                    connectionIds: claim.profile.connectionIds,
                    tools: connectionTools,
                    brokerUrl,
                  }),
                })
              }
              await runtime(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
                method: "POST",
                body: JSON.stringify({
                  id: `msg_workgraph_${claim.attemptId}`,
                  prompt: { text: managedAttemptPrompt(claim.prompt) },
                  delivery: "steer",
                  resume: true,
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
                  attempt_id: claim.attemptId,
                  worker_id: workerId,
                  session_id: compensationTarget.sessionId,
                  workspace_id: compensationTarget.workspaceId,
                  now: now(),
                })) as { settled?: boolean }
                if (!compensation.settled) throw new Error(`${reason}; durable launch compensation was rejected`)
                return { settled: false, state: "compensating", reason }
              }
              return await client.mutation(
                api.workgraphRuntime.markAttention,
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
        })) as RunningAttempt[]
        const results = await Promise.all(
          running.map(async (attempt) => {
            try {
              const provider = services.relay.provider
              const manager = services.sandbox.sandboxManager
              if (!provider || !manager) throw new Error("Hosted sandbox manager and relay provider are required")
              const placement = await manager.target(attempt.workspaceId)
              if (placement.status !== "ready")
                throw new Error("Hosted workspace is unavailable during result reconciliation")
              const token = await provider.mintRuntimeAccessToken({
                workspaceId: attempt.workspaceId,
                hostId: placement.hostId,
                subject: attempt.ownerUserId,
                orgId: attempt.orgId,
                role: "owner",
                ttlMs: 10 * 60_000,
              })
              const relay = await provider.getRelayEndpoint(attempt.workspaceId, placement.homeRegion as never)
              const events: SessionEvent[] = []
              let after = 0
              for (;;) {
                const history = await request(
                  `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(attempt.workspaceId)}/api/session/${encodeURIComponent(attempt.sessionId)}/history?limit=100&after=${after}`,
                  {
                    headers: { authorization: `Bearer ${token.token}`, "x-opencode-directory": "/workspace" },
                  },
                )
                if (!history.ok) {
                  throw new Error(`Hosted Session V2 history failed: ${history.status} ${await history.text()}`)
                }
                const page = hostedSessionHistoryPage(await history.json())
                events.push(...page.data)
                if (!page.hasMore) break
                const next = page.data.at(-1)?.durable?.seq
                if (next === undefined || next <= after) throw new SessionHistoryResponseError()
                after = next
              }
              const terminal = events.findLast(
                (event) =>
                  event.type.startsWith("session.next.step.ended") || event.type.startsWith("session.next.step.failed"),
              )
              if (sessionPublisher) {
                const snapshot = await request(
                  `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(attempt.workspaceId)}/session/${encodeURIComponent(attempt.sessionId)}/message?snapshot=1`,
                  {
                    headers: { authorization: `Bearer ${token.token}`, "x-opencode-directory": "/workspace" },
                  },
                )
                if (!snapshot.ok) {
                  throw new Error(`Hosted Session transcript failed: ${snapshot.status} ${await snapshot.text()}`)
                }
                await sessionPublisher.snapshot({
                  organizationId: attempt.orgId,
                  ownerUserId: attempt.ownerUserId,
                  workspaceId: attempt.workspaceId,
                  sessionId: attempt.sessionId,
                  messages: hostedSessionMessages(await snapshot.json()),
                  now: now(),
                })
              }
              if (!terminal) return { settled: false, state: "running" }
              const [connectionCleanup, attemptCleanup] = await Promise.all([
                request(
                  `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(attempt.workspaceId)}/api/workgraph/connection-binding/${encodeURIComponent(attempt.sessionId)}`,
                  {
                    method: "DELETE",
                    headers: { authorization: `Bearer ${token.token}`, "x-opencode-directory": "/workspace" },
                  },
                ),
                request(
                  `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(attempt.workspaceId)}/api/workgraph/attempt-binding/${encodeURIComponent(attempt.sessionId)}`,
                  {
                    method: "DELETE",
                    headers: { authorization: `Bearer ${token.token}`, "x-opencode-directory": "/workspace" },
                  },
                ),
              ])
              if (!connectionCleanup.ok) {
                throw new Error(
                  `Hosted Session Connection cleanup failed: ${connectionCleanup.status} ${await connectionCleanup.text()}`,
                )
              }
              if (!attemptCleanup.ok) {
                throw new Error(
                  `Hosted Session Attempt cleanup failed: ${attemptCleanup.status} ${await attemptCleanup.text()}`,
                )
              }
              if (terminal.type.startsWith("session.next.step.failed")) {
                return await client.mutation(
                  api.workgraphRuntime.recordFailure,
                  resultArgs(attempt, serviceToken, {
                    reason: sessionError(terminal.data.error),
                    now: now(),
                  }),
                )
              }
              const summary = events.findLast((event) => event.type.startsWith("session.next.text.ended"))?.data.text
              if (typeof summary !== "string" || !summary.trim()) throw new Error("session_output_missing")
              const files = Array.isArray(terminal.data.files)
                ? terminal.data.files.filter((file): file is string => typeof file === "string" && !!file.trim())
                : []
              return {
                settled: false,
                state: "awaiting_explicit_completion",
                summary: summary.trim(),
                artifacts: files.map((file) => `file:${file.trim()}`),
              }
            } catch (error) {
              return await client.mutation(
                api.workgraphRuntime.recordFailure,
                resultArgs(attempt, serviceToken, {
                  reason: error instanceof Error ? error.message : String(error),
                  now: now(),
                }),
              )
            }
          }),
        )
        const background =
          options.background === false || run.background === false
            ? undefined
            : await reconcileBackground(client, services, request, serviceToken, workerId, now, tenants, telemetry)
        recordAttemptTelemetry(telemetry, claims, running, launched, results, now() - claimedAt)
        return { launched, results, ...(background ? { background } : {}) }
      } catch (error) {
        telemetry.reconciliation({
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

function managedAttemptPrompt(prompt: string) {
  return [
    prompt,
    "",
    "WorkGraph execution protocol:",
    "Before your final response, call workgraph_complete_task with a concise summary and evidence for every completion requirement.",
    "Each evidence entry must identify its requirementId. A text response without this tool call does not complete the Attempt.",
    "Use the exact input shape {\"summary\":\"...\",\"artifacts\":[],\"evidence\":[{\"requirementId\":\"<requirement id>\",\"evidence\":{\"kind\":\"test_result\",\"summary\":\"...\",\"passed\":true}}]} (select the appropriate supported evidence kind for the requirement).",
    "Use workgraph_report_progress only for meaningful intermediate boundaries.",
  ].join("\n")
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
    effectType: "interrupt_attempt" | "finalize_stream" | "cleanup_stream"
    payload: { finalize?: "close" | "delete" | "replace"; sessionId?: string; sessions?: string[] }
  }>
  const controlResults = await Promise.all(
    controls.map(async (control) => {
      const startedAt = now()
      const operation =
        control.effectType === "interrupt_attempt"
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
        const workspaceId = await workGraphWorkspaceId(control.orgId, control.ownerUserId, control.streamId)
        const placement = await manager.target(workspaceId)
        if (control.effectType === "interrupt_attempt" && placement.status !== "ready") {
          throw new Error("Attempt Session placement is not ready for interruption")
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
          const sessions =
            control.effectType === "interrupt_attempt"
              ? control.payload.sessionId
                ? [control.payload.sessionId]
                : []
              : (control.payload.sessions ?? [])
          await Promise.all(
            sessions.map((sessionId) =>
              runtime(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" }),
            ),
          )
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
  const claims = (await tenantRows(client, api.workgraphBackground.claimRecaps, tenants, {
    service_token: serviceToken,
    worker_id: workerId,
    now: now(),
    limit: 10,
  })) as RecapClaim[]
  const launched = await Promise.all(
    claims.map(async (claim) => {
      let sessionId: string | undefined
      try {
        const manager = services.sandbox.sandboxManager
        const provider = services.relay.provider
        if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
        const workspaceId = await workGraphWorkspaceId(claim.orgId, claim.ownerUserId, claim.streamId)
        const placement = await manager.ensure(workspaceId, {
          homeRegion: services.defaultHomeRegion ?? defaultHomeRegion(),
          labels: {
            workload: "workgraph-recap",
            organizationId: claim.orgId,
            ownerUserId: claim.ownerUserId,
            streamId: claim.streamId,
          },
          runtimeCwd: "/workspace",
          env: {},
          source: { kind: "empty" },
          exposure: { kind: "relay" },
        })
        if (placement.status !== "ready") {
          throw new Error(
            placement.status === "provisioning"
              ? "Recap workspace is provisioning"
              : (placement.error ?? "Recap workspace is unavailable"),
          )
        }
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
        const requestedSessionId = claim.sessionId ?? `ses_workgraph_recap_${claim.jobId}_${claim.leaseEpoch}`
        sessionId = requestedSessionId
        const reserved = (await client.mutation(api.workgraphBackground.markRecapSession, {
          service_token: serviceToken,
          organization_id: claim.orgId,
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
        let created: Response
        try {
          created = await runtime("/api/session", {
            method: "POST",
            body: JSON.stringify({
              id: requestedSessionId,
              agent: claim.profile.agent,
              model: {
                providerID: claim.profile.model.providerId,
                id: claim.profile.model.modelId,
                variant: claim.profile.effort,
              },
              tools: claim.profile.tools,
              location: { directory: "/workspace" },
            }),
          })
        } catch (error) {
          if (error instanceof HostedSessionRequestError) throw error
          return { settled: false, state: "running" }
        }
        const body = (await created.json()) as { id?: string; data?: { id?: string } }
        const adoptedId = body.id ?? body.data?.id
        if (!adoptedId) throw new Error("Hosted recap Session create response did not include a Session ID")
        if (adoptedId !== requestedSessionId)
          throw new Error("Hosted recap Session did not adopt its caller-owned durable identity")
        try {
          await runtime(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
            method: "POST",
            body: JSON.stringify({
              id: `msg_recap_${claim.jobId}`,
              prompt: { text: claim.prompt },
              delivery: "steer",
              resume: true,
            }),
          })
        } catch (error) {
          if (error instanceof HostedSessionRequestError) throw error
          return { settled: false, state: "running" }
        }
        const marked = (await client.mutation(api.workgraphBackground.markRecapSession, {
          service_token: serviceToken,
          organization_id: claim.orgId,
          owner_user_id: claim.ownerUserId,
          job_id: claim.jobId,
          lease_epoch: claim.leaseEpoch,
          worker_id: workerId,
          workspace_id: workspaceId,
          session_id: sessionId,
          admission_confirmed: true,
          now: now(),
        })) as { settled?: boolean }
        if (!marked.settled) return { settled: false }
        return { settled: true, state: "running" }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (sessionId) {
          await client.mutation(api.workgraphBackground.failRecap, {
            service_token: serviceToken,
            organization_id: claim.orgId,
            owner_user_id: claim.ownerUserId,
            job_id: claim.jobId,
            lease_epoch: claim.leaseEpoch,
            session_id: sessionId,
            reason,
            now: now(),
          })
        } else {
          await client.mutation(api.workgraphBackground.retryRecapLaunch, {
            service_token: serviceToken,
            organization_id: claim.orgId,
            owner_user_id: claim.ownerUserId,
            job_id: claim.jobId,
            lease_epoch: claim.leaseEpoch,
            worker_id: workerId,
            reason,
            now: now(),
          })
        }
        return { settled: false, error: reason }
      }
    }),
  )
  const running = (await tenantRows(client, api.workgraphBackground.listRunningRecaps, tenants, {
    service_token: serviceToken,
    limit: 10,
    now: now(),
  })) as RunningRecap[]
  const results = await Promise.all(
    running.map(async (recap) => {
      try {
        const provider = services.relay.provider
        const manager = services.sandbox.sandboxManager
        if (!provider || !manager) throw new Error("Hosted sandbox manager and relay provider are required")
        const placement = await manager.target(recap.workspaceId)
        if (placement.status !== "ready") throw new Error("Hosted recap workspace is unavailable")
        const token = await provider.mintRuntimeAccessToken({
          workspaceId: recap.workspaceId,
          hostId: placement.hostId,
          subject: recap.ownerUserId,
          orgId: recap.orgId,
          role: "owner",
          ttlMs: 10 * 60_000,
        })
        const relay = await provider.getRelayEndpoint(recap.workspaceId, placement.homeRegion as never)
        const events = await hostedSessionHistory(
          runtimeRequest(request, relay, recap.workspaceId, token.token),
          recap.sessionId,
        )
        const terminal = events.findLast(
          (event) =>
            event.type.startsWith("session.next.step.ended") || event.type.startsWith("session.next.step.failed"),
        )
        if (!terminal) return { settled: false, state: "running" }
        if (terminal.type.startsWith("session.next.step.failed")) throw new Error(sessionError(terminal.data.error))
        const output = parseHostedRecapOutput(
          events.findLast((event) => event.type.startsWith("session.next.text.ended"))?.data.text,
        )
        return await client.mutation(api.workgraphBackground.completeRecap, {
          service_token: serviceToken,
          organization_id: recap.orgId,
          owner_user_id: recap.ownerUserId,
          job_id: recap.jobId,
          lease_epoch: recap.leaseEpoch,
          session_id: recap.sessionId,
          summary: output.summary,
          ...(output.actionableReferences.length ? { actionable_references: output.actionableReferences } : {}),
          now: now(),
        })
      } catch (error) {
        telemetry.queue({
          kind: "recap",
          backlog: 1,
          oldestAgeMs: 0,
          failed: 1,
          retried: 0,
          expiredRecoveries: 0,
          activeLeaseAgeMs: recap.activeLeaseAgeMs ?? 0,
        })
        return await client.mutation(api.workgraphBackground.failRecap, {
          service_token: serviceToken,
          organization_id: recap.orgId,
          owner_user_id: recap.ownerUserId,
          job_id: recap.jobId,
          lease_epoch: recap.leaseEpoch,
          session_id: recap.sessionId,
          reason: error instanceof Error ? error.message : String(error),
          now: now(),
        })
      }
    }),
  )
  recordQueueTelemetry(telemetry, "recap", claims, running, [...launched, ...results])
  recordWorkspaceLaunchTelemetry(telemetry, launched)
  const sourcePlanning = await reconcileSourcePlanning(
    client,
    services,
    request,
    serviceToken,
    workerId,
    now,
    tenants,
    telemetry,
  )
  return { controls: controlResults, intake, launched, results, sourcePlanning }
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
          throw new Error(
            placement.status === "provisioning"
              ? "Source planning workspace is provisioning"
              : (placement.error ?? "Source planning workspace is unavailable"),
          )
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
        const created = await runtime("/api/session", {
          method: "POST",
          body: JSON.stringify({
            id: requestedSessionId,
            agent: claim.profile.agent,
            model: {
              providerID: claim.profile.model.providerId,
              id: claim.profile.model.modelId,
              variant: claim.profile.effort,
            },
            tools: claim.profile.tools,
            location: { directory: "/workspace" },
          }),
        })
        const body = (await created.json()) as { id?: string; data?: { id?: string } }
        const adoptedId = body.id ?? body.data?.id
        if (!adoptedId) throw new Error("Hosted source planning Session create response did not include a Session ID")
        if (adoptedId !== requestedSessionId)
          throw new Error("Hosted source planning Session did not adopt its caller-owned durable identity")
        try {
          await runtime(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
            method: "POST",
            body: JSON.stringify({
              id: `msg_workgraph_${claim.jobId}`,
              prompt: { text: claim.prompt },
              delivery: "steer",
              resume: true,
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
        await client.mutation(
          sessionId ? api.workgraphBackground.failSourcePlan : api.workgraphBackground.retrySourcePlanLaunch,
          {
            organization_id: claim.orgId,
            service_token: serviceToken,
            owner_user_id: claim.ownerUserId,
            job_id: claim.jobId,
            lease_epoch: claim.leaseEpoch,
            ...(sessionId ? { session_id: sessionId } : { worker_id: workerId }),
            reason,
            now: now(),
          },
        )
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
        const events = await hostedSessionHistory(
          runtimeRequest(request, relay, plan.workspaceId, token.token),
          plan.sessionId,
        )
        const terminal = events.findLast(
          (event) =>
            event.type.startsWith("session.next.step.ended") || event.type.startsWith("session.next.step.failed"),
        )
        if (!terminal) return { settled: false, state: "running" }
        if (terminal.type.startsWith("session.next.step.failed")) throw new Error(sessionError(terminal.data.error))
        const text = events.findLast((event) => event.type.startsWith("session.next.text.ended"))?.data.text
        if (typeof text !== "string") throw new Error("Source planning Session returned no structured result")
        const parsed = AdmissionAgentPlanSchema.parse(JSON.parse(text))
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

export function parseHostedRecapOutput(value: unknown) {
  if (typeof value !== "string") throw new Error("Hosted Recap Session did not return text")
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Hosted Recap Session returned invalid JSON")
  const result = parsed as Record<string, unknown>
  if (
    Object.keys(result).sort().join(",") !== "actionableReferences,summary" ||
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    !Array.isArray(result.actionableReferences)
  ) {
    throw new Error("Hosted Recap Session returned an invalid structured result")
  }
  const allowed = new Set(["decision", "attempt", "work_item", "outcome", "stream"])
  const seen = new Set<string>()
  const actionableReferences = result.actionableReferences.map((reference) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference))
      throw new Error("Hosted Recap Session returned an invalid actionable reference")
    const entry = reference as Record<string, unknown>
    if (
      Object.keys(entry).sort().join(",") !== "id,type" ||
      typeof entry.type !== "string" ||
      !allowed.has(entry.type) ||
      typeof entry.id !== "string" ||
      !entry.id.trim()
    ) {
      throw new Error("Hosted Recap Session returned an invalid actionable reference")
    }
    const key = `${entry.type}:${entry.id.trim()}`
    if (seen.has(key)) throw new Error("Hosted Recap Session returned a duplicate actionable reference")
    seen.add(key)
    return { type: entry.type, id: entry.id.trim() }
  })
  return { summary: result.summary.trim(), actionableReferences }
}

function runtimeRequest(request: RuntimeFetch, relay: string, workspaceId: string, token: string) {
  return async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${token}`)
    headers.set("x-opencode-directory", "/workspace")
    if (init?.body) headers.set("content-type", "application/json")
    const response = await request(
      `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}${path}`,
      { ...init, headers },
    )
    if (response.ok) return response
    throw new HostedSessionRequestError(response.status, await response.text())
  }
}

class HostedSessionRequestError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Hosted Session V2 request failed: ${status} ${body}`)
  }
}

type SessionEvent = { type: string; durable?: { seq: number }; data: Record<string, unknown> }
type RunningAttempt = {
  ownerUserId: string
  orgId: string
  attemptId: string
  leaseEpoch: number
  sessionId: string
  workspaceId: string
  activeLeaseAgeMs?: number
  expiredRecovery?: boolean
}

function mutationArgs(claim: Claim, serviceToken: string, workerId: string, extra: Record<string, unknown>) {
  return {
    service_token: serviceToken,
    organization_id: claim.orgId,
    owner_user_id: claim.ownerUserId,
    outbox_id: claim.outboxId,
    attempt_id: claim.attemptId,
    lease_epoch: claim.leaseEpoch,
    worker_id: workerId,
    ...extra,
  }
}

function resultArgs(attempt: RunningAttempt, serviceToken: string, extra: Record<string, unknown>) {
  return {
    service_token: serviceToken,
    organization_id: attempt.orgId,
    owner_user_id: attempt.ownerUserId,
    attempt_id: attempt.attemptId,
    lease_epoch: attempt.leaseEpoch,
    session_id: attempt.sessionId,
    ...extra,
  }
}

function tenantResults(
  client: Executor,
  mutation: Mutation,
  tenants: readonly WorkerTenant[],
  args: Record<string, unknown>,
) {
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

async function tenantRows(
  client: Executor,
  mutation: Mutation,
  tenants: readonly WorkerTenant[],
  args: Record<string, unknown>,
) {
  const results = await tenantResults(client, mutation, tenants, args)
  if (results.some((result) => !Array.isArray(result))) {
    throw new Error("Tenant WorkGraph worker mutation returned an invalid result")
  }
  return results.flat()
}

function recordAttemptTelemetry(
  telemetry: WorkGraphOperationalReporter,
  claims: readonly Claim[],
  running: readonly RunningAttempt[],
  launched: readonly unknown[],
  results: readonly unknown[],
  latencyMs: number,
) {
  const observations = [...launched, ...results]
  recordQueueTelemetry(telemetry, "attempt", claims, running, observations)
  telemetry.reconciliation({
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
  kind: "attempt" | "recap" | "source_plan",
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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([organizationId, ownerUserId, scopeId])),
  )
  return `wg-${Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function sessionError(error: unknown) {
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return JSON.stringify(error ?? "Session failed")
}

class SessionHistoryResponseError extends Error {
  readonly code = "session_history_invalid"

  constructor() {
    super("session_history_invalid")
  }
}

function hostedSessionHistoryPage(value: unknown): Readonly<{ data: SessionEvent[]; hasMore: boolean }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionHistoryResponseError()
  const page = value as Record<string, unknown>
  if (!Array.isArray(page.data) || typeof page.hasMore !== "boolean") throw new SessionHistoryResponseError()
  const data = page.data.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionHistoryResponseError()
    const event = value as Record<string, unknown>
    if (typeof event.type !== "string" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
      throw new SessionHistoryResponseError()
    }
    if (event.durable !== undefined) {
      if (!event.durable || typeof event.durable !== "object" || Array.isArray(event.durable)) {
        throw new SessionHistoryResponseError()
      }
      const durable = event.durable as Record<string, unknown>
      if (typeof durable.seq !== "number" || !Number.isSafeInteger(durable.seq) || durable.seq < 1) {
        throw new SessionHistoryResponseError()
      }
    }
    return event as SessionEvent
  })
  return { data, hasMore: page.hasMore }
}

function hostedSessionMessages(value: unknown) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Hosted Session transcript was invalid")
  const messages = (value as Record<string, unknown>).messages
  if (!Array.isArray(messages)) throw new Error("Hosted Session transcript was invalid")
  return messages
}

async function hostedSessionHistory(
  runtime: (path: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
) {
  const events: SessionEvent[] = []
  let after = 0
  for (;;) {
    const history = await runtime(`/api/session/${encodeURIComponent(sessionId)}/history?limit=100&after=${after}`)
    const page = hostedSessionHistoryPage(await history.json())
    events.push(...page.data)
    if (!page.hasMore) return events
    const next = page.data.at(-1)?.durable?.seq
    if (next === undefined || next <= after) throw new SessionHistoryResponseError()
    after = next
  }
}

function convexExecutor(url: string): Executor {
  const client = new ConvexHttpClient(url)
  return { mutation: (fn, args) => client.mutation(fn, args) }
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
