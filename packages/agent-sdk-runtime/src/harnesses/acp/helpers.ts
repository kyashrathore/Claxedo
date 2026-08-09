import type { McpServer, Usage } from "@agentclientprotocol/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { Log } from "../../log"
import type { ACPTransportEnv } from "./transport"
import { claudeAuthEnv, claudeAuthValue } from "../claude/auth"

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
  const authRecord = stringRecord(config.auth)
  const auth = envRecord(config.auth, true)
  return mergeAcpEnv(
    mergeAcpEnv(envRecord(config.env), auth),
    claudeAuthEnv(claudeAuthValue(authRecord)),
  )
}

function envRecord(input: unknown, onlyEnvKeys = false): ACPTransportEnv {
  return Object.fromEntries(
    Object.entries(stringRecord(input))
      .filter(([key]) => !onlyEnvKeys || /^[A-Z_][A-Z0-9_]*$/.test(key)),
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

/** Extract a human-readable message from any error value (Error, JSON-RPC error object, or unknown). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>
    // JSON-RPC error object: { code, message, data } — prefer data.message (detailed) over top-level message (generic)
    if (obj.data && typeof obj.data === "object" && typeof (obj.data as Record<string, unknown>).message === "string") {
      return (obj.data as Record<string, unknown>).message as string
    }
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
