import { Hono } from "hono"
import { serve } from "@hono/node-server"
import z from "zod/v3"
import {
  WorkGraphBrokerTokenHeader,
  WorkGraphConnectionOperationRequestSchema,
  WorkGraphConnectionOperationResponseSchema,
  WorkGraphConnectionToolNames,
  type WorkGraphConnectionOperationRequest,
  type WorkGraphConnectionOperationResponse,
  type WorkGraphConnectionToolName,
} from "@claxedo/workgraph/contracts"
import { bearerToken, boundedJsonBody, errorBody } from "./http"

export const WORKGRAPH_CONNECTION_TOOL_NAMES = WorkGraphConnectionToolNames
export {
  WorkGraphConnectionOperationRequestSchema,
  WorkGraphConnectionOperationResponseSchema,
}
export type {
  WorkGraphConnectionOperationRequest,
  WorkGraphConnectionOperationResponse,
  WorkGraphConnectionToolName,
}

const bindingIdentity = z.object({
  attemptId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict()

const filters = z.record(z.string())

const bind = z.object({
  version: z.literal(1),
  identity: bindingIdentity,
  connectionIds: z.array(z.string().min(1)).min(1),
  tools: z.array(z.enum(WORKGRAPH_CONNECTION_TOOL_NAMES)).min(1),
  brokerUrl: z.string().min(1),
}).strict()

const centralBrokerErrorCode = z.enum([
  "connection_operation_invalid_request",
  "invalid_relay_token",
  "relay_token_workspace_mismatch",
  "relay_token_host_mismatch",
  "relay_token_claims_invalid",
  "runtime_access_token_verification_unavailable",
  "connection_operation_denied",
  "hosted_connection_reconnect_required",
  "hosted_connection_credential_unavailable",
  "connection_exists",
  "connection_verify_failed",
  "connection_not_available",
  "connection_refresh_transient",
  "connections_unavailable",
  "connection_provider_unauthorized",
  "connection_provider_invalid_response",
  "connection_provider_unavailable",
  "connection_provider_rate_limited",
  "connection_provider_rejected",
  "connection_operation_failed",
])
const centralBrokerErrorMessage = {
  connection_operation_invalid_request: "Connection operation request is invalid",
  invalid_relay_token: "Runtime access token is invalid",
  relay_token_workspace_mismatch: "Runtime access token is not authorized for this workspace",
  relay_token_host_mismatch: "Runtime access token is not authorized for this workspace",
  relay_token_claims_invalid: "Runtime access token is invalid",
  runtime_access_token_verification_unavailable: "Runtime access token verification is unavailable",
  connection_operation_denied: "Connection operation is not authorized",
  hosted_connection_reconnect_required: "Connection requires reconnect",
  hosted_connection_credential_unavailable: "Connection credential is unavailable",
  connection_exists: "Connection token is unavailable",
  connection_verify_failed: "Connection token is unavailable",
  connection_not_available: "Connection token is unavailable",
  connection_refresh_transient: "Connection token is unavailable",
  connections_unavailable: "Connections service is unavailable",
  connection_provider_unauthorized: "Connection provider authorization failed",
  connection_provider_invalid_response: "Connection provider returned an invalid response",
  connection_provider_unavailable: "Connection provider is unavailable",
  connection_provider_rate_limited: "Connection provider rate limit was reached",
  connection_provider_rejected: "Connection provider rejected the operation",
  connection_operation_failed: "Connection operation failed",
} satisfies Record<z.infer<typeof centralBrokerErrorCode>, string>

const centralBrokerError = z.object({
  error: z.object({
    code: centralBrokerErrorCode,
    message: z.string().min(1).refine((value) => value.trim().length > 0),
    retryable: z.boolean(),
  }).strict(),
}).strict()

const callBase = z.object({ connectionId: z.string().min(1) })
export const WORKGRAPH_CONNECTION_TOOL_INPUT_SCHEMAS = {
  connection_work_source_list: callBase.extend({
    providerUserId: z.string().min(1),
    filters,
    cursor: z.string().min(1).optional(),
  }).strict(),
  connection_work_source_comment: callBase.extend({
    externalId: z.string().min(1),
    body: z.string().min(1),
    idempotencyKey: z.string().min(1),
  }).strict(),
  connection_work_source_update: callBase.extend({
    externalId: z.string().min(1),
    status: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
  }).strict().refine((value) => value.status !== undefined || value.body !== undefined, {
    message: "An update requires status or body",
  }),
} satisfies Record<WorkGraphConnectionToolName, z.ZodType>

export type WorkGraphConnectionToolInput = {
  [Tool in WorkGraphConnectionToolName]: z.infer<typeof WORKGRAPH_CONNECTION_TOOL_INPUT_SCHEMAS[Tool]>
}

export const WORKGRAPH_CONNECTION_TOOL_SCHEMAS = {
  connection_work_source_list: {
    description: "List work-source issues through an explicitly bound Connection.",
    input: { connectionId: "string", providerUserId: "string", filters: "record<string,string>", cursor: "string?" },
  },
  connection_work_source_comment: {
    description: "Add an idempotent comment to a work-source issue through an explicitly bound Connection.",
    input: { connectionId: "string", externalId: "string", body: "string", idempotencyKey: "string" },
  },
  connection_work_source_update: {
    description: "Idempotently update status or body on a work-source issue through an explicitly bound Connection.",
    input: { connectionId: "string", externalId: "string", status: "string?", body: "string?", idempotencyKey: "string" },
  },
} as const

export type WorkGraphConnectionOperationBroker = (
  request: WorkGraphConnectionOperationRequest,
  signal: AbortSignal,
) => Promise<WorkGraphConnectionOperationResponse>

type Binding = Omit<z.infer<typeof bind>, "brokerUrl"> & {
  authorization?: string
  brokerOrigin?: string
  callbackNonce: string
}

export type WorkGraphConnectionBrokerRequestLimits = {
  timeoutMs: number
  maxResponseBytes: number
}

const DEFAULT_BROKER_REQUEST_LIMITS = {
  timeoutMs: 15_000,
  maxResponseBytes: 1024 * 1024,
} satisfies WorkGraphConnectionBrokerRequestLimits

export const WORKGRAPH_CONNECTION_BINDING_PATH = "/api/workgraph/connection-binding"
export const WORKGRAPH_CONNECTION_TOOL_PATH = "/api/workgraph/tools"
const CENTRAL_BROKER_PATH = "/internal/workgraph/connection-operation"
export type WorkGraphConnectionToolRouteHandle = Hono & { dispose(): void }

export function WorkGraphConnectionToolRoutes(input: {
  workspaceId: string
  broker?: WorkGraphConnectionOperationBroker
  /** Exact central origin allowed to receive the bound Runtime Access Token. */
  brokerOrigin?: string
  brokerRequestLimits?: WorkGraphConnectionBrokerRequestLimits
  fetch?: typeof fetch
  registerSessionTools?: (input: {
    sessionId: string
    callbackUrl: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>
  }) => Promise<void>
  unregisterSessionTools?: (sessionId: string) => Promise<void>
}) {
  const app = new Hono() as WorkGraphConnectionToolRouteHandle
  const callbacks = new Hono()
  const bindings = new Map<string, Binding>()
  const callbackSessions = new Map<string, string>()
  const request = input.fetch ?? fetch
  const brokerOrigin = input.brokerOrigin ? validatedBrokerOrigin(input.brokerOrigin) : undefined
  const brokerRequestLimits = validateBrokerRequestLimits(input.brokerRequestLimits ?? DEFAULT_BROKER_REQUEST_LIMITS)
  let callbackServer: ReturnType<typeof serve> | undefined
  let callbackOrigin: Promise<string> | undefined
  let disposed = false

  callbacks.post("/callback/:nonce", async (c) => {
    const sessionId = callbackSessions.get(c.req.param("nonce"))
    if (!sessionId) return c.json({ error: "Session tool callback is unavailable" }, 404)
    const body = await boundedJsonBody<Record<string, unknown>>(c, {})
    const name = typeof body.name === "string" && WORKGRAPH_CONNECTION_TOOL_NAMES.includes(body.name as WorkGraphConnectionToolName)
      ? body.name as WorkGraphConnectionToolName
      : undefined
    if (body.sessionID !== sessionId || !name) return c.json({ error: "Session tool callback identity is invalid" }, 403)
    const value = body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : {}
    const response = await execute(name, sessionId, value)
    return new Response(response.body, { status: response.status, headers: response.headers })
  })

  app.post(WORKGRAPH_CONNECTION_BINDING_PATH, async (c) => {
    if (disposed) return c.json(errorBody("connection_binding_unavailable", "Connection binding is unavailable"), 503)
    const parsed = bind.safeParse(await boundedJsonBody(c, {}))
    if (!parsed.success) return c.json(errorBody("connection_binding_invalid", "Connection binding is invalid"), 400)
    let requestedBrokerOrigin: string
    try {
      requestedBrokerOrigin = validatedBrokerOrigin(parsed.data.brokerUrl)
    } catch {
      return c.json(errorBody("connection_binding_broker_invalid", "Connection broker URL is invalid"), 400)
    }
    if (parsed.data.identity.workspaceId !== input.workspaceId) {
      return c.json(errorBody("connection_binding_workspace_mismatch", "Connection binding workspace does not match runtime"), 403)
    }
    const token = c.req.header(WorkGraphBrokerTokenHeader)?.trim() || bearerToken(c.req.header("authorization"))
    if (!token && !input.broker) {
      return c.json(errorBody("connection_binding_auth_required", "A Runtime Access Token is required"), 401)
    }
    if (!input.broker && !brokerOrigin) {
      return c.json(errorBody("connection_binding_broker_unavailable", "Trusted central broker origin is not configured"), 503)
    }
    if (!input.broker && requestedBrokerOrigin !== brokerOrigin) {
      return c.json(errorBody(
        "connection_binding_broker_mismatch",
        "Connection broker does not match the trusted central origin",
      ), 403)
    }
    if (!input.registerSessionTools) {
      return c.json(errorBody("connection_tool_registration_unavailable", "Core Session tool registration is unavailable"), 503)
    }
    const existing = bindings.get(parsed.data.identity.sessionId)
    if (
      existing
      && (
        existing.identity.attemptId !== parsed.data.identity.attemptId
        || existing.identity.workspaceId !== parsed.data.identity.workspaceId
      )
    ) {
      return c.json(errorBody("connection_binding_conflict", "Session is already bound to another Attempt"), 409)
    }
    const callbackNonce = crypto.randomUUID()
    const binding = {
      version: parsed.data.version,
      identity: parsed.data.identity,
      connectionIds: [...new Set(parsed.data.connectionIds)],
      tools: [...new Set(parsed.data.tools)],
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(!input.broker && brokerOrigin ? { brokerOrigin } : {}),
      callbackNonce,
    }
    bindings.set(parsed.data.identity.sessionId, binding)
    callbackSessions.set(callbackNonce, parsed.data.identity.sessionId)
    try {
      await input.registerSessionTools({
        sessionId: parsed.data.identity.sessionId,
        callbackUrl: `${await localCallbackOrigin()}/callback/${callbackNonce}`,
        tools: binding.tools.map(toolDefinition),
      })
    } catch {
      callbackSessions.delete(callbackNonce)
      if (existing && !disposed) bindings.set(parsed.data.identity.sessionId, existing)
      else bindings.delete(parsed.data.identity.sessionId)
      closeCallbackServerIfUnused()
      return c.json(errorBody("connection_tool_registration_failed", "Core Session tools could not be registered"), 503)
    }
    if (disposed) {
      bindings.delete(parsed.data.identity.sessionId)
      callbackSessions.delete(callbackNonce)
      return c.json(errorBody("connection_binding_unavailable", "Connection binding is unavailable"), 503)
    }
    if (existing) callbackSessions.delete(existing.callbackNonce)
    return c.json({ bound: true, sessionId: parsed.data.identity.sessionId })
  })

  app.delete(`${WORKGRAPH_CONNECTION_BINDING_PATH}/:sessionId`, async (c) => {
    const sessionId = c.req.param("sessionId")
    const binding = bindings.get(sessionId)
    if (!binding) return c.json({ unbound: false })
    if (input.unregisterSessionTools) await input.unregisterSessionTools(sessionId)
    bindings.delete(sessionId)
    callbackSessions.delete(binding.callbackNonce)
    closeCallbackServerIfUnused()
    return c.json({ unbound: true })
  })

  app.get(`${WORKGRAPH_CONNECTION_TOOL_PATH}`, (c) => c.json({ tools: WORKGRAPH_CONNECTION_TOOL_SCHEMAS }))

  async function execute(tool: WorkGraphConnectionToolName, sessionId: string, value: unknown) {
    const parsed = WORKGRAPH_CONNECTION_TOOL_INPUT_SCHEMAS[tool].safeParse(value)
    if (!parsed.success) return Response.json(errorBody("connection_tool_input_invalid", "Connection tool input is invalid"), { status: 400 })
    const binding = bindings.get(sessionId)
    if (!binding) return Response.json(errorBody("connection_binding_missing", "Session has no Connection binding"), { status: 403 })
    if (!binding.tools.includes(tool)) return Response.json(errorBody("connection_tool_not_bound", "Tool is not bound to this Session"), { status: 403 })
    if (!binding.connectionIds.includes(parsed.data.connectionId)) {
      return Response.json(errorBody("connection_not_bound", "Connection is not bound to this Session"), { status: 403 })
    }
    try {
      const brokerRequest = requestFor(tool, binding, parsed.data)
      const signal = AbortSignal.timeout(brokerRequestLimits.timeoutMs)
      const result = input.broker
        ? await abortable(input.broker(brokerRequest, signal), signal)
        : await callBroker(request, binding, brokerRequest, signal, brokerRequestLimits.maxResponseBytes)
      const response = WorkGraphConnectionOperationResponseSchema.safeParse(result)
      if (!response.success) throw new Error("Connection broker returned an invalid response")
      return Response.json(response.data)
    } catch (error) {
      if (error instanceof CentralBrokerHttpError) {
        return Response.json(error.body, { status: error.status })
      }
      return Response.json(errorBody("connection_operation_failed", "Connection operation failed"), { status: 502 })
    }
  }

  function localCallbackOrigin() {
    if (disposed) return Promise.reject(new Error("Session tool callback is unavailable"))
    return callbackOrigin ??= new Promise<string>((resolve, reject) => {
      callbackServer = serve({ fetch: callbacks.fetch, hostname: "127.0.0.1", port: 0 })
      const ready = () => {
        const address = callbackServer?.address()
        if (!address || typeof address === "string") return reject(new Error("Session tool callback did not bind"))
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

function toolDefinition(name: WorkGraphConnectionToolName) {
  const properties: Record<string, unknown> = { connectionId: { type: "string" } }
  const required = ["connectionId"]
  if (name === "connection_work_source_list") {
    Object.assign(properties, {
      providerUserId: { type: "string" },
      filters: { type: "object", additionalProperties: { type: "string" } },
      cursor: { type: "string" },
    })
    required.push("providerUserId", "filters")
  }
  if (name === "connection_work_source_comment") {
    Object.assign(properties, {
      externalId: { type: "string" },
      body: { type: "string" },
      idempotencyKey: { type: "string" },
    })
    required.push("externalId", "body", "idempotencyKey")
  }
  if (name === "connection_work_source_update") {
    Object.assign(properties, {
      externalId: { type: "string" },
      status: { type: "string" },
      body: { type: "string" },
      idempotencyKey: { type: "string" },
    })
    required.push("externalId", "idempotencyKey")
  }
  return {
    name,
    description: WORKGRAPH_CONNECTION_TOOL_SCHEMAS[name].description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    outputSchema: { type: "object" },
  }
}

function requestFor(
  tool: WorkGraphConnectionToolName,
  binding: Binding,
  value: Record<string, unknown> & { connectionId: string },
): WorkGraphConnectionOperationRequest {
  const identity = { ...binding.identity, connectionId: value.connectionId }
  if (tool === "connection_work_source_list") return WorkGraphConnectionOperationRequestSchema.parse({
    version: 1,
    identity,
    operation: { type: "list", providerUserId: value.providerUserId, filters: value.filters, ...(value.cursor ? { cursor: value.cursor } : {}) },
  })
  if (tool === "connection_work_source_comment") return WorkGraphConnectionOperationRequestSchema.parse({
    version: 1,
    identity,
    operation: { type: "comment", externalId: value.externalId, body: value.body, idempotencyKey: value.idempotencyKey },
  })
  return WorkGraphConnectionOperationRequestSchema.parse({
    version: 1,
    identity,
    operation: { type: "update", externalId: value.externalId, ...(value.status ? { status: value.status } : {}), ...(value.body ? { body: value.body } : {}), idempotencyKey: value.idempotencyKey },
  })
}

async function callBroker(
  request: typeof fetch,
  binding: Binding,
  body: WorkGraphConnectionOperationRequest,
  signal: AbortSignal,
  maxResponseBytes: number,
) {
  if (!binding.authorization) throw new Error("Runtime Access Token is unavailable")
  if (!binding.brokerOrigin) throw new Error("Trusted central broker origin is unavailable")
  const url = new URL(CENTRAL_BROKER_PATH, binding.brokerOrigin)
  const response = await request(url, {
    method: "POST",
    headers: { authorization: binding.authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  const value = await boundedResponseJson(response, maxResponseBytes, signal)
  if (!response.ok) {
    const parsed = centralBrokerError.safeParse(value)
    if (!parsed.success || response.status < 400 || response.status > 599) {
      throw new Error("Connection broker rejected the operation")
    }
    throw new CentralBrokerHttpError(response.status, {
      error: {
        code: parsed.data.error.code,
        message: centralBrokerErrorMessage[parsed.data.error.code],
        retryable: parsed.data.error.retryable,
      },
    })
  }
  return value
}

class CentralBrokerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: z.infer<typeof centralBrokerError>,
  ) {
    super("Connection broker rejected the operation")
    this.name = "CentralBrokerHttpError"
  }
}

function validatedBrokerOrigin(input: string) {
  const url = new URL(input)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Connection broker URL is invalid")
  }
  return url.origin
}

function validateBrokerRequestLimits(input: WorkGraphConnectionBrokerRequestLimits) {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new Error("Connection broker timeout must be a positive integer")
  }
  if (!Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1) {
    throw new Error("Connection broker response limit must be a positive integer")
  }
  return input
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted)
        resolve(value)
      },
      (cause) => {
        signal.removeEventListener("abort", aborted)
        reject(cause)
      },
    )
  })
}

async function boundedResponseJson(response: Response, limit: number, signal: AbortSignal) {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > limit) throw new Error("Connection broker response is too large")
  if (!response.body) throw new Error("Connection broker response is empty")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  while (true) {
    const chunk = await abortable(reader.read(), signal)
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > limit) {
      await reader.cancel()
      throw new Error("Connection broker response is too large")
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  text += decoder.decode()
  return JSON.parse(text) as unknown
}
