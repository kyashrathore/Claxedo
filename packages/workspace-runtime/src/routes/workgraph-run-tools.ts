import { serve } from "@hono/node-server"
import {
  CommandResultSchema,
  WorkGraphBrokerTokenHeader,
  WorkGraphRunOperationRequestSchema,
  WorkGraphRunToolNames,
  WorkGraphRuntimeToolNames,
  type CommandResult,
  type WorkGraphRunOperationRequest,
  type WorkGraphRuntimeToolName,
} from "@claxedo/workgraph/contracts"
import { Hono } from "hono"
import z from "zod/v3"
import { zodToJsonSchema } from "zod-to-json-schema"
import { bearerToken, boundedJsonBody, errorBody } from "./http"

export const WORKGRAPH_RUN_TOOL_NAMES = WorkGraphRunToolNames
export const WORKGRAPH_RUN_BINDING_PATH = "/api/workgraph/run-binding"
export const WORKGRAPH_RUN_TOOL_PATH = "/api/workgraph/run-tools"
const CENTRAL_BROKER_PATH = "/internal/workgraph/run-operation"

const identity = z.strictObject({
  runId: z.string().trim().min(1),
  streamId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  generation: z.number().int().positive(),
})
const binding = z.strictObject({
  version: z.literal(1),
  identity,
  runtimeSessionId: z.string().trim().min(1).optional(),
  harness: z.string().trim().min(1).optional(),
  brokerUrl: z.string().trim().min(1),
  tools: z.array(z.enum(WorkGraphRuntimeToolNames)).min(1).optional(),
})
const evidence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("test_result"), summary: z.string().trim().min(1), passed: z.boolean(), command: z.string().trim().min(1).optional(), outputRef: z.string().trim().min(1).optional() }),
  z.strictObject({ kind: z.literal("artifact"), summary: z.string().trim().min(1), artifactRef: z.string().trim().min(1), mediaType: z.string().trim().min(1).optional() }),
  z.strictObject({ kind: z.literal("review"), summary: z.string().trim().min(1), verdict: z.enum(["approved", "changes_requested"]), reviewer: z.string().trim().min(1).optional() }),
  z.strictObject({ kind: z.literal("integration"), summary: z.string().trim().min(1), effect: z.enum(["merged", "published", "accepted_external_write", "other"]), reference: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal("owner_confirmation"), summary: z.string().trim().min(1), confirmed: z.boolean() }),
  z.strictObject({ kind: z.literal("finding"), summary: z.string().trim().min(1), sourceRef: z.string().trim().min(1).optional() }),
])
const completionEvidence = z.strictObject({
  requirementId: z.string().trim().min(1).optional(),
  evidence,
})

export const WORKGRAPH_RUN_TOOL_INPUT_SCHEMAS = {
  workgraph_report_progress: z.strictObject({
    level: z.enum(["milestone", "progress", "detail"]),
    summary: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(z.string().trim().min(1)).max(100).default([]),
  }),
  workgraph_complete_task: z.strictObject({
    summary: z.string().trim().min(1).max(10_000),
    artifacts: z.array(z.string().trim().min(1)).max(100).default([]),
    evidence: z.array(completionEvidence).min(1).max(100),
  }),
  workgraph_update_stream_notes: z.strictObject({
    status: z.array(z.string().trim().min(1).max(2_000)).max(100),
    learnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
    externalReferences: z.array(z.strictObject({
      source: z.strictObject({
        workSourceId: z.string().trim().min(1),
        revisionId: z.string().trim().min(1),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
      }),
      quote: z.string().trim().min(1).max(20_000),
    })).max(100).default([]),
  }),
  workgraph_notify_owner: z.strictObject({
    message: z.string().trim().min(1).max(4_000),
  }),
} satisfies Record<WorkGraphRuntimeToolName, z.ZodType>

export const WORKGRAPH_RUN_TOOL_SCHEMAS = {
  workgraph_report_progress: {
    description: "Record one meaningful WorkGraph Task checkpoint. Use milestones and logical boundaries, not raw command-by-command logs.",
  },
  workgraph_complete_task: {
    description: "Explicitly finish the current WorkGraph Run with a concise result and evidence for its completion requirements.",
  },
  workgraph_update_stream_notes: {
    description: "Replace the Stream master's structured status, learnings, and fenced external references.",
  },
  workgraph_notify_owner: {
    description: "Send an owner-scoped, rate-limited Stream notification with a durable WorkGraph receipt.",
  },
} as const

export type WorkGraphRunOperationBroker = (
  request: WorkGraphRunOperationRequest,
  signal: AbortSignal,
) => Promise<CommandResult>

export type WorkGraphRunToolRouteHandle = Hono & { dispose(): void }

type BoundRun = z.infer<typeof binding> & { authorization?: string; callbackNonce: string }

export function WorkGraphRunToolRoutes(input: {
  workspaceId: string
  broker?: WorkGraphRunOperationBroker
  brokerOrigin?: string
  /**
   * Only ever called `(url, init)`, so it is typed to that shape rather than
   * `typeof fetch`, whose statics (`preconnect`) a caller supplying a plain
   * function has no reason to provide. The global `fetch` still satisfies it.
   */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
  maxResponseBytes?: number
  registerSessionTools?: (input: {
    sessionId: string
    harness?: string
    callbackUrl: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>
  }) => Promise<void>
  unregisterSessionTools?: (sessionId: string) => Promise<void>
}) {
  const app = new Hono() as WorkGraphRunToolRouteHandle
  const callbacks = new Hono()
  const bindings = new Map<string, BoundRun>()
  const callbackSessions = new Map<string, string>()
  const request = input.fetch ?? fetch
  const brokerOrigin = input.brokerOrigin ? validatedOrigin(input.brokerOrigin) : undefined
  const timeoutMs = Math.max(100, Math.min(60_000, input.timeoutMs ?? 15_000))
  const maxResponseBytes = Math.max(1_024, Math.min(4 * 1024 * 1024, input.maxResponseBytes ?? 1024 * 1024))
  let callbackServer: ReturnType<typeof serve> | undefined
  let callbackOrigin: Promise<string> | undefined
  let disposed = false

  callbacks.post("/callback/:nonce", async (context) => {
    const sessionId = callbackSessions.get(context.req.param("nonce"))
    if (!sessionId) return context.json({ error: "Run tool callback is unavailable" }, 404)
    const bound = bindings.get(sessionId)
    if (!bound) return context.json(errorBody("run_binding_missing", "Session has no Run binding"), 403)
    const body = await boundedJsonBody<Record<string, unknown>>(context, {})
    const names = bound.tools ?? WorkGraphRunToolNames
    const name = typeof body.name === "string" && names.includes(body.name as never)
      ? body.name as WorkGraphRuntimeToolName
      : undefined
    const toolCallId = typeof body.toolCallID === "string" && body.toolCallID.trim() ? body.toolCallID.trim() : undefined
    if (body.sessionID !== (bound.runtimeSessionId ?? sessionId) || !name || !toolCallId) {
      return context.json({ error: "Run tool callback identity is invalid" }, 403)
    }
    const parsed = WORKGRAPH_RUN_TOOL_INPUT_SCHEMAS[name].safeParse(body.input)
    if (!parsed.success) return context.json(errorBody("run_tool_input_invalid", "Run tool input is invalid"), 400)
    const operationId = `run_tool_${bound.identity.runId}_${toolCallId}`
    const operation = name === "workgraph_report_progress"
      ? { type: "record_checkpoint" as const, operationId, ...parsed.data }
      : name === "workgraph_complete_task"
        ? { type: "complete" as const, operationId, ...parsed.data }
        : name === "workgraph_update_stream_notes"
          ? { type: "update_stream_notes" as const, operationId, ...parsed.data }
          : { type: "notify_owner" as const, operationId, ...parsed.data }
    const brokerRequest = WorkGraphRunOperationRequestSchema.parse({
      version: 1,
      identity: bound.identity,
      operation,
    })
    try {
      const signal = AbortSignal.timeout(timeoutMs)
      const response = input.broker
        ? await abortable(input.broker(brokerRequest, signal), signal)
        : await callBroker(request, bound, brokerOrigin, brokerRequest, signal, maxResponseBytes)
      return context.json(CommandResultSchema.parse(response))
    } catch {
      return context.json(errorBody("run_operation_failed", "WorkGraph Run operation failed"), 502)
    }
  })

  app.post(WORKGRAPH_RUN_BINDING_PATH, async (context) => {
    if (disposed) return context.json(errorBody("run_binding_unavailable", "Run binding is unavailable"), 503)
    const parsed = binding.safeParse(await boundedJsonBody(context, {}))
    if (!parsed.success) return context.json(errorBody("run_binding_invalid", "Run binding is invalid"), 400)
    if (parsed.data.identity.workspaceId !== input.workspaceId) {
      return context.json(errorBody("run_binding_workspace_mismatch", "Run binding workspace does not match runtime"), 403)
    }
    let requestedOrigin: string
    try {
      requestedOrigin = validatedOrigin(parsed.data.brokerUrl)
    } catch {
      return context.json(errorBody("run_binding_broker_invalid", "Run broker URL is invalid"), 400)
    }
    const token = context.req.header(WorkGraphBrokerTokenHeader)?.trim() || bearerToken(context.req.header("authorization"))
    if (!input.broker && (!token || !brokerOrigin)) {
      return context.json(errorBody("run_binding_auth_required", "A trusted Run broker is required"), 401)
    }
    if (!input.broker && requestedOrigin !== brokerOrigin) {
      return context.json(errorBody("run_binding_broker_mismatch", "Run broker does not match the trusted central origin"), 403)
    }
    if (!input.registerSessionTools) {
      return context.json(errorBody("run_tool_registration_unavailable", "Core Session tool registration is unavailable"), 503)
    }
    const existing = bindings.get(parsed.data.identity.sessionId)
    if (existing && (
      existing.identity.runId !== parsed.data.identity.runId ||
      existing.identity.workspaceId !== parsed.data.identity.workspaceId ||
      existing.runtimeSessionId !== parsed.data.runtimeSessionId ||
      existing.harness !== parsed.data.harness
    )) return context.json(errorBody("run_binding_conflict", "Session is bound to another Run"), 409)
    const callbackNonce = crypto.randomUUID()
    const next = {
      ...parsed.data,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      callbackNonce,
    }
    bindings.set(parsed.data.identity.sessionId, next)
    callbackSessions.set(callbackNonce, parsed.data.identity.sessionId)
    try {
      await input.registerSessionTools({
        sessionId: parsed.data.runtimeSessionId ?? parsed.data.identity.sessionId,
        ...(parsed.data.harness ? { harness: parsed.data.harness } : {}),
        callbackUrl: `${await localCallbackOrigin()}/callback/${callbackNonce}`,
        tools: (parsed.data.tools ?? WorkGraphRunToolNames).map(toolDefinition),
      })
    } catch (error) {
      callbackSessions.delete(callbackNonce)
      if (existing) bindings.set(parsed.data.identity.sessionId, existing)
      else bindings.delete(parsed.data.identity.sessionId)
      closeCallbackServerIfUnused()
      return context.json(errorBody("run_tool_registration_failed", "Core Session tools could not be registered", {
        reason: error instanceof Error ? error.message : String(error),
      }), 503)
    }
    if (existing) callbackSessions.delete(existing.callbackNonce)
    return context.json({ bound: true, sessionId: parsed.data.identity.sessionId })
  })

  app.delete(`${WORKGRAPH_RUN_BINDING_PATH}/:sessionId`, async (context) => {
    const sessionId = context.req.param("sessionId")
    const existing = bindings.get(sessionId)
    if (!existing) return context.json({ unbound: false })
    await input.unregisterSessionTools?.(existing.runtimeSessionId ?? sessionId)
    bindings.delete(sessionId)
    callbackSessions.delete(existing.callbackNonce)
    closeCallbackServerIfUnused()
    return context.json({ unbound: true })
  })

  app.get(WORKGRAPH_RUN_TOOL_PATH, (context) => context.json({ tools: WORKGRAPH_RUN_TOOL_SCHEMAS }))

  function localCallbackOrigin() {
    if (disposed) return Promise.reject(new Error("Run tool callback is unavailable"))
    return callbackOrigin ??= new Promise<string>((resolve, reject) => {
      callbackServer = serve({ fetch: callbacks.fetch, hostname: "127.0.0.1", port: 0 })
      const ready = () => {
        const address = callbackServer?.address()
        if (!address || typeof address === "string") return reject(new Error("Run callback did not bind"))
        resolve(`http://127.0.0.1:${address.port}`)
      }
      const address = callbackServer.address()
      if (address && typeof address !== "string") ready()
      else callbackServer.once("listening", ready)
    })
  }

  function closeCallbackServerIfUnused() {
    if (bindings.size > 0 || !callbackServer) return
    callbackServer.close()
    callbackServer = undefined
    callbackOrigin = undefined
  }

  app.dispose = () => {
    if (disposed) return
    disposed = true
    bindings.clear()
    callbackSessions.clear()
    callbackServer?.close()
    callbackServer = undefined
    callbackOrigin = undefined
  }
  return app
}

/** The advertised definition derives from the exact schema the callback
 *  validates with — one source of truth per tool. A hand-written mirror here
 *  is how a model gets shown one contract and rejected by another. */
function toolDefinition(name: WorkGraphRuntimeToolName) {
  return {
    name,
    description: WORKGRAPH_RUN_TOOL_SCHEMAS[name].description,
    inputSchema: zodToJsonSchema(WORKGRAPH_RUN_TOOL_INPUT_SCHEMAS[name], { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>,
    outputSchema: { type: "object" },
  }
}

function validatedOrigin(value: string) {
  const url = new URL(value)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Run broker origin is invalid")
  }
  return url.origin
}

async function callBroker(
  request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  binding: BoundRun,
  brokerOrigin: string | undefined,
  body: WorkGraphRunOperationRequest,
  signal: AbortSignal,
  maxResponseBytes: number,
) {
  if (!binding.authorization || !brokerOrigin) throw new Error("Run broker is unavailable")
  const response = await request(`${brokerOrigin}${CENTRAL_BROKER_PATH}`, {
    method: "POST",
    headers: { authorization: binding.authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  const value = await boundedResponseJson(response, maxResponseBytes, signal)
  if (!response.ok) throw new Error(`Run broker failed with status ${response.status}`)
  return CommandResultSchema.parse(value)
}

function abortable<Value>(promise: Promise<Value>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}

async function boundedResponseJson(response: Response, limit: number, signal: AbortSignal) {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > limit) throw new Error("Run broker response is too large")
  if (!response.body) throw new Error("Run broker response is empty")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ""
  for (;;) {
    const chunk = await abortable(reader.read(), signal)
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > limit) {
      await reader.cancel()
      throw new Error("Run broker response is too large")
    }
    body += decoder.decode(chunk.value, { stream: true })
  }
  body += decoder.decode()
  return JSON.parse(body) as unknown
}
