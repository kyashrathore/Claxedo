import { collapse, clip } from "./text"
import { resolveRecovery, rememberRecovery } from "../terminal/pane-terminal-recovery"
import { queryClient } from "../../shared/query/query-client"
import { createTransport } from "../../shell/data/transport/transport"
import {
  centralTransportForServer,
  type WorkspaceRuntimeRequestOptions,
} from "@claxedo/shell/data/transport/transport"

export type TerminalLogSummary = {
  title: string
  task: string
  recent: string[]
}

type CacheEntry = {
  value: TerminalLogSummary | null
  at: number
}

export type TerminalLogSummaryOptions = {
  request?: typeof fetch
  relayRequest?: typeof fetch
  resolveWorkspaceRuntime?: WorkspaceRuntimeRequestOptions["resolveWorkspaceRuntime"]
}

const HIT_TTL_MS = 5_000
const MISS_TTL_MS = 2_000
const ALIAS_TTL_MS = 30_000

const alias = new Map<string, { id: string; at: number }>()
const text = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const origin = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    if (typeof window !== "undefined") return window.location.origin
    return ""
  }
}

const stale = (entry: CacheEntry | undefined) => {
  if (!entry) return true
  return Date.now() - entry.at > (entry.value ? HIT_TTL_MS : MISS_TTL_MS)
}

const resolve = (terminalId: string) => resolveRecovery(alias, terminalId, ALIAS_TTL_MS)

const target = (sdkUrl: string, terminalId: string, directory: string) => {
  const site = origin(sdkUrl)
  const id = resolve(text(terminalId))
  const dir = text(directory)
  if (!site || !id || !dir) return
  return {
    site,
    id,
    directory: dir,
    cacheKey: `${site}|${dir}|${id}`,
  }
}

function parseSummary(raw: string): TerminalLogSummary | null {
  const recent = raw
    .split(/\r?\n/)
    .map((line) => clip(collapse(line), 160))
    .filter(Boolean)
    .slice(-5)
  if (!recent.length) return null
  return {
    title: recent.at(-1) ?? "Terminal log",
    task: clip(recent.join(" "), 240),
    recent,
  }
}

const summaryCacheKey = (cacheKey: string) => ["shell", "terminal-log-summary", cacheKey, "cache"] as const
const summaryRequestKey = (cacheKey: string) => ["shell", "terminal-log-summary", cacheKey, "request"] as const

const logsPath = (terminalId: string, dir: string) => {
  const url = new URL("/api/wr/process/logs", "http://claxedo.local")
  url.searchParams.set("terminal_id", terminalId)
  url.searchParams.set("directory", dir)
  url.searchParams.set("lines", "40")
  return `${url.pathname}${url.search}`
}

const logTransport = (
  site: string,
  dir: string,
  request: typeof fetch,
  opts: TerminalLogSummaryOptions,
  workspace?: Awaited<ReturnType<NonNullable<TerminalLogSummaryOptions["resolveWorkspaceRuntime"]>>>,
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
  relayRequest: opts.relayRequest,
  resolveWorkspaceRuntime: opts.resolveWorkspaceRuntime,
})

export const cachedTerminalLogSummary = (
  sdkUrl: string,
  terminalId: string,
  directory: string,
): TerminalLogSummary | null | undefined => {
  const nextTarget = target(sdkUrl, terminalId, directory)
  if (!nextTarget) return undefined
  const key = summaryCacheKey(nextTarget.cacheKey)
  const existing = queryClient.getQueryData<CacheEntry>(key)
  if (stale(existing)) {
    queryClient.removeQueries({ queryKey: key })
    return undefined
  }
  return existing?.value ?? null
}

export const loadTerminalLogSummary = (
  sdkUrl: string,
  terminalId: string,
  directory: string,
  requestOrOptions: typeof fetch | TerminalLogSummaryOptions = fetch,
): Promise<TerminalLogSummary | null> => {
  const nextTarget = target(sdkUrl, terminalId, directory)
  if (!nextTarget) return Promise.resolve(null)

  const cacheKey = summaryCacheKey(nextTarget.cacheKey)
  const existing = queryClient.getQueryData<CacheEntry>(cacheKey)
  if (!stale(existing)) return Promise.resolve(existing?.value ?? null)
  queryClient.removeQueries({ queryKey: cacheKey })

  const requestKey = summaryRequestKey(nextTarget.cacheKey)
  const running = queryClient.getQueryData<Promise<TerminalLogSummary | null>>(requestKey)
  if (running) return running

  const opts = typeof requestOrOptions === "function"
    ? { request: requestOrOptions }
    : requestOrOptions
  const request = opts.request ?? fetch

  const next = (async () => {
    const workspace = await opts.resolveWorkspaceRuntime?.({ directory: nextTarget.directory }).catch(() => null)
    return await logTransport(nextTarget.site, nextTarget.directory, request, opts, workspace)
      .fetch(logsPath(nextTarget.id, nextTarget.directory))
  })()
    .then((res) => (res.ok ? res.text() : ""))
    .then(parseSummary)
    .catch(() => {
      return null
    })
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

export const aliasTerminalLogSummary = (oldId: string, newId: string): void => {
  const prev = text(oldId)
  const next = text(newId)
  if (!prev || !next || prev === next) return
  rememberRecovery(alias, prev, next)
}
