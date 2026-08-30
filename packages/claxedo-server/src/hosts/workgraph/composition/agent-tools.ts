/**
 * Application tools and Session-context helpers used by the embedded SDK
 * composition. Session reads go through Claxedo's harness-neutral runtime.
 */
import { z } from "zod"
import type { EmbeddedWorkGraphTransport, WorkGraphCreationContext } from "@claxedo/mcp/workgraph-tools"
import { masterSessionId } from "@claxedo/workgraph/contracts"
import type { ExecutionProfileDefaults, WorkGraphContext } from "@claxedo/workgraph/contracts"
import type { LocalEmbeddedWorkGraph } from "./server-workgraph"
const SESSION_RUNTIME_BASE = "http://session-runtime.internal"
type SessionRequestFn = (request: Request) => Promise<Response>
type OpenCodeApplicationToolRegistration = Readonly<{
  description: string
  inputSchema: Record<string, unknown>
  execute(input: unknown, invocation: Readonly<{ sessionID: string; toolCallID: string }>): Promise<unknown>
}>

export function createLocalEmbeddedWorkGraphTransport(
  embedded: LocalEmbeddedWorkGraph,
  resolveContext: () => WorkGraphContext,
): EmbeddedWorkGraphTransport {
  const transport: EmbeddedWorkGraphTransport = {
    execute: (request) => embedded.service.execute(resolveContext(), request as never),
    snapshot: (input) => embedded.service.queries.snapshot.page(resolveContext(), input),
    readStream: (streamId) => embedded.service.queries.streams.read(resolveContext(), { streamId: streamId as never }),
    readDefaults: () => embedded.service.queries.defaults.read(resolveContext(), {}),
    listAttention: (input) => embedded.service.queries.attention.list(resolveContext(), input as never),
    listSources: (input) => embedded.service.queries.sources.list(resolveContext(), input as never),
    readSource: (workSourceId) =>
      embedded.service.queries.sources.read(resolveContext(), { workSourceId: workSourceId as never }),
    readSourceRevision: (workSourceId, revisionId) =>
      embedded.service.queries.sources.readRevision(resolveContext(), {
        workSourceId: workSourceId as never,
        revisionId: revisionId as never,
      }),
    readProposal: (proposalId) => embedded.service.queries.proposals.read(resolveContext(), { proposalId }),
    readWorkItem: (workItemId) => embedded.service.queries.workItems.readDetail(resolveContext(), { workItemId }),
    listWorkItemRuns: (workItemId, input) =>
      embedded.service.queries.workItems.listRuns(resolveContext(), {
        workItemId: workItemId as never,
        ...input,
      } as never),
    listWorkItemActivity: (workItemId, input) =>
      embedded.service.queries.workItems.listActivity(resolveContext(), {
        workItemId: workItemId as never,
        ...input,
      } as never),
    readRun: (runId) => embedded.service.queries.runs.read(resolveContext(), { runId }),
    readDecision: (decisionId) => embedded.service.queries.decisions.read(resolveContext(), { decisionId }),
    readEvidence: (evidenceId) =>
      embedded.service.queries.evidence.read(resolveContext(), { evidenceId: evidenceId as never }),
    listEvidence: (input) => embedded.service.queries.evidence.list(resolveContext(), input as never),
    bindSession: (input) => embedded.sessionBindings.bind(resolveContext(), input as never),
    readSessionBinding: (sessionId) => embedded.sessionBindings.readForSession(resolveContext(), sessionId),
    attachSessionTask: (input) => embedded.sessionBindings.attachTask(resolveContext(), input as never),
    recordSessionCheckpoint: (input) => embedded.sessionBindings.recordCheckpoint(resolveContext(), input as never),
    releaseSessionBinding: (input) => embedded.sessionBindings.release(resolveContext(), input as never),
  }
  if (embedded.executionCapabilities) {
    Object.assign(transport, {
      readExecutionCapabilities: () => embedded.executionCapabilities!.read(resolveContext(), {}),
      ...(embedded.executionCapabilities.refresh
        ? {
            refreshExecutionCapabilities: () => embedded.executionCapabilities!.refresh!(resolveContext(), {}),
          }
        : {}),
    })
  }
  if (embedded.intake) {
    Object.assign(transport, {
      listSourceViews: async () => ({ sourceViews: await embedded.intake!.sourceViews.list(resolveContext()) }),
      createSourceView: (input: Readonly<Record<string, unknown>>) =>
        embedded.intake!.sourceViews.create(resolveContext(), input as never),
      updateSourceView: (sourceViewId: string, input: Readonly<Record<string, unknown>>) =>
        embedded.intake!.sourceViews.update(resolveContext(), sourceViewId, input as never),
      deleteSourceView: (sourceViewId: string, expectedVersion: number) =>
        embedded.intake!.sourceViews.delete(resolveContext(), sourceViewId, expectedVersion),
      refreshSourceView: (sourceViewId: string) => embedded.intake!.intake.refresh(resolveContext(), sourceViewId),
      listIntake: (input: Readonly<Record<string, unknown>>) =>
        embedded.intake!.intake.page(resolveContext(), input as never),
      readCandidate: (candidateId: string) => embedded.intake!.intake.read(resolveContext(), candidateId),
      stageCandidate: (candidateId: string) => embedded.intake!.intake.stage(resolveContext(), candidateId),
      dismissCandidate: (candidateId: string, expectedVersion: number) =>
        embedded.intake!.intake.dismiss(resolveContext(), candidateId, expectedVersion),
      restoreCandidate: (candidateId: string, expectedVersion: number) =>
        embedded.intake!.intake.restore(resolveContext(), candidateId, expectedVersion),
      syncCandidate: (
        candidateId: string,
        input: Readonly<{ idempotencyKey: string; summary: string; status?: string }>,
      ) => embedded.intake!.intake.syncExternal(resolveContext(), { candidateId, ...input }),
    })
  }
  return transport
}

export async function createLocalWorkGraphAgentTools(
  embedded: LocalEmbeddedWorkGraph,
  owner: Readonly<{
    organizationId: string
    ownerUserId: string
    sessionExecution?: (sessionId: string) => Promise<ExecutionProfileDefaults | undefined>
    sessionContext?: (sessionId: string) => Promise<WorkGraphCreationContext["session"] | undefined>
    /** Positive owner-direction fact: true only for a top-level (parentless) interactive
     *  Session. Absence of a binding alone must never confer owner authority — subagent
     *  child sessions are unbound too, and a missing callback fails closed to agent. */
    sessionOwnerDirected?: (sessionId: string) => Promise<boolean>
    notifyOwner?: (input: { idempotencyKey: string; text: string }) => Promise<{
      channel: string
      threadKey: string
      reference: string
      duplicate: boolean
    }>
  }>,
): Promise<Readonly<Record<string, OpenCodeApplicationToolRegistration>>> {
  const { callWorkGraph, registerWorkGraphTools } = await import("@claxedo/mcp/workgraph-tools")
  const tools = new Map<string, Readonly<{ description: string; inputSchema: Record<string, z.ZodType> }>>()
  const context = (sessionID: string, toolCallID: string): WorkGraphContext => ({
    organizationId: owner.organizationId as never,
    ownerUserId: owner.ownerUserId as never,
    actor: { type: "agent", id: sessionID as never },
    requestId: `agent_tool_${toolCallID}_${crypto.randomUUID()}` as never,
    access: { mode: "owner" },
  })
  const probe = createLocalEmbeddedWorkGraphTransport(embedded, () => context("catalog", "catalog"))
  registerWorkGraphTools((name, config) => tools.set(name, config as never), probe, false)
  const registered = Object.fromEntries(
    Array.from(tools, ([name, config]) => {
      const input = z.strictObject(config.inputSchema)
      return [
        name,
        {
          description: config.description,
          inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
          execute: async (value: unknown, invocation: Readonly<{ sessionID: string; toolCallID: string }>) => {
            const invokingContext = context(invocation.sessionID, invocation.toolCallID)
            const execution = name === "workgraph_create_stream"
              ? await owner.sessionExecution?.(invocation.sessionID)
              : undefined
            const session = sessionToolNames.has(name)
              ? await owner.sessionContext?.(invocation.sessionID)
              : undefined
            const ownerDirected = name === "workgraph_create_task" &&
              !await embedded.sessionBindings?.readForSession(invokingContext, invocation.sessionID) &&
              (await owner.sessionOwnerDirected?.(invocation.sessionID)) === true
            return callWorkGraph(
              createLocalEmbeddedWorkGraphTransport(embedded, () =>
                ownerDirected
                  ? { ...invokingContext, actor: { type: "user", id: owner.ownerUserId as never } }
                  : invokingContext,
              ),
              name as never,
              input.parse(value),
              execution || session ? { ...(execution ? { execution } : {}), ...(session ? { session } : {}) } : undefined,
            )
          },
        },
      ]
    }),
  )
  const operationId = z.string().trim().min(1)
  const streamId = z.string().trim().min(1)
  const title = z.string().trim().min(1)
  const description = z.string().optional()
  const priority = z.number().int().nonnegative().optional()
  const dependencyIds = z.array(z.string().trim().min(1)).optional()
  const completionContract = z.object({
    version: z.literal(1),
    mode: z.enum(["all", "any"]),
    requirements: z.array(z.object({
      id: z.string().trim().min(1),
      kind: z.enum(["test", "artifact", "review", "integration", "verification", "owner_confirmation"]),
      description: z.string().trim().min(1),
    }).passthrough()).min(1),
  })
  const summary = z.string().trim().min(1).max(10_000)
  const artifacts = z.array(z.string().trim().min(1)).max(100).optional()
  const evidence = z.array(z.strictObject({
    requirement_id: z.string().trim().min(1).optional(),
    evidence: z.record(z.string(), z.unknown()),
  })).min(1).max(100)
  const ledger = z.discriminatedUnion("action", [
    z.strictObject({
      action: z.enum(["create_task", "file_discovered"]),
      operation_id: operationId,
      stream_id: streamId,
      title,
      description,
      priority,
      dependency_ids: dependencyIds,
      completion_contract: completionContract,
    }),
    z.strictObject({
      action: z.literal("mark_done"),
      operation_id: operationId,
      summary,
      artifacts,
      evidence,
    }),
  ])
  const ledgerInput = z.strictObject({
    action: z.enum(["create_task", "file_discovered", "mark_done"]),
    operation_id: operationId,
    stream_id: streamId.optional().describe("Required for create_task and file_discovered"),
    title: title.optional().describe("Required for create_task and file_discovered"),
    description,
    priority,
    dependency_ids: dependencyIds,
    completion_contract: completionContract.optional().describe("Required for create_task and file_discovered"),
    summary: summary.optional().describe("Required for mark_done"),
    artifacts,
    evidence: evidence.optional().describe("Required for mark_done"),
  })
  const requireMasterBinding = async (
    toolContext: WorkGraphContext,
    invocation: Readonly<{ sessionID: string }>,
    toolName: string,
  ) => {
    const binding = await embedded.sessionBindings.readForSession(toolContext, invocation.sessionID)
    if (!binding?.streamId || invocation.sessionID !== masterSessionId(binding.streamId)) {
      throw new Error(`${toolName} is restricted to the bound Stream master`)
    }
    return binding
  }
  const notes = z.strictObject({
    status: z.array(z.string().trim().min(1).max(2_000)).max(100),
    learnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
    external_references: z.array(z.strictObject({
      source: z.strictObject({
        workSourceId: z.string().trim().min(1),
        revisionId: z.string().trim().min(1),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
      }),
      quote: z.string().trim().min(1).max(20_000),
    })).max(100).default([]),
  })
  return {
    ...registered,
    workgraph_land_candidate: {
      description: "Revalidate and serially land a candidate git revision into the bound Stream envelope.",
      inputSchema: z.toJSONSchema(z.strictObject({
        work_item_id: z.string().trim().min(1),
        candidate_revision: z.string().trim().min(1),
        expected_head: z.string().trim().min(1),
        forbidden_patterns: z.array(z.string().min(1)).max(100).optional(),
      })) as Record<string, unknown>,
      execute: async (value: unknown, invocation: Readonly<{ sessionID: string; toolCallID: string }>) => {
        const parsed = z.strictObject({
          work_item_id: z.string().trim().min(1),
          candidate_revision: z.string().trim().min(1),
          expected_head: z.string().trim().min(1),
          forbidden_patterns: z.array(z.string().min(1)).max(100).optional(),
        }).parse(value)
        const invokingContext = context(invocation.sessionID, invocation.toolCallID)
        const binding = await requireMasterBinding(invokingContext, invocation, "workgraph_land_candidate")
        if (!embedded.execution.land) throw new Error("WorkGraph landing is unavailable")
        try {
          return await embedded.execution.land(invokingContext, {
            streamId: binding.streamId,
            candidateRevision: parsed.candidate_revision,
            expectedHead: parsed.expected_head,
            ...(parsed.forbidden_patterns ? { forbiddenPatterns: parsed.forbidden_patterns } : {}),
          })
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "landing_conflict") throw error
          return embedded.service.execute(invokingContext, {
            operationId: `landing_conflict_${invocation.toolCallID}` as never,
            command: {
              version: 1,
              type: "record_landing_conflict",
              streamId: binding.streamId,
              workItemId: parsed.work_item_id as never,
              reason: error instanceof Error ? error.message : "Candidate could not be merged",
            },
          })
        }
      },
    },
    workgraph_ledger: {
      description: "Create human-directed Tasks, file discovered work for approval, or complete the current Task with evidence.",
      inputSchema: z.toJSONSchema(ledgerInput) as Record<string, unknown>,
      execute: async (value: unknown, invocation: Readonly<{ sessionID: string; toolCallID: string }>) => {
        const parsed = ledger.parse(value)
        // `action` selects which WorkGraph tool to forward to; it is not a field
        // on either target tool, so it must not travel with the payload.
        const { action, ...forwarded } = parsed
        const invokingContext = context(invocation.sessionID, invocation.toolCallID)
        if (action === "mark_done") {
          const session = await owner.sessionContext?.(invocation.sessionID)
          if (!session) throw new Error("workgraph_ledger mark_done requires Session project context")
          return callWorkGraph(
            createLocalEmbeddedWorkGraphTransport(embedded, () => invokingContext),
            "workgraph_complete_current_work",
            forwarded,
            { session },
          )
        }
        const binding = await embedded.sessionBindings?.readForSession(invokingContext, invocation.sessionID)
        const ownerDirected = action === "create_task" && !binding &&
          (await owner.sessionOwnerDirected?.(invocation.sessionID)) === true
        const actor = ownerDirected
          ? { type: "user" as const, id: owner.ownerUserId as never }
          : invokingContext.actor
        return callWorkGraph(
          createLocalEmbeddedWorkGraphTransport(embedded, () => ({ ...invokingContext, actor })),
          "workgraph_create_task",
          forwarded,
        )
      },
    },
    workgraph_update_stream_notes: {
      description: "Replace the bound Stream master's structured status, learnings, and fenced external references.",
      inputSchema: z.toJSONSchema(notes) as Record<string, unknown>,
      execute: async (value: unknown, invocation: Readonly<{ sessionID: string; toolCallID: string }>) => {
        const parsed = notes.parse(value)
        const toolContext = context(invocation.sessionID, invocation.toolCallID)
        const binding = await requireMasterBinding(toolContext, invocation, "workgraph_update_stream_notes")
        const stream = await embedded.service.queries.streams.read(toolContext, { streamId: binding.streamId })
        if (!stream) throw new Error("workgraph_update_stream_notes could not resolve the bound Stream")
        const result = await embedded.service.execute(toolContext, {
          operationId: `update_stream_notes_${invocation.toolCallID}_${crypto.randomUUID()}` as never,
          command: {
            version: 1,
            type: "update_stream_notes",
            streamId: binding.streamId,
            expectedVersion: stream.version,
            status: parsed.status,
            learnings: parsed.learnings,
            externalReferences: parsed.external_references as never,
          },
        })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
    },
    workgraph_notify_owner: {
      description: "Send an owner-scoped, rate-limited Stream notification and record its durable WorkGraph receipt.",
      inputSchema: z.toJSONSchema(z.strictObject({ message: z.string().trim().min(1).max(4_000) })) as Record<string, unknown>,
      execute: async (value: unknown, invocation: Readonly<{ sessionID: string; toolCallID: string }>) => {
        if (!owner.notifyOwner) throw new Error("Owner channel notification is unavailable")
        const parsed = z.strictObject({ message: z.string().trim().min(1).max(4_000) }).parse(value)
        const toolContext = context(invocation.sessionID, invocation.toolCallID)
        const binding = await requireMasterBinding(toolContext, invocation, "workgraph_notify_owner")
        const operationId = `notify_owner_${invocation.toolCallID}`
        const delivery = await owner.notifyOwner({ idempotencyKey: operationId, text: parsed.message })
        const result = await embedded.service.execute(toolContext, {
          operationId: operationId as never,
          command: {
            version: 1,
            type: "record_evidence",
            subject: { type: "stream", streamId: binding.streamId },
            evidence: {
              kind: "integration",
              summary: `Notified the Stream owner through ${delivery.channel}`,
              effect: "published",
              reference: delivery.reference,
            },
          },
        })
        if (!result.ok) throw new Error(result.error.message)
        return { delivery, receipt: result.value }
      },
    },
    call_master: {
      description: "Send a durable message to the master of the Stream bound to this Session and wake it.",
      inputSchema: z.toJSONSchema(z.strictObject({ message: z.string().trim().min(1).max(10_000) })) as Record<string, unknown>,
      execute: async (value: unknown, invocation: Readonly<{ sessionID: string; toolCallID: string }>) => {
        const parsed = z.strictObject({ message: z.string().trim().min(1).max(10_000) }).parse(value)
        const toolContext = context(invocation.sessionID, invocation.toolCallID)
        const binding = await embedded.sessionBindings.readForSession(toolContext, invocation.sessionID)
        if (!binding || binding.state !== "active") throw new Error("call_master requires an active WorkGraph Session binding")
        const stream = await embedded.service.queries.streams.read(toolContext, { streamId: binding.streamId })
        if (!stream) throw new Error("call_master could not resolve the bound Stream")
        const result = await embedded.service.execute(toolContext, {
          operationId: `call_master_${invocation.toolCallID}_${crypto.randomUUID()}` as never,
          command: {
            version: 1,
            type: "call_master",
            streamId: binding.streamId,
            expectedVersion: stream.version,
            message: parsed.message,
          },
        })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
    },
  }
}

const sessionToolNames = new Set([
  "workgraph_bind_session",
  "workgraph_current_work",
  "workgraph_select_work",
  "workgraph_record_progress",
  "workgraph_refresh_context",
  "workgraph_complete_current_work",
  "workgraph_release_session",
  "call_master",
])

export async function localSessionExecution(
  request: SessionRequestFn,
  sessionId: string,
): Promise<ExecutionProfileDefaults | undefined> {
  const response = await request(new Request(`${SESSION_RUNTIME_BASE}/session/${encodeURIComponent(sessionId)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  }))
  if (!response.ok) throw new Error(`Unable to resolve Session ${sessionId} project context`)
  const session = await response.json() as unknown
  const directory = session && typeof session === "object" &&
    "id" in session && session.id === sessionId &&
    "directory" in session && typeof session.directory === "string"
    ? session.directory.trim()
    : undefined
  if (!directory) return undefined
  return {
    environment: { kind: "local_worktree", placement: "shared", directory },
    repository: { baseRevision: "HEAD" },
  }
}

/** Owner-direction is a positive fact: only a top-level (parentless) interactive
 *  Session speaks for the owner. Subagent children carry `parentID`, and any
 *  lookup failure fails closed to agent authority. */
export async function localSessionOwnerDirected(
  request: SessionRequestFn,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await request(new Request(`${SESSION_RUNTIME_BASE}/session/${encodeURIComponent(sessionId)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    }))
    if (!response.ok) return false
    const session = await response.json() as Record<string, unknown>
    return session.id === sessionId && !session.parentID
  } catch {
    return false
  }
}

export async function localSessionContext(
  request: SessionRequestFn,
  sessionId: string,
): Promise<WorkGraphCreationContext["session"] | undefined> {
  const [sessionResponse, configResponse] = await Promise.all([
    request(new Request(`${SESSION_RUNTIME_BASE}/session/${encodeURIComponent(sessionId)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })),
    request(new Request(`${SESSION_RUNTIME_BASE}/session/${encodeURIComponent(sessionId)}/config`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })),
  ])
  if (!sessionResponse.ok) throw new Error(`Unable to resolve Session ${sessionId} project context`)
  const session = await sessionResponse.json() as Record<string, unknown>
  if (session.id !== sessionId || typeof session.directory !== "string" || !session.directory.trim()) return undefined
  const config = configResponse.ok && configResponse.headers.get("content-type")?.toLowerCase().includes("json")
    ? await configResponse.json() as Record<string, unknown>
    : undefined
  const harness = config?.harness && typeof config.harness === "object"
    ? config.harness as Record<string, unknown>
    : undefined
  const model = config?.model && typeof config.model === "object"
    ? config.model as Record<string, unknown>
    : undefined
  const selectedModel = typeof model?.providerID === "string" && typeof model.modelID === "string"
    ? { providerId: model.providerID, modelId: model.modelID }
    : harness?.id === "pi"
      ? { providerId: "pi", modelId: "virtual" }
      : undefined
  const resolvedExecution = typeof harness?.id === "string" && selectedModel
    ? {
        environment: { kind: "local_worktree" as const, placement: "shared" as const, directory: session.directory.trim() },
        repository: { baseRevision: "HEAD" },
        harness: harness.id,
        agent: typeof config?.agent === "string" && config.agent.trim() ? config.agent : "build",
        model: selectedModel,
        effort: typeof config?.variant === "string" && config.variant.trim() ? config.variant : "medium",
        tools: [],
        connectionIds: [],
      }
    : undefined
  return {
    sessionId,
    projectId: typeof session.projectID === "string" && session.projectID.trim()
      ? session.projectID
      : session.directory.trim(),
    ...(resolvedExecution ? { resolvedExecution } : {}),
  }
}
