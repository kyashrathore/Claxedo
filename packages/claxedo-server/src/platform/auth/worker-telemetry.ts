/**
 * Worker-safe telemetry: capture events go to the PostHog HTTP API over `fetch`
 * (or nowhere when unconfigured). Never imports `posthog-node` — it is on the
 * Worker's forbidden-import list, which is why error tracking here is a hand-
 * rolled `$exception` payload rather than an SDK call.
 *
 * Telemetry is fire-and-forget operational evidence and must never throw into a
 * request handler or block the response.
 */

import type { ControlPlaneTelemetry } from "@claxedo/server-core/platform/telemetry/ports"
import { resolveTelemetryHost, resolveTelemetryKey, type ObservabilityEnv } from "../telemetry/errors/config"
import { asRecord } from "@claxedo/server-core/platform/json/index"

type TelemetryEnv = ObservabilityEnv

/** One parsed V8 stack frame in the shape `$exception_list` frames carry. */
export type ExceptionFrame = {
  platform: "web:javascript"
  filename: string
  function: string
  in_app: boolean
  lineno: number
  colno: number
}

/**
 * `at fn (file:1:2)` and the anonymous `at file:1:2` form, plus V8's
 * qualifiers (`async`, `new`, `Object.<anonymous>`). Frames that match neither
 * form (`at <anonymous>`, native frames, eval wrappers) are dropped rather
 * than guessed at: a partial stack still groups, a fabricated one misleads.
 */
const V8_FRAME = /^\s*at\s+(?:(?:async\s+|new\s+)?(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/

/** Bounded so a runaway recursion cannot produce a multi-megabyte payload. */
const FRAME_LIMIT = 50

/**
 * Minimal V8 `err.stack` parser. Frames come out innermost-LAST (the throwing
 * frame is the final entry), which is the order `$exception_list` stacktraces
 * are read in; V8 emits the reverse. Non-Error inputs have no stack at all and
 * yield an empty frame list — the exception still groups on type + value.
 */
export function parseStackFrames(stack: unknown): ExceptionFrame[] {
  if (typeof stack !== "string" || !stack) return []
  const frames: ExceptionFrame[] = []
  for (const line of stack.split("\n")) {
    if (frames.length >= FRAME_LIMIT) break
    const match = V8_FRAME.exec(line)
    if (!match) continue
    frames.push({
      platform: "web:javascript",
      filename: match[2],
      function: match[1] ?? "<anonymous>",
      in_app: true,
      lineno: Number(match[3]),
      colno: Number(match[4]),
    })
  }
  return frames.reverse()
}

/**
 * Type/value for grouping. Thrown non-Errors are common at runtime boundaries
 * (a rejected string, a Response, undefined); they must still produce an issue
 * rather than crash the reporter.
 */
export function exceptionIdentity(error: unknown): { type: string; value: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", value: error.message || String(error) }
  }
  if (error && typeof error === "object") {
    const record = error as { name?: unknown; message?: unknown }
    const type = typeof record.name === "string" && record.name ? record.name : "Error"
    const value = typeof record.message === "string" && record.message ? record.message : safeString(error)
    return { type, value }
  }
  return { type: "Error", value: safeString(error) }
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === "string" ? encoded : String(value)
  } catch {
    // Circular structures and throwing getters are both live possibilities here.
    return String(value)
  }
}

export function workerTelemetry(env: TelemetryEnv = {}): ControlPlaneTelemetry {
  const key = resolveTelemetryKey(env)
  const host = resolveTelemetryHost(env)
  if (!key) {
    return { capture: () => {} }
  }
  const pending = new Set<Promise<void>>()
  return {
    capture: (distinctId, event, properties) => {
      const send = postCapture(host, key, event, distinctId, properties ?? {})
        .catch(() => {})
        .finally(() => pending.delete(send))
      pending.add(send)
    },
    flush: async () => {
      await Promise.all(pending)
    },
  }
}

export type WorkerErrorCapture = {
  /**
   * Resolves once the capture POST settles (or immediately when unconfigured),
   * so callers with an ExecutionContext can `waitUntil` it and keep the isolate
   * alive past the response.
   */
  captureException: (error: unknown, distinctId: string, properties?: Record<string, unknown>) => Promise<void>
}

/**
 * Fetch-based `$exception` transport — the Worker's half of the error seam.
 * Key absent ⇒ zero network, mirroring the analytics sink above.
 */
export function workerErrorCapture(env: TelemetryEnv = {}): WorkerErrorCapture {
  const key = resolveTelemetryKey(env)
  const host = resolveTelemetryHost(env)
  if (!key) {
    return { captureException: async () => {} }
  }
  return {
    captureException: async (error, distinctId, properties) => {
      try {
        const { type, value } = exceptionIdentity(error)
        const frames = parseStackFrames(asRecord(error)?.stack)
        await postCapture(host, key, "$exception", distinctId, {
          // Tags/extra ride as ordinary top-level properties so alert rules can
          // match them directly (`page_class = payment` pages the phone).
          ...properties,
          $exception_list: [
            {
              type,
              value,
              mechanism: { handled: false, synthetic: false },
              stacktrace: { type: "raw", frames },
            },
          ],
        })
      } catch {
        // Observability must never take down the request path.
      }
    },
  }
}

const SYSTEM_DISTINCT_ID = "system"

function isIdentifierKey(key: string) {
  return key.endsWith("_id") || key.endsWith("Id")
}

/**
 * Ids leave this system only as digests: a reader of the analytics project can
 * still join one user's or workspace's events, but cannot recover the id, and a
 * channel's external user id never reaches the vendor as itself.
 */
export async function pseudonymousId(id: string): Promise<string> {
  if (id === SYSTEM_DISTINCT_ID) return id
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`claxedo:${id}`)))
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function pseudonymousEntries(
  record: Record<string, unknown>,
  hashed: (key: string, value: unknown) => boolean,
): Promise<Record<string, unknown>> {
  return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, value]) => {
    const groups = key === "$groups" ? asRecord(value) : undefined
    if (groups) return [key, await pseudonymousEntries(groups, () => true)]
    return [key, typeof value === "string" && hashed(key, value) ? await pseudonymousId(value) : value]
  })))
}

async function postCapture(
  host: string,
  key: string,
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await fetch(`${host}/capture/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event,
      distinct_id: await pseudonymousId(distinctId),
      properties: await pseudonymousEntries(properties, isIdentifierKey),
    }),
    signal: AbortSignal.timeout(5_000),
  })
}
