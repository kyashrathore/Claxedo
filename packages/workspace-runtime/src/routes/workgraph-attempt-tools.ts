import { serve } from "@hono/node-server"
import {
  CommandResultSchema,
  WorkGraphAttemptOperationRequestSchema,
  WorkGraphAttemptToolNames,
  type CommandResult,
  type WorkGraphAttemptOperationRequest,
  type WorkGraphAttemptToolName,
} from "@claxedo/workgraph/contracts"
import { Hono } from "hono"
import z from "zod/v3"
import { bearerToken, boundedJsonBody, errorBody } from "./http"

export const WORKGRAPH_ATTEMPT_TOOL_NAMES = WorkGraphAttemptToolNames
export const WORKGRAPH_ATTEMPT_BINDING_PATH = "/api/workgraph/attempt-binding"
export const WORKGRAPH_ATTEMPT_TOOL_PATH = "/api/workgraph/attempt-tools"
const CENTRAL_BROKER_PATH = "/internal/workgraph/attempt-operation"

const identity = z.strictObject({
  attemptId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  leaseEpoch: z.number().int().positive().optional(),
})
const binding = z.strictObject({
  version: z.literal(1),
  identity,
  runtimeSessionId: z.string().trim().min(1).optional(),
  harness: z.string().trim().min(1).optional(),
  brokerUrl: z.string().trim().min(1),
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

export const WORKGRAPH_ATTEMPT_TOOL_INPUT_SCHEMAS = {
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
} satisfies Record<WorkGraphAttemptToolName, z.ZodType>

export const WORKGRAPH_ATTEMPT_TOOL_SCHEMAS = {
  workgraph_report_progress: {
    description: "Record one meaningful WorkGraph Task checkpoint. Use milestones and logical boundaries, not raw command-by-command logs.",
  },
  workgraph_complete_task: {
    description: "Explicitly finish the current WorkGraph Attempt with a concise result and evidence for its completion requirements.",
  },
} as const

export type WorkGraphAttemptOperationBroker = (
  request: WorkGraphAttemptOperationRequest,
  signal: AbortSignal,
) => Promise<CommandResult>

export type WorkGraphAttemptToolRouteHandle = Hono & { dispose(): void }

type BoundAttempt = z.infer<typeof binding> & { authorization?: string; callbackNonce: string }

export function WorkGraphAttemptToolRoutes(input: {
  workspaceId: string
  broker?: WorkGraphAttemptOperationBroker
  brokerOrigin?: string
  fetch?: typeof fetch
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
  const app = new Hono() as WorkGraphAttemptToolRouteHandle
  const callbacks = new Hono()
  const bindings = new Map<string, BoundAttempt>()
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
    if (!sessionId) return context.json({ error: "Attempt tool callback is unavailable" }, 404)
    const bound = bindings.get(sessionId)
    if (!bound) return context.json(errorBody("attempt_binding_missing", "Session has no Attempt binding"), 403)
    const body = await boundedJsonBody<Record<string, unknown>>(context, {})
    const name = typeof body.name === "string" && WORKGRAPH_ATTEMPT_TOOL_NAMES.includes(body.name as WorkGraphAttemptToolName)
      ? body.name as WorkGraphAttemptToolName
      : undefined
    const toolCallId = typeof body.toolCallID === "string" && body.toolCallID.trim() ? body.toolCallID.trim() : undefined
    if (body.sessionID !== (bound.runtimeSessionId ?? sessionId) || !name || !toolCallId) {
      return context.json({ error: "Attempt tool callback identity is invalid" }, 403)
    }
    const parsed = WORKGRAPH_ATTEMPT_TOOL_INPUT_SCHEMAS[name].safeParse(body.input)
    if (!parsed.success) return context.json(errorBody("attempt_tool_input_invalid", "Attempt tool input is invalid"), 400)
    const operationId = `attempt_tool_${bound.identity.attemptId}_${toolCallId}`
    const operation = name === "workgraph_report_progress"
      ? { type: "record_checkpoint" as const, operationId, ...parsed.data }
      : { type: "complete" as const, operationId, ...parsed.data }
    const brokerRequest = WorkGraphAttemptOperationRequestSchema.parse({
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
      return context.json(errorBody("attempt_operation_failed", "WorkGraph Attempt operation failed"), 502)
    }
  })

  app.post(WORKGRAPH_ATTEMPT_BINDING_PATH, async (context) => {
    if (disposed) return context.json(errorBody("attempt_binding_unavailable", "Attempt binding is unavailable"), 503)
    const parsed = binding.safeParse(await boundedJsonBody(context, {}))
    if (!parsed.success) return context.json(errorBody("attempt_binding_invalid", "Attempt binding is invalid"), 400)
    if (parsed.data.identity.workspaceId !== input.workspaceId) {
      return context.json(errorBody("attempt_binding_workspace_mismatch", "Attempt binding workspace does not match runtime"), 403)
    }
    let requestedOrigin: string
    try {
      requestedOrigin = validatedOrigin(parsed.data.brokerUrl)
    } catch {
      return context.json(errorBody("attempt_binding_broker_invalid", "Attempt broker URL is invalid"), 400)
    }
    const token = bearerToken(context.req.header("authorization"))
    if (!input.broker && (!token || !brokerOrigin)) {
      return context.json(errorBody("attempt_binding_auth_required", "A trusted Attempt broker is required"), 401)
    }
    if (!input.broker && requestedOrigin !== brokerOrigin) {
      return context.json(errorBody("attempt_binding_broker_mismatch", "Attempt broker does not match the trusted central origin"), 403)
    }
    if (!input.registerSessionTools) {
      return context.json(errorBody("attempt_tool_registration_unavailable", "Core Session tool registration is unavailable"), 503)
    }
    const existing = bindings.get(parsed.data.identity.sessionId)
    if (existing && (
      existing.identity.attemptId !== parsed.data.identity.attemptId ||
      existing.identity.workspaceId !== parsed.data.identity.workspaceId ||
      existing.runtimeSessionId !== parsed.data.runtimeSessionId ||
      existing.harness !== parsed.data.harness
    )) return context.json(errorBody("attempt_binding_conflict", "Session is bound to another Attempt"), 409)
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
        tools: WORKGRAPH_ATTEMPT_TOOL_NAMES.map(toolDefinition),
      })
    } catch {
      callbackSessions.delete(callbackNonce)
      if (existing) bindings.set(parsed.data.identity.sessionId, existing)
      else bindings.delete(parsed.data.identity.sessionId)
      closeCallbackServerIfUnused()
      return context.json(errorBody("attempt_tool_registration_failed", "Core Session tools could not be registered"), 503)
    }
    if (existing) callbackSessions.delete(existing.callbackNonce)
    return context.json({ bound: true, sessionId: parsed.data.identity.sessionId })
  })

  app.delete(`${WORKGRAPH_ATTEMPT_BINDING_PATH}/:sessionId`, async (context) => {
    const sessionId = context.req.param("sessionId")
    const existing = bindings.get(sessionId)
    if (!existing) return context.json({ unbound: false })
    await input.unregisterSessionTools?.(existing.runtimeSessionId ?? sessionId)
    bindings.delete(sessionId)
    callbackSessions.delete(existing.callbackNonce)
    closeCallbackServerIfUnused()
    return context.json({ unbound: true })
  })

  app.get(WORKGRAPH_ATTEMPT_TOOL_PATH, (context) => context.json({ tools: WORKGRAPH_ATTEMPT_TOOL_SCHEMAS }))

  function localCallbackOrigin() {
    if (disposed) return Promise.reject(new Error("Attempt tool callback is unavailable"))
    return callbackOrigin ??= new Promise<string>((resolve, reject) => {
      callbackServer = serve({ fetch: callbacks.fetch, hostname: "127.0.0.1", port: 0 })
      const ready = () => {
        const address = callbackServer?.address()
        if (!address || typeof address === "string") return reject(new Error("Attempt callback did not bind"))
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

function toolDefinition(name: WorkGraphAttemptToolName) {
  if (name === "workgraph_report_progress") return {
    name,
    description: WORKGRAPH_ATTEMPT_TOOL_SCHEMAS[name].description,
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["milestone", "progress", "detail"] },
        summary: { type: "string" },
        evidenceIds: { type: "array", items: { type: "string" } },
      },
      required: ["level", "summary"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
  }
  return {
    name,
    description: WORKGRAPH_ATTEMPT_TOOL_SCHEMAS[name].description,
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        artifacts: { type: "array", items: { type: "string" } },
        evidence: { type: "array", minItems: 1, items: { type: "object" } },
      },
      required: ["summary", "evidence"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
  }
}

function validatedOrigin(value: string) {
  const url = new URL(value)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Attempt broker origin is invalid")
  }
  return url.origin
}

async function callBroker(
  request: typeof fetch,
  binding: BoundAttempt,
  brokerOrigin: string | undefined,
  body: WorkGraphAttemptOperationRequest,
  signal: AbortSignal,
  maxResponseBytes: number,
) {
  if (!binding.authorization || !brokerOrigin) throw new Error("Attempt broker is unavailable")
  const response = await request(`${brokerOrigin}${CENTRAL_BROKER_PATH}`, {
    method: "POST",
    headers: { authorization: binding.authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  const value = await boundedResponseJson(response, maxResponseBytes, signal)
  if (!response.ok) throw new Error(`Attempt broker failed with status ${response.status}`)
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
  if (declared !== null && Number(declared) > limit) throw new Error("Attempt broker response is too large")
  if (!response.body) throw new Error("Attempt broker response is empty")
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
      throw new Error("Attempt broker response is too large")
    }
    body += decoder.decode(chunk.value, { stream: true })
  }
  body += decoder.decode()
  return JSON.parse(body) as unknown
}
