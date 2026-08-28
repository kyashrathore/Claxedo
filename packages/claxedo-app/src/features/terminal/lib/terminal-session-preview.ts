import { legacyDirectoryFromRouteKey } from "@/platform/identity/route"
import { resolveRecovery, rememberRecovery } from "../workbench/pane-terminal-recovery"
import { createTransport } from "@/platform/runtime/transport"
import {
  loadCachedEntry,
  normalizeText,
  originOf,
  readCachedEntry,
  terminalScopedPlacement,
  type CacheTtl,
} from "./terminal-scoped-cache"

export type TerminalSessionPreview = {
  terminalId: string
  tabId?: string
  workspaceId?: string
  provider?: string
  providerSessionId?: string | null
  sessionId?: string | null
  transcriptPath?: string | null
  refName?: string
  prompt?: string
  lastAssistantMessage?: string
  eventType?: string
  updatedAt: number
}

type PreviewRequest = (url: string, init?: RequestInit) => Promise<Response>

const PREVIEW_TTL: CacheTtl = { hit: 20_000, miss: 3_000 }
const ALIAS_TTL_MS = 30_000

const alias = new Map<string, { id: string; at: number }>()

const text = normalizeText

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

const workspace = (value: unknown) => {
  const next = optional(value)
  if (!next) return undefined
  if (next.startsWith("/")) return next
  const decoded = legacyDirectoryFromRouteKey(next)
  return decoded?.startsWith("/") ? decoded : undefined
}

const target = (sdkUrl: string, terminalId: string) => {
  const site = originOf(sdkUrl)
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

const resolve = (terminalId: string) => resolveRecovery(alias, terminalId, ALIAS_TTL_MS)

export const cachedTerminalSessionPreview = (
  sdkUrl: string,
  terminalId: string,
): TerminalSessionPreview | null | undefined => {
  pruneCache()
  const nextTarget = target(sdkUrl, terminalId)
  if (!nextTarget) return undefined
  return readCachedEntry<TerminalSessionPreview>(previewCacheKey(nextTarget.cacheKey), PREVIEW_TTL)
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
    providerSessionId: nullable(session.providerSessionId),
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
  placement: terminalScopedPlacement(site, workspace),
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

  return loadCachedEntry<TerminalSessionPreview>({
    cacheKey: previewCacheKey(nextTarget.cacheKey),
    requestKey: previewRequestKey(nextTarget.cacheKey),
    ttl: PREVIEW_TTL,
    run: async () => {
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
    },
  })
}
