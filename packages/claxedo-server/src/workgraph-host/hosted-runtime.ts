import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { defaultHomeRegion } from "../region"
import type { ControlPlaneServices } from "../control-plane/services"
import { AdmissionAgentPlanSchema } from "@claxedo/workgraph/contracts"
import { clean, type HostedWorkerEnv } from "../control-plane/adapters/worker/hosted-compose"

type Mutation = FunctionReference<"mutation">
const api = anyApi as unknown as {
  workgraphRuntime: {
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
  title: string
  prompt: string
  profile: {
    environment: { kind: "hosted_workspace"; presetId?: string }
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
type RecapClaim = {
  ownerUserId: string
  orgId: string
  jobId: string
  leaseEpoch: number
  streamId: string
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
}
type SourcePlanClaim = Omit<RecapClaim, "streamId"> & { proposalId: string; sessionId?: string }
type RunningSourcePlan = RunningRecap

/** Durable Worker dispatcher over SandboxManager → authenticated relay → Session V2. */
export function createHostedWorkGraphRuntime(
  env: HostedWorkerEnv,
  services: ControlPlaneServices,
  options: { executor?: Executor; fetch?: RuntimeFetch; now?: () => number; background?: boolean } = {},
) {
  const url = clean(env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!url || !serviceToken) return
  const client = options.executor ?? convexExecutor(url)
  const request = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const workerId = clean(env.CLAXEDO_WORKGRAPH_WORKER_ID) ?? "claxedo-worker"
  return {
    reconcile: async () => {
      const claimedAt = now()
      const claims = (await client.mutation(api.workgraphRuntime.claimLaunches, {
        service_token: serviceToken,
        worker_id: workerId,
        now: claimedAt,
        limit: 10,
      })) as Claim[]
      const launched = await Promise.all(
        claims.map(async (claim) => {
          try {
            const connectionTools = claim.profile.tools.filter((tool) =>
              tool === "connection_work_source_list" || tool === "connection_work_source_comment" || tool === "connection_work_source_update")
            const brokerUrl = clean(env.CLAXEDO_PUBLIC_URL) ?? clean(env.CLAXEDO_SERVER_URL) ?? clean(env.CLAXEDO_CENTRAL_URL)
            if (claim.profile.connectionIds.length > 0 && (!connectionTools.length || !brokerUrl)) {
              throw new Error("Connection-bound Attempts require explicit Connection tools and a central broker URL")
            }
            const manager = services.sandbox.sandboxManager
            const provider = services.relay.provider
            if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
            const workspaceId = await workGraphWorkspaceId(claim.ownerUserId, claim.streamId)
            const placement = await manager.ensure(workspaceId, {
              homeRegion: services.defaultHomeRegion ?? defaultHomeRegion(),
              labels: { workload: "workgraph", ownerUserId: claim.ownerUserId, streamId: claim.streamId },
              runtimeCwd: "/workspace",
              env: { WORKSPACE_RUNTIME_RUNNER: claim.profile.harness },
              source: claim.profile.repository?.remoteUrl
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
            if (!confirmed.accepted) return { settled: false, state: "cancelled" }
            const created = await runtime("/api/session", {
              method: "POST",
              body: JSON.stringify({
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
            const createdBody = (await created.json()) as { id?: string; data?: { id?: string } }
            const sessionId = createdBody.id ?? createdBody.data?.id
            if (!sessionId) throw new Error("Hosted Session V2 create response did not include a Session ID")
            const running = (await client.mutation(
              api.workgraphRuntime.markRunning,
              mutationArgs(claim, serviceToken, workerId, {
                workspace_id: workspaceId,
                session_id: sessionId,
                now: now(),
              }),
            )) as { settled?: boolean }
            if (!running.settled) {
              await client.mutation(api.workgraphRuntime.compensateRejectedLaunch, {
                service_token: serviceToken,
                owner_user_id: claim.ownerUserId,
                outbox_id: claim.outboxId,
                attempt_id: claim.attemptId,
                worker_id: workerId,
                session_id: sessionId,
                workspace_id: workspaceId,
                now: now(),
              })
              return { settled: false }
            }
            if (claim.profile.connectionIds.length > 0) {
              try {
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
              } catch (error) {
                await client.mutation(api.workgraphRuntime.compensateRejectedLaunch, {
                  service_token: serviceToken,
                  owner_user_id: claim.ownerUserId,
                  outbox_id: claim.outboxId,
                  attempt_id: claim.attemptId,
                  worker_id: workerId,
                  session_id: sessionId,
                  workspace_id: workspaceId,
                  now: now(),
                })
                throw error
              }
            }
            await runtime(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
              method: "POST",
              body: JSON.stringify({
                id: `msg_workgraph_${claim.attemptId}`,
                prompt: { text: claim.prompt },
                delivery: "steer",
                resume: true,
              }),
            })
            return { settled: true, state: "running" }
          } catch (error) {
            return await client.mutation(
              api.workgraphRuntime.markAttention,
              mutationArgs(claim, serviceToken, workerId, {
                reason: error instanceof Error ? error.message : String(error),
                now: now(),
              }),
            )
          }
        }),
      )
      const running = (await client.mutation(api.workgraphRuntime.listRunning, {
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
            if (!terminal) return { settled: false, state: "running" }
            const cleanup = await request(
              `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(attempt.workspaceId)}/api/workgraph/connection-binding/${encodeURIComponent(attempt.sessionId)}`,
              {
                method: "DELETE",
                headers: { authorization: `Bearer ${token.token}`, "x-opencode-directory": "/workspace" },
              },
            )
            if (!cleanup.ok) {
              throw new Error(`Hosted Session Connection cleanup failed: ${cleanup.status} ${await cleanup.text()}`)
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
            return await client.mutation(
              api.workgraphRuntime.recordResult,
              resultArgs(attempt, serviceToken, {
                summary: summary.trim(),
                artifacts: files.map((file) => `file:${file.trim()}`),
                now: now(),
              }),
            )
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
        options.background === false
          ? undefined
          : await reconcileBackground(client, services, request, serviceToken, workerId, now)
      return { launched, results, ...(background ? { background } : {}) }
    },
  }
}

async function reconcileBackground(
  client: Executor,
  services: ControlPlaneServices,
  request: RuntimeFetch,
  serviceToken: string,
  workerId: string,
  now: () => number,
) {
  const controls = (await client.mutation(api.workgraphRuntime.claimControlEffects, {
    service_token: serviceToken,
    worker_id: workerId,
    now: now(),
    limit: 25,
  })) as Array<{
    ownerUserId: string
    orgId: string
    outboxId: string
    streamId: string
    effectType: "interrupt_attempt" | "cleanup_stream"
    payload: { sessionId?: string; sessions?: string[] }
  }>
  const controlResults = await Promise.all(
    controls.map(async (control) => {
      try {
        const manager = services.sandbox.sandboxManager
        const provider = services.relay.provider
        if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
        const workspaceId = await workGraphWorkspaceId(control.ownerUserId, control.streamId)
        const placement = await manager.target(workspaceId)
        if (control.effectType === "interrupt_attempt" && placement.status !== "ready") {
          throw new Error("Attempt Session placement is not ready for interruption")
        }
        if (
          control.effectType === "cleanup_stream" &&
          (control.payload.sessions?.length ?? 0) > 0 &&
          placement.status !== "ready"
        ) {
          throw new Error("Stream Session placement is not ready for interruption")
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
        if (control.effectType === "cleanup_stream") await manager.destroy(workspaceId)
        return await client.mutation(api.workgraphRuntime.completeControlEffect, {
          service_token: serviceToken,
          owner_user_id: control.ownerUserId,
          outbox_id: control.outboxId,
          worker_id: workerId,
          ok: true,
          ...(control.payload.sessionId ? { observed_session_id: control.payload.sessionId } : {}),
          now: now(),
        })
      } catch (error) {
        return await client.mutation(api.workgraphRuntime.completeControlEffect, {
          service_token: serviceToken,
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
  const intake = await client.mutation(api.workgraphBackground.drainSessionIntake, {
    service_token: serviceToken,
    now: now(),
    limit: 25,
  })
  const claims = (await client.mutation(api.workgraphBackground.claimRecaps, {
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
        const workspaceId = await workGraphWorkspaceId(claim.ownerUserId, claim.streamId)
        const placement = await manager.ensure(workspaceId, {
          homeRegion: services.defaultHomeRegion ?? defaultHomeRegion(),
          labels: { workload: "workgraph-recap", ownerUserId: claim.ownerUserId, streamId: claim.streamId },
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
        const created = await runtime("/api/session", {
          method: "POST",
          body: JSON.stringify({
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
        sessionId = body.id ?? body.data?.id
        if (!sessionId) throw new Error("Hosted recap Session create response did not include a Session ID")
        const marked = (await client.mutation(api.workgraphBackground.markRecapSession, {
          service_token: serviceToken,
          owner_user_id: claim.ownerUserId,
          job_id: claim.jobId,
          lease_epoch: claim.leaseEpoch,
          worker_id: workerId,
          workspace_id: workspaceId,
          session_id: sessionId,
          now: now(),
        })) as { settled?: boolean }
        if (!marked.settled) {
          await runtime(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" }).catch(
            () => undefined,
          )
          return { settled: false }
        }
        await runtime(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
          method: "POST",
          body: JSON.stringify({
            id: `msg_recap_${claim.jobId}`,
            prompt: { text: claim.prompt },
            delivery: "steer",
            resume: true,
          }),
        })
        return { settled: true, state: "running" }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (sessionId) {
          await client.mutation(api.workgraphBackground.failRecap, {
            service_token: serviceToken,
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
  const running = (await client.mutation(api.workgraphBackground.listRunningRecaps, {
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
        const history = await runtimeRequest(
          request,
          relay,
          recap.workspaceId,
          token.token,
        )(`/api/session/${encodeURIComponent(recap.sessionId)}/history?limit=100&after=0`)
        const body = (await history.json()) as { data?: SessionEvent[] }
        const terminal = body.data?.findLast(
          (event) =>
            event.type.startsWith("session.next.step.ended") || event.type.startsWith("session.next.step.failed"),
        )
        if (!terminal) return { settled: false, state: "running" }
        if (terminal.type.startsWith("session.next.step.failed")) throw new Error(sessionError(terminal.data.error))
        const output = parseHostedRecapOutput(body.data?.findLast((event) => event.type.startsWith("session.next.text.ended"))?.data.text)
        return await client.mutation(api.workgraphBackground.completeRecap, {
          service_token: serviceToken,
          owner_user_id: recap.ownerUserId,
          job_id: recap.jobId,
          lease_epoch: recap.leaseEpoch,
          session_id: recap.sessionId,
          summary: output.summary,
          ...(output.actionableReferences.length ? { actionable_references: output.actionableReferences } : {}),
          now: now(),
        })
      } catch (error) {
        return await client.mutation(api.workgraphBackground.failRecap, {
          service_token: serviceToken,
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
  const sourcePlanning = await reconcileSourcePlanning(client, services, request, serviceToken, workerId, now)
  return { controls: controlResults, intake, launched, results, sourcePlanning }
}

async function reconcileSourcePlanning(
  client: Executor,
  services: ControlPlaneServices,
  request: RuntimeFetch,
  serviceToken: string,
  workerId: string,
  now: () => number,
) {
  const claimed = await client.mutation(api.workgraphBackground.claimSourcePlans, {
    service_token: serviceToken,
    worker_id: workerId,
    now: now(),
    limit: 10,
  })
  const claims = Array.isArray(claimed) ? claimed as SourcePlanClaim[] : []
  const launched = await Promise.all(claims.map(async (claim) => {
    let sessionId: string | undefined
    try {
      const manager = services.sandbox.sandboxManager
      const provider = services.relay.provider
      if (!manager || !provider) throw new Error("Hosted sandbox manager and relay provider are required")
      const workspaceId = await workGraphWorkspaceId(claim.ownerUserId, claim.jobId)
      const placement = await manager.ensure(workspaceId, {
        homeRegion: services.defaultHomeRegion ?? defaultHomeRegion(),
        labels: { workload: "workgraph-source-plan", ownerUserId: claim.ownerUserId, proposalId: claim.proposalId },
        runtimeCwd: "/workspace",
        env: {},
        source: { kind: "empty" },
        exposure: { kind: "relay" },
      })
      if (placement.status !== "ready") throw new Error(placement.status === "provisioning" ? "Source planning workspace is provisioning" : (placement.error ?? "Source planning workspace is unavailable"))
      const token = await provider.mintRuntimeAccessToken({
        workspaceId, hostId: placement.hostId, subject: claim.ownerUserId, orgId: claim.orgId,
        role: "owner", ttlMs: 10 * 60_000,
      })
      const relay = await provider.getRelayEndpoint(workspaceId, placement.homeRegion as never)
      const runtime = runtimeRequest(request, relay, workspaceId, token.token)
      const requestedSessionId = claim.sessionId ?? `ses_workgraph_${claim.jobId}_${claim.leaseEpoch}`
      sessionId = requestedSessionId
      const reserved = await client.mutation(api.workgraphBackground.markSourcePlanSession, {
        service_token: serviceToken, owner_user_id: claim.ownerUserId, job_id: claim.jobId,
        lease_epoch: claim.leaseEpoch, worker_id: workerId, workspace_id: workspaceId,
        session_id: requestedSessionId, admission_confirmed: false, now: now(),
      }) as { settled?: boolean }
      if (!reserved.settled) return { settled: false }
      const created = await runtime("/api/session", {
        method: "POST",
        body: JSON.stringify({
          id: requestedSessionId,
          agent: claim.profile.agent,
          model: { providerID: claim.profile.model.providerId, id: claim.profile.model.modelId, variant: claim.profile.effort },
          tools: claim.profile.tools,
          location: { directory: "/workspace" },
        }),
      })
      const body = (await created.json()) as { id?: string; data?: { id?: string } }
      const adoptedId = body.id ?? body.data?.id
      if (!adoptedId) throw new Error("Hosted source planning Session create response did not include a Session ID")
      if (adoptedId !== requestedSessionId) throw new Error("Hosted source planning Session did not adopt its caller-owned durable identity")
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
      const marked = await client.mutation(api.workgraphBackground.markSourcePlanSession, {
        service_token: serviceToken, owner_user_id: claim.ownerUserId, job_id: claim.jobId,
        lease_epoch: claim.leaseEpoch, worker_id: workerId, workspace_id: workspaceId,
        session_id: sessionId, admission_confirmed: true, now: now(),
      }) as { settled?: boolean }
      if (!marked.settled) {
        return { settled: false }
      }
      return { settled: true, state: "running" }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await client.mutation(sessionId ? api.workgraphBackground.failSourcePlan : api.workgraphBackground.retrySourcePlanLaunch, {
        service_token: serviceToken, owner_user_id: claim.ownerUserId, job_id: claim.jobId,
        lease_epoch: claim.leaseEpoch, ...(sessionId ? { session_id: sessionId } : { worker_id: workerId }), reason, now: now(),
      })
      return { settled: false, error: reason }
    }
  }))
  const listed = await client.mutation(api.workgraphBackground.listRunningSourcePlans, {
    service_token: serviceToken,
    limit: 10,
    now: now(),
  })
  const running = Array.isArray(listed) ? listed as RunningSourcePlan[] : []
  const results = await Promise.all(running.map(async (plan) => {
    try {
      const provider = services.relay.provider
      const manager = services.sandbox.sandboxManager
      if (!provider || !manager) throw new Error("Hosted sandbox manager and relay provider are required")
      const placement = await manager.target(plan.workspaceId)
      if (placement.status !== "ready") throw new Error("Hosted source planning workspace is unavailable")
      const token = await provider.mintRuntimeAccessToken({
        workspaceId: plan.workspaceId, hostId: placement.hostId, subject: plan.ownerUserId, orgId: plan.orgId,
        role: "owner", ttlMs: 10 * 60_000,
      })
      const relay = await provider.getRelayEndpoint(plan.workspaceId, placement.homeRegion as never)
      const history = await runtimeRequest(request, relay, plan.workspaceId, token.token)(
        `/api/session/${encodeURIComponent(plan.sessionId)}/history?limit=100&after=0`,
      )
      const body = (await history.json()) as { data?: SessionEvent[] }
      const terminal = body.data?.findLast((event) => event.type.startsWith("session.next.step.ended") || event.type.startsWith("session.next.step.failed"))
      if (!terminal) return { settled: false, state: "running" }
      if (terminal.type.startsWith("session.next.step.failed")) throw new Error(sessionError(terminal.data.error))
      const text = body.data?.findLast((event) => event.type.startsWith("session.next.text.ended"))?.data.text
      if (typeof text !== "string") throw new Error("Source planning Session returned no structured result")
      const parsed = AdmissionAgentPlanSchema.parse(JSON.parse(text))
      return await client.mutation(api.workgraphBackground.completeSourcePlan, {
        service_token: serviceToken, owner_user_id: plan.ownerUserId, job_id: plan.jobId,
        lease_epoch: plan.leaseEpoch, session_id: plan.sessionId, plan: parsed, now: now(),
      })
    } catch (error) {
      return await client.mutation(api.workgraphBackground.failSourcePlan, {
        service_token: serviceToken, owner_user_id: plan.ownerUserId, job_id: plan.jobId,
        lease_epoch: plan.leaseEpoch, session_id: plan.sessionId,
        reason: error instanceof Error ? error.message : String(error), now: now(),
      })
    }
  }))
  return { launched, results }
}

export function parseHostedRecapOutput(value: unknown) {
  if (typeof value !== "string") throw new Error("Hosted Recap Session did not return text")
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Hosted Recap Session returned invalid JSON")
  const result = parsed as Record<string, unknown>
  if (Object.keys(result).sort().join(",") !== "actionableReferences,summary" || typeof result.summary !== "string" || !result.summary.trim() || !Array.isArray(result.actionableReferences)) {
    throw new Error("Hosted Recap Session returned an invalid structured result")
  }
  const allowed = new Set(["decision", "attempt", "work_item", "outcome", "stream"])
  const seen = new Set<string>()
  const actionableReferences = result.actionableReferences.map((reference) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("Hosted Recap Session returned an invalid actionable reference")
    const entry = reference as Record<string, unknown>
    if (Object.keys(entry).sort().join(",") !== "id,type" || typeof entry.type !== "string" || !allowed.has(entry.type) || typeof entry.id !== "string" || !entry.id.trim()) {
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
  constructor(readonly status: number, body: string) {
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
}

function mutationArgs(claim: Claim, serviceToken: string, workerId: string, extra: Record<string, unknown>) {
  return {
    service_token: serviceToken,
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
    owner_user_id: attempt.ownerUserId,
    attempt_id: attempt.attemptId,
    lease_epoch: attempt.leaseEpoch,
    session_id: attempt.sessionId,
    ...extra,
  }
}

async function workGraphWorkspaceId(owner: string, stream: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${owner}:${stream}`))
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

function convexExecutor(url: string): Executor {
  const client = new ConvexHttpClient(url)
  return { mutation: (fn, args) => client.mutation(fn, args) }
}
