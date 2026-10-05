import type { Context } from "hono"
import { AgentRuntimeContractError } from "@claxedo/agent-runtime-contract"
import { isAgentHarnessEngineError, TransportError } from "@claxedo/harness/contract"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import { piMatchingModel } from "@claxedo/harness/pi-catalog"
import type { HarnessCapabilities } from "../host/capabilities"
import type { AgentRuntime, HarnessTarget } from "../host/runtime"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"
import { errorBody } from "./error-body"

export type CapabilityKey = {
  [K in keyof HarnessCapabilities]: HarnessCapabilities[K] extends boolean ? K : never
}[keyof HarnessCapabilities] & string

export function harnessUnavailableResponse(c: Context, error: unknown) {
  if (error instanceof CredentialSelectionError) {
    const { reason, piProvider } = error.detail
    const model = piProvider ? piMatchingModel(piProvider, c.req.query("model") || undefined) : undefined
    return c.json(errorBody(error.code, error.message, {
      retryable: error.retryable,
      ...(reason ? { reason } : {}),
      ...(model ? { alternative: { harness: "pi", model: { id: model.id, name: model.name } } } : {}),
    }), 409)
  }
  if (error instanceof WorkspaceHarnessUnavailableError) return c.json(errorBody(error.code, error.message), 409)
  return undefined
}

export function sessionConfigRefusalResponse(c: Context, error: unknown) {
  if (!(error instanceof TransportError) || error.code !== "configuration") return undefined
  return c.json(errorBody("session_config_refused", error.message, { harness: error.transport, retryable: error.retryable }), 409)
}

export function unsupportedOperation(
  c: Context,
  harness: string,
  operation: string,
  details?: {
    capability?: string
    harness?: string
    reason?: string
    message?: string
  },
) {
  return c.json({
    ok: false,
    error: {
      code: "unsupported_operation",
      operation,
      capability: details?.capability ?? operation,
      harness: details?.harness ?? harness,
      transport: harness,
      reason: details?.reason ?? "capability_disabled",
      message: details?.message ?? `${harness} does not support ${operation}`,
    },
  }, 409)
}

export async function unsupportedIfUnavailable(
  c: Context,
  runtime: AgentRuntime,
  target: HarnessTarget,
  key: CapabilityKey,
  operation: string = key,
) {
  const caps = await runtime.reads.capabilities(target)
  if (!caps[key]) return unsupportedOperation(c, caps.harness, operation, { capability: key })
  return undefined
}

/**
 * A harness that advertises an operation can still refuse one request of it,
 * as OpenCode refuses a fork into a named child. That refusal answers exactly
 * as an unadvertised operation does, so a caller reads one shape for both.
 */
export async function unsupportedIfRefused(c: Context, runtime: AgentRuntime, target: HarnessTarget, key: CapabilityKey, error: unknown) {
  if (!(error instanceof AgentRuntimeContractError) || error.detail.code !== "unsupported_operation") throw error
  const caps = await runtime.reads.capabilities(target)
  return unsupportedOperation(c, caps.harness, error.detail.operation, {
    capability: key,
    reason: "harness_refused",
    message: error.detail.message,
  })
}

/**
 * Hono's default turns a thrown error into a bare "Internal Server Error",
 * which the client cannot tell from its own bug. An engine refusal is an
 * upstream failure: 502, carrying the call and the workspace the adapter
 * recorded when the engine's client gave it nothing else.
 */
export function engineRefusalResponse(c: Context, error: unknown) {
  if (!isAgentHarnessEngineError(error)) throw error
  return c.json(errorBody(error.code, error.message), 502)
}
