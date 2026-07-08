import { legacyDirectoryFromRouteKey } from "@claxedo/shell/identity/route"
import { resolveRecovery, rememberRecovery } from "../terminal/pane-terminal-recovery"
import { queryClient } from "../../shared/query/query-client"
import { createTransport } from "../../shell/data/transport/transport"
import { centralTransportForServer } from "@claxedo/shell/data/transport/transport"

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

type PreviewRequest = (url: string, init?: RequestInit) => Promise<Response>

const HIT_TTL_MS = 20_000
const MISS_TTL_MS = 3_000
const ALIAS_TTL_MS = 30_000

const alias = new Map<string, { id: string; at: number }>()

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
  const decoded = legacyDirectoryFromRouteKey(next)
  return decoded?.startsWith("/") ? decoded : undefined
}

const target = (sdkUrl: string, terminalId: string) => {
  const site = origin(sdkUrl)
  if (!site) return
  const id = resolve(text(terminalId))
  if (!id) return
  return {
    site,
    id,
    cacheKey: `${site}|${id}`,
  }
}

const previewCacheKey = (cacheKey: string) => ["shell", "terminal-session-preview", cacheKey, "cache"] as const
const previewRequestKey = (cacheKey: string) => ["shell", "terminal-session-preview", cacheKey, "request"] as const

const previewPath = (terminalId: string, directory?: string) => {
  const url = new URL("/api/wr/hook/terminal-session", "http://claxedo.local")
  url.searchParams.set("terminalId", terminalId)
  if (directory) url.searchParams.set("directory", directory)
  return `${url.pathname}${url.search}`
}

const PRUNE_INTERVAL_MS = 60_000
let lastPrune = 0

const pruneCache = () => {
  const now = Date.now()
  if (now - lastPrune < PRUNE_INTERVAL_MS) return
  lastPrune = now
  for (const [key, entry] of alias) {
    if (now - entry.at > ALIAS_TTL_MS) alias.delete(key)
  }
}

const stale = (entry: CacheEntry | undefined) => {
  if (!entry) return true
  const ttl = entry.value ? HIT_TTL_MS : MISS_TTL_MS
  return Date.now() - entry.at > ttl
}

const resolve = (terminalId: string) => resolveRecovery(alias, terminalId, ALIAS_TTL_MS)

export const cachedTerminalSessionPreview = (
  sdkUrl: string,
  terminalId: string,
): TerminalSessionPreview | null | undefined => {
  pruneCache()
  const nextTarget = target(sdkUrl, terminalId)
  if (!nextTarget) return undefined
  const key = previewCacheKey(nextTarget.cacheKey)
  const existing = queryClient.getQueryData<CacheEntry>(key)
  if (stale(existing)) {
    queryClient.removeQueries({ queryKey: key })
    return undefined
  }
  return existing?.value ?? null
}

export const aliasTerminalSessionPreview = (oldId: string, newId: string) => {
  const prev = text(oldId)
  const next = text(newId)
  if (!prev || !next || prev === next) return
  rememberRecovery(alias, prev, next)
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
  return parsed
}

/**
 * Cloud-routing options for `loadTerminalSessionPreview`.
 *
 * When the caller passes `directory` + `resolveWorkspaceRuntime`, the
 * function asks the shared runtime access layer to route cloud/user-hosted
 * workspaces through the relay. Local workspaces keep the direct-fetch path.
 */
export type TerminalSessionPreviewOptions = {
  request?: typeof fetch
  directory?: string
  resolveWorkspaceRuntime?: (input: { directory: string }) => Promise<{
    kind: "cloud" | "local" | "user-hosted"
    workspaceId?: string
  } | null>
}

const previewTransport = (
  site: string,
  dir: string,
  request: typeof fetch,
  workspace?: Awaited<ReturnType<NonNullable<TerminalSessionPreviewOptions["resolveWorkspaceRuntime"]>>>,
) => createTransport({
  placement: workspace?.kind && workspace.kind !== "local" && workspace.workspaceId
    ? {
        workspaceId: workspace.workspaceId,
        hosting: "workspace",
        transport: centralTransportForServer(site) === "loopback" ? "loopback" : "workspace-relay",
      }
    : {
        hosting: "workspace",
        transport: centralTransportForServer(site),
      },
  serverUrl: site,
  directory: dir,
  request,
})

async function fetchPreviewBody(url: string, request: PreviewRequest, headers?: Record<string, string>) {
  return request(url, headers ? { headers } : undefined)
    .then((res) => (res.ok ? res.json() : undefined))
    .then((value) => parse(value))
    .catch(() => null)
}

export const loadTerminalSessionPreview = (
  sdkUrl: string,
  terminalId: string,
  requestOrOptions: typeof fetch | TerminalSessionPreviewOptions = fetch,
) => {
  pruneCache()
  const nextTarget = target(sdkUrl, terminalId)
  if (!nextTarget) return Promise.resolve(null)

  const cacheKey = previewCacheKey(nextTarget.cacheKey)
  const existing = queryClient.getQueryData<CacheEntry>(cacheKey)
  if (!stale(existing)) {
    return Promise.resolve(existing?.value ?? null)
  }
  queryClient.removeQueries({ queryKey: cacheKey })

  const requestKey = previewRequestKey(nextTarget.cacheKey)
  const running = queryClient.getQueryData<Promise<TerminalSessionPreview | null>>(requestKey)
  if (running) {
    return running
  }

  // Discriminate the union: a TerminalSessionPreviewOptions object has
  // a `request` (or `directory`) property; the legacy callers pass the
  // fetch function directly.
  const isOptions = typeof requestOrOptions === "object" && requestOrOptions !== null && (
    "request" in requestOrOptions || "directory" in requestOrOptions ||
    "resolveWorkspaceRuntime" in requestOrOptions
  )
  const opts: TerminalSessionPreviewOptions = isOptions
    ? requestOrOptions
    : { request: requestOrOptions as typeof fetch }
  const request = opts.request ?? fetch

  const next = (async () => {
    if (opts.directory && opts.resolveWorkspaceRuntime) {
      const resolved = await opts.resolveWorkspaceRuntime({ directory: opts.directory }).catch(() => null)
      if ((resolved?.kind === "cloud" || resolved?.kind === "user-hosted") && resolved.workspaceId) {
        return fetchPreviewBody(
          previewPath(nextTarget.id),
          previewTransport(nextTarget.site, opts.directory, request, resolved).fetch,
        )
      }
      return fetchPreviewBody(
        previewPath(nextTarget.id, opts.directory),
        previewTransport(nextTarget.site, opts.directory, request, resolved).fetch,
      )
    }
    return fetchPreviewBody(
      new URL(previewPath(nextTarget.id), nextTarget.site).toString(),
      request,
    )
  })()
    .then((value) => {
      queryClient.setQueryData(cacheKey, { value, at: Date.now() })
      return value
    })
    .finally(() => {
      queryClient.removeQueries({ queryKey: requestKey })
    })

  queryClient.setQueryData(requestKey, next)
  return next
}
