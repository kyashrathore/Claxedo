import { z } from "zod"
import {
  ExecutionProfileDefaultsSchema,
  StreamDtoSchema,
  WorkSourceDtoSchema,
  WorkGraphDefaultsSchema,
  WorkGraphSnapshotPageSchema,
  collectWorkGraphSnapshotPages,
  type SnapshotResumeCursor,
} from "@claxedo/workgraph/contracts"
import { McpHttpError } from "./http-error"

type ToolResult = Readonly<{ content: readonly Readonly<{ type: "text"; text: string }>[]; isError?: boolean }>
type Register = (
  name: string,
  config: Readonly<{ description: string; inputSchema: Record<string, unknown> }>,
  handler: (input: Record<string, unknown>) => Promise<ToolResult>,
) => void
type Request = <Result>(path: string, init?: RequestInit) => Promise<Result>
export type EmbeddedWorkGraphTransport = Readonly<{
  execute(request: Readonly<Record<string, unknown>>): Promise<unknown>
  snapshot(input: Readonly<{ after?: SnapshotResumeCursor; limit: number }>): Promise<unknown>
  readStream(streamId: string): Promise<unknown>
  readDefaults?(): Promise<unknown>
  listSources?(input: Readonly<{ after?: string; limit: number }>): Promise<unknown>
  readSource?(workSourceId: string): Promise<unknown>
  listSourceViews?(): Promise<unknown>
  createSourceView?(input: Readonly<Record<string, unknown>>): Promise<unknown>
  refreshSourceView?(sourceViewId: string): Promise<unknown>
  listIntake?(sourceViewId?: string): Promise<unknown>
  stageCandidate?(candidateId: string): Promise<unknown>
  syncCandidate?(candidateId: string, input: Readonly<{ idempotencyKey: string; summary: string; status?: string }>): Promise<unknown>
}>
type WorkGraphTransport = Request | EmbeddedWorkGraphTransport

export class WorkGraphRecordNotFoundError extends Error {
  readonly code = "not_found"
  readonly status = 404

  constructor(
    readonly recordType: string,
    readonly recordId: string,
  ) {
    super(`WorkGraph ${recordType} '${recordId}' was not found`)
    this.name = "WorkGraphRecordNotFoundError"
  }
}

const operation = { operation_id: z.string().describe("Unique idempotency key for this mutation.") }
const sourceRef = {
  work_source_id: z.string(),
  revision_id: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/i),
}

export const WORKGRAPH_CAPABILITY_MAP = [
  { uiAction: "Read personal WorkGraph defaults", tool: "workgraph_get_defaults", mutating: false },
  { uiAction: "Update personal WorkGraph defaults", tool: "workgraph_update_defaults", mutating: true },
  { uiAction: "List or inspect WorkGraph", tool: "workgraph_list", mutating: false },
  { uiAction: "Get a WorkGraph record", tool: "workgraph_get", mutating: false },
  { uiAction: "Create or revise a Work Source", tool: "workgraph_source", mutating: true },
  { uiAction: "Create a Stream", tool: "workgraph_create_stream", mutating: true },
  { uiAction: "Create an Outcome or Work Item", tool: "workgraph_create_work", mutating: true },
  { uiAction: "Propose source admission", tool: "workgraph_propose_admission", mutating: true },
  { uiAction: "Confirm source admission", tool: "workgraph_admit", mutating: true },
  { uiAction: "List personal issue Source Views", tool: "workgraph_source_views", mutating: false },
  { uiAction: "Configure a personal issue Source View", tool: "workgraph_configure_source_view", mutating: true },
  { uiAction: "Refresh a personal issue Source View", tool: "workgraph_refresh_source_view", mutating: true },
  { uiAction: "List external intake candidates", tool: "workgraph_intake", mutating: false },
  { uiAction: "Stage an intake candidate and create its bounded admission proposal", tool: "workgraph_stage_candidate", mutating: true },
  { uiAction: "Announce a meaningful result through its Connection", tool: "workgraph_sync_candidate", mutating: true },
  { uiAction: "Execute work", tool: "workgraph_execute", mutating: true },
  { uiAction: "Update Stream execution defaults", tool: "workgraph_update_execution", mutating: true },
  { uiAction: "Retry a Work Item", tool: "workgraph_retry", mutating: true },
  { uiAction: "Pause a Stream", tool: "workgraph_pause", mutating: true },
  { uiAction: "Cancel an Attempt", tool: "workgraph_cancel", mutating: true },
  { uiAction: "Record a finding", tool: "workgraph_record_finding", mutating: true },
  { uiAction: "Create follow-up work", tool: "workgraph_create_followup", mutating: true },
  { uiAction: "Propose or answer a Decision", tool: "workgraph_decision", mutating: true },
  { uiAction: "Record evidence", tool: "workgraph_record_evidence", mutating: true },
  { uiAction: "Read a Recap", tool: "workgraph_recap", mutating: false },
  { uiAction: "Close a Stream or Outcome", tool: "workgraph_close", mutating: true },
  { uiAction: "Delete an eligible Stream", tool: "workgraph_delete", mutating: true },
] as const

export const WORKGRAPH_TOOL_SCHEMAS = {
  workgraph_get_defaults: {},
  workgraph_update_defaults: { ...operation, expected_version: z.number().int().positive(), defaults: WorkGraphDefaultsSchema },
  workgraph_list: { kind: z.enum(["streams", "sources", "work", "decisions", "recaps"]), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  workgraph_get: { record_type: z.enum(["source", "stream", "outcome", "work_item", "attempt", "decision", "recap", "proposal"]), id: z.string() },
  workgraph_source: { ...operation, action: z.enum(["create", "revise"]), title: z.string().optional(), content: z.string(), work_source_id: z.string().optional(), expected_revision_id: z.string().optional() },
  workgraph_create_stream: { ...operation, title: z.string(), description: z.string().optional(), source: z.object(sourceRef).optional() },
  workgraph_create_work: { ...operation, kind: z.enum(["outcome", "work_item"]), stream_id: z.string(), title: z.string(), description: z.string().optional(), outcome_id: z.string().optional(), success_criteria: z.array(z.string()).optional(), completion_contract: z.record(z.string(), z.unknown()).optional() },
  workgraph_propose_admission: { ...operation, source: z.object(sourceRef), target_stream_id: z.string().optional() },
  workgraph_admit: { ...operation, proposal_id: z.string(), expected_version: z.number().int().positive(), source: z.object(sourceRef), disposition: z.enum(["create", "existing", "keep", "replace", "fork"]), stream_id: z.string().optional(), stream_title: z.string().optional(), outcomes: z.array(z.record(z.string(), z.unknown())).optional(), work_items: z.array(z.record(z.string(), z.unknown())).optional() },
  workgraph_source_views: {},
  workgraph_configure_source_view: { team_connection_id: z.string(), provider: z.enum(["github", "linear", "jira"]), provider_user_id: z.string(), filters: z.record(z.string(), z.string()).optional(), sync_policy: z.enum(["silent", "announce", "full"]).optional() },
  workgraph_refresh_source_view: { source_view_id: z.string() },
  workgraph_intake: { source_view_id: z.string().optional() },
  workgraph_stage_candidate: { candidate_id: z.string() },
  workgraph_sync_candidate: { candidate_id: z.string(), idempotency_key: z.string(), summary: z.string(), status: z.string().optional() },
  workgraph_execute: { ...operation, target_type: z.enum(["stream", "work_item"]), target_id: z.string(), mode: z.enum(["autonomous", "supervised"]).optional() },
  workgraph_update_execution: { ...operation, stream_id: z.string(), expected_version: z.number().int().positive(), execution: ExecutionProfileDefaultsSchema },
  workgraph_retry: { ...operation, work_item_id: z.string(), expected_version: z.number().int().positive() },
  workgraph_pause: { ...operation, stream_id: z.string(), expected_version: z.number().int().positive(), reason: z.string() },
  workgraph_cancel: { ...operation, attempt_id: z.string(), expected_version: z.number().int().positive(), reason: z.string() },
  workgraph_record_finding: { ...operation, subject: z.record(z.string(), z.unknown()), summary: z.string(), source_ref: z.string().optional(), source_attempt_id: z.string().optional() },
  workgraph_create_followup: { ...operation, stream_id: z.string(), title: z.string(), description: z.string().optional(), outcome_id: z.string().optional(), completion_contract: z.record(z.string(), z.unknown()) },
  workgraph_decision: { ...operation, action: z.enum(["propose", "answer", "dismiss"]), decision_id: z.string().optional(), stream_id: z.string().optional(), expected_version: z.number().int().positive().optional(), question: z.string().optional(), options: z.array(z.record(z.string(), z.unknown())).optional(), affected_work_item_ids: z.array(z.string()).optional(), answer: z.string().optional(), option_id: z.string().optional(), reason: z.string().optional() },
  workgraph_record_evidence: { ...operation, subject: z.record(z.string(), z.unknown()), requirement_id: z.string().optional(), source_attempt_id: z.string().optional(), evidence: z.record(z.string(), z.unknown()) },
  workgraph_recap: { action: z.literal("get").optional(), stream_id: z.string(), recap_id: z.string().optional() },
  workgraph_close: { ...operation, target_type: z.enum(["stream", "outcome"]), target_id: z.string(), expected_version: z.number().int().positive(), reason: z.string() },
  workgraph_delete: { ...operation, stream_id: z.string(), expected_version: z.number().int().positive(), reason: z.string() },
} satisfies Record<(typeof WORKGRAPH_CAPABILITY_MAP)[number]["tool"], Record<string, z.ZodType>>

export function registerWorkGraphTools(register: Register, transport: WorkGraphTransport, readOnly: boolean) {
  WORKGRAPH_CAPABILITY_MAP
    .filter((capability) => !readOnly || !capability.mutating)
    .filter((capability) => typeof transport === "function" || embeddedSupports(transport, capability.tool))
    .forEach((capability) => register(
      capability.tool,
      { description: `[WorkGraph] ${capability.uiAction}. The authenticated caller selects the owner; results include the same record and change cursor used by the app.`, inputSchema: WORKGRAPH_TOOL_SCHEMAS[capability.tool] },
      async (input) => {
        try {
          return text(await callWorkGraph(transport, capability.tool, input))
        } catch (error) {
          if (error instanceof WorkGraphRecordNotFoundError) {
            return text({
              error: {
                code: error.code,
                status: error.status,
                message: error.message,
                recordType: error.recordType,
                recordId: error.recordId,
              },
            }, true)
          }
          if (error instanceof McpHttpError) {
            return text({
              error: {
                ...(error.code ? { code: error.code } : {}),
                status: error.status,
                message: "WorkGraph request failed",
                ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
              },
            }, true)
          }
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      },
    ))
}

export async function callWorkGraph(transport: WorkGraphTransport, tool: keyof typeof WORKGRAPH_TOOL_SCHEMAS, input: Record<string, unknown>) {
  if (tool === "workgraph_get_defaults") {
    if (typeof transport !== "function") return requiredMethod(transport.readDefaults, tool)()
    return transport("/api/workgraph/defaults", { method: "GET" })
  }
  if (tool === "workgraph_source_views") {
    if (typeof transport !== "function") return requiredMethod(transport.listSourceViews, tool)()
    return transport("/api/workgraph/source-views", { method: "GET" })
  }
  if (tool === "workgraph_configure_source_view") {
    const value = {
      teamConnectionId: requiredString(input, "team_connection_id"),
      provider: requiredString(input, "provider"),
      providerUserId: requiredString(input, "provider_user_id"),
      filters: input.filters ?? {},
      syncPolicy: input.sync_policy ?? "silent",
    }
    if (typeof transport !== "function") return requiredMethod(transport.createSourceView, tool)(value)
    return transport("/api/workgraph/source-views", { method: "POST", body: JSON.stringify(value) })
  }
  if (tool === "workgraph_refresh_source_view") {
    const id = requiredString(input, "source_view_id")
    if (typeof transport !== "function") return requiredMethod(transport.refreshSourceView, tool)(id)
    return transport(`/api/workgraph/source-views/${encodeURIComponent(id)}/refresh`, { method: "POST", body: "{}" })
  }
  if (tool === "workgraph_intake") {
    const id = typeof input.source_view_id === "string" ? input.source_view_id : undefined
    if (typeof transport !== "function") return requiredMethod(transport.listIntake, tool)(id)
    return transport(`/api/workgraph/intake${id ? `?sourceViewId=${encodeURIComponent(id)}` : ""}`, { method: "GET" })
  }
  if (tool === "workgraph_stage_candidate") {
    const id = requiredString(input, "candidate_id")
    if (typeof transport !== "function") return requiredMethod(transport.stageCandidate, tool)(id)
    return transport(`/api/workgraph/intake/${encodeURIComponent(id)}/stage`, { method: "POST", body: "{}" })
  }
  if (tool === "workgraph_sync_candidate") {
    const id = requiredString(input, "candidate_id")
    const value = { idempotencyKey: requiredString(input, "idempotency_key"), summary: requiredString(input, "summary"), ...(typeof input.status === "string" ? { status: input.status } : {}) }
    if (typeof transport !== "function") return requiredMethod(transport.syncCandidate, tool)(id, value)
    return transport(`/api/workgraph/intake/${encodeURIComponent(id)}/sync`, { method: "POST", body: JSON.stringify(value) })
  }
  if (tool === "workgraph_list") {
    if (input.kind === "sources") {
      if (typeof transport !== "function") {
        if (!transport.listSources) throw new Error("Embedded WorkGraph transport does not expose Work Sources")
        return transport.listSources({
          ...(typeof input.cursor === "string" ? { after: input.cursor } : {}),
          limit: typeof input.limit === "number" ? input.limit : 50,
        })
      }
      const query = new URLSearchParams()
      if (typeof input.cursor === "string") query.set("after", input.cursor)
      if (typeof input.limit === "number") query.set("limit", String(input.limit))
      return transport(`/api/workgraph/sources${query.size ? `?${query}` : ""}`, { method: "GET" })
    }
    return readSnapshot(transport, 100)
  }
  if (tool === "workgraph_get" && input.record_type === "stream") {
    const streamId = requiredString(input, "id")
    const stream = await (typeof transport !== "function"
      ? transport.readStream(streamId)
      : transport(`/api/workgraph/streams/${encodeURIComponent(streamId)}`, { method: "GET" }))
      .catch((error) => readError(error, "stream", streamId))
    if (stream === undefined || stream === null) throw new WorkGraphRecordNotFoundError("stream", streamId)
    return StreamDtoSchema.parse(stream)
  }
  if (tool === "workgraph_get" && input.record_type === "source") {
    const workSourceId = requiredString(input, "id")
    let source: unknown
    if (typeof transport !== "function") {
      if (!transport.readSource) throw new Error("Embedded WorkGraph transport does not expose Work Sources")
      source = await transport.readSource(workSourceId).catch((error) => readError(error, "source", workSourceId))
    } else {
      source = await transport(`/api/workgraph/sources/${encodeURIComponent(workSourceId)}`, { method: "GET" })
        .catch((error) => readError(error, "source", workSourceId))
    }
    if (source === undefined || source === null) throw new WorkGraphRecordNotFoundError("source", workSourceId)
    return WorkSourceDtoSchema.parse(source)
  }
  if (tool === "workgraph_get" || tool === "workgraph_recap") {
    const snapshot = await readSnapshot(transport, 100)
    const record = tool === "workgraph_recap"
      ? requestedRecap(snapshot.records, requiredString(input, "stream_id"), typeof input.recap_id === "string" ? input.recap_id : undefined)
      : requestedRecord(snapshot.records, requiredString(input, "record_type"), requiredString(input, "id"))
    const referenceType = record.recordType === "admission_proposal" ? "admission_proposal" : record.recordType
    return {
      ...snapshot,
      records: [record],
      references: snapshot.references.filter((reference) =>
        reference.resource.type === referenceType && reference.resource.id === record.id),
    }
  }
  const command = toCommandRequest(tool, input)
  if (typeof transport !== "function") return transport.execute(command)
  return transport("/api/workgraph/commands", {
    method: "POST",
    body: JSON.stringify(command),
  })
}

function readError(error: unknown, recordType: string, recordId: string): never {
  if (error && typeof error === "object" && "status" in error && error.status === 404 &&
    (!("code" in error) || error.code === undefined || error.code === "not_found")) {
    throw new WorkGraphRecordNotFoundError(recordType, recordId)
  }
  throw error
}

function requestedRecord(records: Awaited<ReturnType<typeof readSnapshot>>["records"], type: string, id: string) {
  const recordType = type === "proposal" ? "admission_proposal" : type
  const record = records.find((value) => value.recordType === recordType && value.id === id)
  if (record) return record
  throw new WorkGraphRecordNotFoundError(type, id)
}

function requestedRecap(records: Awaited<ReturnType<typeof readSnapshot>>["records"], streamId: string, recapId?: string) {
  const recaps = records.filter((record): record is Extract<(typeof records)[number], { recordType: "recap" }> =>
    record.recordType === "recap" && record.streamId === streamId)
  const recap = recapId
    ? recaps.find((record) => record.id === recapId)
    : recaps
      .filter((record) => record.generation.state === "succeeded")
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]
  if (recap) return recap
  throw new WorkGraphRecordNotFoundError("recap", recapId ?? streamId)
}

function readSnapshot(transport: WorkGraphTransport, limit: number) {
  return collectWorkGraphSnapshotPages({
    page: async (after) => {
      const value = typeof transport === "function"
        ? await transport(`/api/workgraph/snapshot?${snapshotQuery(limit, after)}`, { method: "GET" })
        : await transport.snapshot({ ...(after ? { after } : {}), limit })
      return WorkGraphSnapshotPageSchema.parse(value)
    },
    isCursorInvalid: (error) => {
      if (error instanceof Error && error.message.includes("cursor_invalid")) return true
      if (!error || typeof error !== "object") return false
      if ("code" in error && error.code === "cursor_invalid") return true
      return "kind" in error && error.kind === "cursor_invalid"
    },
  })
}

function snapshotQuery(limit: number, after?: SnapshotResumeCursor) {
  const query = new URLSearchParams({ limit: String(limit) })
  if (after) query.set("after", after)
  return query
}

function requiredMethod<Method>(method: Method | undefined, tool: string): NonNullable<Method> {
  if (!method) throw new Error(`Embedded WorkGraph transport does not expose ${tool}`)
  return method as NonNullable<Method>
}

function embeddedSupports(transport: EmbeddedWorkGraphTransport, tool: keyof typeof WORKGRAPH_TOOL_SCHEMAS) {
  const methods: Partial<Record<keyof typeof WORKGRAPH_TOOL_SCHEMAS, keyof EmbeddedWorkGraphTransport>> = {
    workgraph_get_defaults: "readDefaults",
    workgraph_source_views: "listSourceViews",
    workgraph_configure_source_view: "createSourceView",
    workgraph_refresh_source_view: "refreshSourceView",
    workgraph_intake: "listIntake",
    workgraph_stage_candidate: "stageCandidate",
    workgraph_sync_candidate: "syncCandidate",
  }
  const method = methods[tool]
  return !method || typeof transport[method] === "function"
}

export function toCommandRequest(tool: keyof typeof WORKGRAPH_TOOL_SCHEMAS, input: Record<string, unknown>) {
  const operationId = requiredString(input, "operation_id")
  if (tool === "workgraph_update_defaults") return command(operationId, {
    type: "update_workgraph_defaults",
    expectedVersion: input.expected_version,
    defaults: input.defaults,
  })
  if (tool === "workgraph_source") {
    const action = requiredString(input, "action")
    return command(operationId, action === "create" ? {
      type: "create_work_source",
      title: requiredString(input, "title"),
      content: requiredString(input, "content"),
    } : {
      type: "revise_work_source",
      workSourceId: requiredString(input, "work_source_id"),
      expectedRevisionId: requiredString(input, "expected_revision_id"),
      ...(typeof input.title === "string" ? { title: input.title } : {}),
      content: requiredString(input, "content"),
    })
  }
  if (tool === "workgraph_create_stream") return command(operationId, {
    type: "create_stream",
    title: requiredString(input, "title"),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(input.source ? { source: camelSource(input.source) } : {}),
  })
  if (tool === "workgraph_create_work" || tool === "workgraph_create_followup") {
    const kind = tool === "workgraph_create_followup" ? "work_item" : requiredString(input, "kind")
    if (kind === "outcome") return command(operationId, {
      type: "create_outcome",
      streamId: requiredString(input, "stream_id"),
      title: requiredString(input, "title"),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      successCriteria: input.success_criteria,
    })
    return command(operationId, {
      type: "create_work_item",
      streamId: requiredString(input, "stream_id"),
      ...(typeof input.outcome_id === "string" ? { outcomeId: input.outcome_id } : {}),
      title: requiredString(input, "title"),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      completionContract: input.completion_contract,
    })
  }
  if (tool === "workgraph_propose_admission") return command(operationId, {
    type: "propose_admission",
    source: camelSource(input.source),
    ...(typeof input.target_stream_id === "string" ? { targetStreamId: input.target_stream_id } : {}),
  })
  if (tool === "workgraph_admit") return command(operationId, {
    type: "confirm_admission",
    proposalId: requiredString(input, "proposal_id"),
    expectedVersion: input.expected_version,
    source: camelSource(input.source),
    selection: admissionSelection(input),
    ...(input.outcomes ? { outcomes: input.outcomes } : {}),
    ...(input.work_items ? { workItems: input.work_items } : {}),
  })
  if (tool === "workgraph_execute") return command(operationId, input.target_type === "stream" ? {
    type: "execute_stream",
    streamId: requiredString(input, "target_id"),
    executionMode: input.mode ?? "autonomous",
  } : {
    type: "execute_work_item",
    workItemId: requiredString(input, "target_id"),
    executionMode: input.mode ?? "autonomous",
  })
  if (tool === "workgraph_update_execution") return command(operationId, {
    type: "update_stream",
    streamId: requiredString(input, "stream_id"),
    expectedVersion: input.expected_version,
    execution: input.execution,
  })
  if (tool === "workgraph_retry") return command(operationId, {
    type: "retry_work_item",
    workItemId: requiredString(input, "work_item_id"),
    expectedVersion: input.expected_version,
  })
  if (tool === "workgraph_pause") return command(operationId, {
    type: "set_stream_lifecycle",
    streamId: requiredString(input, "stream_id"),
    expectedVersion: input.expected_version,
    state: "paused",
    reason: requiredString(input, "reason"),
  })
  if (tool === "workgraph_cancel") return command(operationId, {
    type: "cancel_attempt",
    attemptId: requiredString(input, "attempt_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
  if (tool === "workgraph_record_finding" || tool === "workgraph_record_evidence") return command(operationId, {
    type: "record_evidence",
    subject: input.subject,
    ...(typeof input.requirement_id === "string" ? { requirementId: input.requirement_id } : {}),
    ...(typeof input.source_attempt_id === "string" ? { sourceAttemptId: input.source_attempt_id } : {}),
    evidence: tool === "workgraph_record_finding"
      ? { kind: "finding", summary: requiredString(input, "summary"), ...(typeof input.source_ref === "string" ? { sourceRef: input.source_ref } : {}) }
      : input.evidence,
  })
  if (tool === "workgraph_decision") return decisionCommand(operationId, input)
  if (tool === "workgraph_close") return command(operationId, input.target_type === "stream" ? {
    type: "close_stream",
    streamId: requiredString(input, "target_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  } : {
    type: "close_outcome",
    outcomeId: requiredString(input, "target_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
  if (tool === "workgraph_delete") return command(operationId, {
    type: "delete_stream",
    streamId: requiredString(input, "stream_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
  throw new Error(`WorkGraph tool '${tool}' is not a mutation`)
}

function command(operationId: string, value: Readonly<Record<string, unknown>>) {
  return { operationId, command: { version: 1, ...value } }
}

function camelSource(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("source is required")
  const source = value as Record<string, unknown>
  return { workSourceId: requiredString(source, "work_source_id"), revisionId: requiredString(source, "revision_id"), contentHash: requiredString(source, "content_hash") }
}

function admissionSelection(input: Record<string, unknown>) {
  const mode = requiredString(input, "disposition")
  if (mode === "create") return { mode, streamTitle: requiredString(input, "stream_title") }
  if (mode === "fork") return { mode, streamId: requiredString(input, "stream_id"), streamTitle: requiredString(input, "stream_title") }
  return { mode, streamId: requiredString(input, "stream_id") }
}

function decisionCommand(operationId: string, input: Record<string, unknown>) {
  const action = requiredString(input, "action")
  if (action === "propose") return command(operationId, {
    type: "propose_decision",
    streamId: requiredString(input, "stream_id"),
    question: requiredString(input, "question"),
    options: input.options,
    affectedWorkItemIds: input.affected_work_item_ids,
  })
  if (action === "answer") return command(operationId, {
    type: "answer_decision",
    decisionId: requiredString(input, "decision_id"),
    expectedVersion: input.expected_version,
    ...(typeof input.option_id === "string" ? { optionId: input.option_id } : {}),
    ...(typeof input.answer === "string" ? { answer: input.answer } : {}),
  })
  return command(operationId, {
    type: "dismiss_decision",
    decisionId: requiredString(input, "decision_id"),
    expectedVersion: input.expected_version,
    reason: requiredString(input, "reason"),
  })
}

function requiredString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`)
  return value
}

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) }
}
