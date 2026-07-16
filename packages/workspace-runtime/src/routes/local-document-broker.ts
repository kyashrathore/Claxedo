import { Hono, type Context } from "hono"
import { z } from "zod"
import { verifyDocumentJobCapability } from "../document-job-capability"
import { boundedJson, RequestBodyTooLargeError } from "./bounded-json"

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const REVOKE_TIMEOUT_MS = 2_000

const Input = z
  .object({
    userId: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    localWorkspaceId: z.string().min(1),
    cloudWorkspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    documentId: z.string().min(1),
    operation: z.enum(["list", "read", "write", "resolve"]),
    markdown: z.string().optional(),
    expectedVersion: z.string().optional(),
  })
  .strict()

export function LocalDocumentBrokerRoutes(options: {
  trustedTransport: boolean
  installationToken?: string
  localControlPlaneUrl?: string
  requestTimeoutMs?: number
  revokeTimeoutMs?: number
  maxResponseBytes?: number
}) {
  const app = new Hono().onError((error, context) => {
    if (error instanceof RequestBodyTooLargeError) return context.json({ error: "request_body_too_large" }, 413)
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return context.json({ error: "document_request_invalid" }, 400)
    }
    throw error
  })
  const handle = async (context: Context, raw: unknown) => {
    if (!options.trustedTransport) return context.notFound()
    const input = Input.parse(raw)
    const token = context.req.header("x-claxedo-document-capability")
    if (!token) return context.json({ error: "document_capability_required" }, 401)
    const authorized = await verifyDocumentJobCapability(token, {
      ...input,
      operation: input.operation === "list" ? "resolve" : input.operation,
    }).then(
      () => true,
      () => false,
    )
    if (!authorized) return context.json({ error: "document_broker_capability_invalid" }, 403)
    const baseUrl = options.localControlPlaneUrl?.trim()
    const installationToken = options.installationToken
    if (!baseUrl || !installationToken) return context.json({ error: "local_document_broker_unavailable" }, 503)
    const query = new URLSearchParams({ org_id: input.orgId, project_id: input.projectId })
    const path = input.operation === "list" ? "index" : encodeURIComponent(input.documentId)
    const url = `${new URL(baseUrl).origin}/internal/documents/${path}?${query}`
    const headers = {
      authorization: `Bearer ${installationToken}`,
      "x-claxedo-document-broker": "1",
      "x-claxedo-document-capability": token,
      "x-claxedo-document-user": input.userId,
      "x-claxedo-local-workspace": input.localWorkspaceId,
      "x-claxedo-cloud-workspace": input.cloudWorkspaceId,
      "x-claxedo-document-session": input.sessionId,
      "x-claxedo-document-id": input.documentId,
      "x-claxedo-document-operation": input.operation === "list" ? "resolve" : input.operation,
    }
    try {
      const activated = await externalFetch(`${new URL(baseUrl).origin}/internal/documents/jobs/activate?${query}`, {
        method: "POST", headers, signal: context.req.raw.signal,
      }, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, options.maxResponseBytes ?? MAX_RESPONSE_BYTES)
      if (!activated.response.ok) {
        return new Response(activated.body, {
          status: activated.response.status,
          headers: responseHeaders(activated.response.headers),
        })
      }
      if (parseControlEnvelope(activated.body).active !== true) {
        throw new Error("Local document broker activation response is invalid")
      }
      const response = await externalFetch(url, {
        method: input.operation === "write" ? "PUT" : "GET",
        headers: {
          ...headers,
          ...(input.expectedVersion ? { "if-match": input.expectedVersion } : {}),
          ...(input.operation === "write" ? { "content-type": "application/json" } : {}),
        },
        ...(input.operation === "write"
          ? { body: JSON.stringify({ markdown: input.markdown, sessionId: input.sessionId }) }
          : {}),
        signal: context.req.raw.signal,
      }, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, options.maxResponseBytes ?? MAX_RESPONSE_BYTES)
      return new Response(response.body, {
        status: response.response.status,
        headers: responseHeaders(response.response.headers),
      })
    } finally {
      await externalFetch(`${new URL(baseUrl).origin}/internal/documents/jobs/revoke?${query}`, {
        method: "POST", headers,
      }, options.revokeTimeoutMs ?? REVOKE_TIMEOUT_MS, options.maxResponseBytes ?? MAX_RESPONSE_BYTES)
        .then((response) => {
          if (!response.response.ok || parseControlEnvelope(response.body).revoked !== true) {
            throw new Error("Local document broker revoke response is invalid")
          }
        })
        .catch(() => undefined)
    }
  }
  app.get("/api/wr/local-documents/broker", (context) => {
    const raw = context.req.query("input")
    if (!raw || new TextEncoder().encode(raw).byteLength > 16 * 1024) throw new RequestBodyTooLargeError()
    return handle(context, JSON.parse(raw))
  })
  app.post(
    "/api/wr/local-documents/broker",
    async (context) => await handle(context, await boundedJson(context.req.raw, MAX_RESPONSE_BYTES)),
  )
  return app
}

async function externalFetch(input: string, init: RequestInit, timeoutMs: number, maxResponseBytes: number) {
  return await withDeadline(timeoutMs, init.signal, async (signal) => {
    const response = await fetch(input, { ...init, signal })
    return { response, body: await readBounded(response, maxResponseBytes, signal) }
  })
}

function parseControlEnvelope(bytes: Uint8Array) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local document broker control response is invalid")
  }
  return value as Record<string, unknown>
}

function responseHeaders(value: Headers) {
  const headers = new Headers(value)
  headers.delete("content-length")
  headers.delete("transfer-encoding")
  return headers
}

async function readBounded(response: Response, maxResponseBytes: number, signal: AbortSignal) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxResponseBytes)
    throw new Error("Local document broker response is too large")
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxResponseBytes) {
        await reader.cancel()
        throw new Error("Local document broker response is too large")
      }
      chunks.push(chunk.value)
    }
  } finally {
    signal.removeEventListener("abort", cancel)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function withDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | null | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController()
  let rejectDeadline: (error: Error) => void = () => undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const abort = (error: Error) => {
    if (controller.signal.aborted) return
    controller.abort(error)
    rejectDeadline(error)
  }
  const onParentAbort = () => abort(parentSignal?.reason instanceof Error
    ? parentSignal.reason
    : new Error("Local document broker request was cancelled"))
  if (parentSignal?.aborted) onParentAbort()
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true })
  const timeout = setTimeout(() => abort(new Error("Local document broker request timed out")), Math.max(1, timeoutMs))
  try {
    return await Promise.race([operation(controller.signal), deadline])
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener("abort", onParentAbort)
  }
}
