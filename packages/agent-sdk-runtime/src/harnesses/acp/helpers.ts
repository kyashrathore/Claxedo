import type { McpServer, Usage } from "@agentclientprotocol/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { Log } from "../../log"
import type { ACPTransportEnv } from "./transport"

const log = Log.create({ service: "acp-adapter" })

export function mergeAcpEnv(current: ACPTransportEnv, next: ACPTransportEnv) {
  return {
    ...current,
    ...next,
  }
}

export function sameAcpEnv(a: ACPTransportEnv, b: ACPTransportEnv) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function envFromConfig(config: Record<string, unknown>) {
  return envRecord(config.env)
}

function envRecord(input: unknown): ACPTransportEnv {
  return Object.fromEntries(
    Object.entries(stringRecord(input)),
  )
}

function stringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter((item): item is [string, string] => typeof item[1] === "string"),
  )
}

export function sameAcpMcp(a: McpServer[], b: McpServer[]) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export const IDLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.CLAXEDO_ACP_IDLE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 5 * 60 * 1000
})()

export function promptTimeoutMs() {
  const v = Number(process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 5 * 60_000
}

const RPC_STALL_LOG_MS = (() => {
  const v = Number(process.env.CLAXEDO_ACP_RPC_STALL_LOG_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 5_000
})()

export function probeTimeoutMs() {
  const v = Number(process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : newSessionTimeoutMs()
}

export function newSessionTimeoutMs() {
  const v = Number(process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 10_000
}

export function initializeTimeoutMs() {
  const v = Number(process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : newSessionTimeoutMs()
}

/** JSON-RPC reserved code for a server-side internal error. */
export const JSON_RPC_INTERNAL_ERROR = -32603

/**
 * The JSON-RPC `code` of an agent-side failure, when it carries one.
 *
 * Callers that want to CLASSIFY a failure must use this rather than matching on
 * `errorMessage`. The rendered message is for humans and composes in the
 * agent's own detail text, so a string comparison against it silently stops
 * matching the moment an agent starts populating `data`.
 */
export function errorCode(err: unknown): number | undefined {
  const obj = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined
  return typeof obj?.code === "number" ? obj.code : undefined
}

/** Extract a human-readable message from any error value (Error, JSON-RPC error object, or unknown). */
export function errorMessage(err: unknown): string {
  const obj = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined
  // JSON-RPC error object: { code, message, data } — prefer the detail in `data`
  // over the generic top-level message. This MUST run before the `instanceof
  // Error` shortcut below: the ACP SDK's RequestError extends Error AND carries
  // `data`, so an early return on `.message` collapsed every agent-side failure
  // to "Internal error" and made this branch dead code for the only errors it
  // was written for. Agents may report the useful failure in either field.
  const data = obj?.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : undefined
  const detail = [data?.message, data?.details].find((v): v is string => typeof v === "string" && v.length > 0)
  if (detail) return typeof obj?.message === "string" && obj.message !== detail ? `${obj.message}: ${detail}` : detail
  if (err instanceof Error) return err.message
  if (obj) {
    if (typeof obj.message === "string") return obj.message
    try { return JSON.stringify(err) } catch { /* fall through */ }
  }
  return String(err)
}

export function messageUsage(usage: Usage) {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: usage.thoughtTokens ?? 0,
    cache: {
      read: usage.cachedReadTokens ?? 0,
      write: usage.cachedWriteTokens ?? 0,
    },
  }
}

export function runtimeUsage(usage: Usage, nativeSessionId?: string): Extract<AgentRuntimeEvent, { type: "usage" }> {
  return {
    type: "usage",
    contextSize: usage.totalTokens,
    contextUsed: usage.totalTokens,
    observation: {
      kind: "cumulative",
      ...(nativeSessionId ? { nativeSessionId } : {}),
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.thoughtTokens ?? null,
        cache: {
          read: usage.cachedReadTokens ?? null,
          write: usage.cachedWriteTokens ?? null,
        },
      },
    },
  }
}

export function missing(err: unknown) {
  const msg = errorMessage(err)
  return msg.includes("Resource not found")
}

export function watch(op: string, extra: Record<string, unknown>) {
  const ts = Date.now()
  const id = setTimeout(() => {
    log.warn("ACP RPC still waiting", {
      op,
      waitMs: Date.now() - ts,
      ...extra,
    })
  }, RPC_STALL_LOG_MS)
  return () => clearTimeout(id)
}
