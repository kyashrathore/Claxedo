import { base64Decode } from "@opencode-ai/util/encode"
import { createDebugLogger } from "../../overrides/utils/debug"

export type TerminalSessionPreview = {
  terminalId: string
  tabId?: string
  workspaceId?: string
  provider?: string
  sessionId?: string | null
  transcriptPath?: string | null
  refName?: string
  prompt?: string
  lastAssistantMessage?: string
  eventType?: string
  updatedAt: number
}

type CacheEntry = {
  value: TerminalSessionPreview | null
  at: number
}

const HIT_TTL_MS = 20_000
const MISS_TTL_MS = 3_000

const terminalPreviewDebug = createDebugLogger("terminal.preview", "terminal:preview", {
  defaultLevel: 0,
})

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<TerminalSessionPreview | null>>()

const text = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const optional = (value: unknown) => {
  const next = text(value)
  if (!next) return undefined
  return next
}

const nullable = (value: unknown) => {
  if (value === null) return null
  const next = text(value)
  if (!next) return undefined
  return next
}

const record = (value: unknown) => {
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}

const origin = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    if (typeof window !== "undefined") return window.location.origin
    return ""
  }
}

const workspace = (value: unknown) => {
  const next = optional(value)
  if (!next) return undefined
  if (next.startsWith("/")) return next
  try {
    const decoded = base64Decode(next)
    if (decoded.startsWith("/")) return decoded
  } catch {
    return undefined
  }
  return undefined
}

const target = (sdkUrl: string, terminalId: string) => {
  const site = origin(sdkUrl)
  if (!site) return
  const id = text(terminalId)
  if (!id) return
  return {
    site,
    id,
    cacheKey: `${site}|${id}`,
  }
}

const PRUNE_INTERVAL_MS = 60_000
let lastPrune = 0

const pruneCache = () => {
  const now = Date.now()
  if (now - lastPrune < PRUNE_INTERVAL_MS) return
  lastPrune = now
  for (const [key, entry] of cache) {
    if (stale(entry)) cache.delete(key)
  }
}

const stale = (entry: CacheEntry | undefined) => {
  if (!entry) return true
  const ttl = entry.value ? HIT_TTL_MS : MISS_TTL_MS
  return Date.now() - entry.at > ttl
}

const parse = (value: unknown): TerminalSessionPreview | null => {
  const body = record(value)
  if (!body || body.success !== true) return null
  const session = record(body.session)
  if (!session) return null
  const terminalId = optional(body.terminalId) || optional(session.terminalId)
  if (!terminalId) return null
  const updatedAt = Number(session.updatedAt)
  const parsed = {
    terminalId,
    tabId: optional(session.tabId),
    workspaceId: workspace(session.workspaceId),
    provider: optional(session.provider),
    sessionId: nullable(session.sessionId),
    transcriptPath: nullable(session.transcriptPath),
    refName: optional(session.refName),
    prompt: optional(session.prompt),
    lastAssistantMessage: optional(session.lastAssistantMessage),
    eventType: optional(session.eventType),
    updatedAt: Number.isFinite(updatedAt) ? Math.round(updatedAt) : Date.now(),
  }
  if (terminalPreviewDebug.enabled(2)) {
    terminalPreviewDebug.verbose("parsed", {
      terminalId: parsed.terminalId,
      tabId: parsed.tabId,
      workspaceId: parsed.workspaceId,
      provider: parsed.provider,
      sessionId: parsed.sessionId,
      refName: parsed.refName,
      prompt: parsed.prompt,
      lastAssistantMessage: parsed.lastAssistantMessage,
      eventType: parsed.eventType,
      updatedAt: parsed.updatedAt,
    })
  }
  return parsed
}

export const cachedTerminalSessionPreview = (sdkUrl: string, terminalId: string) => {
  const next = target(sdkUrl, terminalId)
  if (!next) return undefined
  const entry = cache.get(next.cacheKey)
  if (!entry) {
    if (terminalPreviewDebug.enabled(2)) {
      terminalPreviewDebug.verbose("cache miss", { terminalId, cacheKey: next.cacheKey })
    }
    return undefined
  }
  if (stale(entry)) {
    if (terminalPreviewDebug.enabled(2)) {
      terminalPreviewDebug.verbose("cache stale", { terminalId, cacheKey: next.cacheKey })
    }
    return undefined
  }
  if (terminalPreviewDebug.enabled(2)) {
    terminalPreviewDebug.verbose("cache hit", {
      terminalId,
      cacheKey: next.cacheKey,
      sessionId: entry.value?.sessionId,
    })
  }
  return entry.value
}

export const loadTerminalSessionPreview = (sdkUrl: string, terminalId: string, request: typeof fetch = fetch) => {
  pruneCache()
  const nextTarget = target(sdkUrl, terminalId)
  if (!nextTarget) return Promise.resolve(null)

  const existing = cache.get(nextTarget.cacheKey)
  if (!stale(existing)) {
    if (terminalPreviewDebug.enabled(2)) {
      terminalPreviewDebug.verbose("load using cache", {
        terminalId,
        cacheKey: nextTarget.cacheKey,
        sessionId: existing?.value?.sessionId,
      })
    }
    return Promise.resolve(existing?.value ?? null)
  }

  const running = inflight.get(nextTarget.cacheKey)
  if (running) {
    if (terminalPreviewDebug.enabled(2)) {
      terminalPreviewDebug.verbose("load joined inflight", {
        terminalId,
        cacheKey: nextTarget.cacheKey,
      })
    }
    return running
  }

  if (terminalPreviewDebug.enabled(1)) {
    terminalPreviewDebug.log("loading terminal session", {
      terminalId,
      endpoint: `${nextTarget.site}/hook/terminal-session`,
    })
  }

  const next = request(`${nextTarget.site}/hook/terminal-session?terminalId=${encodeURIComponent(nextTarget.id)}`)
    .then((res) => {
      if (!res.ok) {
        if (terminalPreviewDebug.enabled(1)) {
          terminalPreviewDebug.log("load failed status", {
            terminalId,
            status: res.status,
          })
        }
        return undefined
      }
      return res.json()
    })
    .then((value) => parse(value))
    .catch((error) => {
      if (terminalPreviewDebug.enabled(1)) {
        terminalPreviewDebug.log("load failed exception", {
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return null
    })
    .then((value) => {
      if (terminalPreviewDebug.enabled(1)) {
        terminalPreviewDebug.log("load resolved", {
          terminalId,
          sessionId: value?.sessionId,
          workspaceId: value?.workspaceId,
        })
      }
      cache.set(nextTarget.cacheKey, { value, at: Date.now() })
      return value
    })
    .finally(() => {
      inflight.delete(nextTarget.cacheKey)
    })

  inflight.set(nextTarget.cacheKey, next)
  return next
}
