import { collapse, clip } from "@/lib/text"
import { cachedSignedWorkspace } from "@/platform/runtime/agent/cached-signed-workspace"
import { resolveRecovery, rememberRecovery } from "../workbench/pane-terminal-recovery"
import { createTransport } from "@/platform/runtime/transport"
import type { WorkspaceRuntimeRequestOptions } from "@/platform/runtime/transport"
import {
  loadCachedEntry,
  normalizeText,
  originOf,
  readCachedEntry,
  terminalScopedPlacement,
  type CacheTtl,
} from "./terminal-scoped-cache"

export type TerminalLogSummary = {
  title: string
  task: string
  recent: string[]
}

export type TerminalLogSummaryOptions = {
  request?: typeof fetch
  relayRequest?: typeof fetch
  resolveWorkspaceRuntime?: WorkspaceRuntimeRequestOptions["resolveWorkspaceRuntime"]
}

const SUMMARY_TTL: CacheTtl = { hit: 5_000, miss: 2_000 }
const ALIAS_TTL_MS = 30_000

const alias = new Map<string, { id: string; at: number }>()
const text = normalizeText

const resolve = (terminalId: string) => resolveRecovery(alias, terminalId, ALIAS_TTL_MS)

const target = (sdkUrl: string, terminalId: string, directory: string) => {
  const site = originOf(sdkUrl)
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
  signedWorkspace?: ReturnType<typeof cachedSignedWorkspace>,
) => createTransport({
  placement: terminalScopedPlacement(site, workspace, signedWorkspace),
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
  return readCachedEntry<TerminalLogSummary>(summaryCacheKey(nextTarget.cacheKey), SUMMARY_TTL)
}

export const loadTerminalLogSummary = (
  sdkUrl: string,
  terminalId: string,
  directory: string,
  requestOrOptions: typeof fetch | TerminalLogSummaryOptions = fetch,
): Promise<TerminalLogSummary | null> => {
  const nextTarget = target(sdkUrl, terminalId, directory)
  if (!nextTarget) return Promise.resolve(null)

  const opts = typeof requestOrOptions === "function"
    ? { request: requestOrOptions }
    : requestOrOptions
  const request = opts.request ?? fetch

  return loadCachedEntry<TerminalLogSummary>({
    cacheKey: summaryCacheKey(nextTarget.cacheKey),
    requestKey: summaryRequestKey(nextTarget.cacheKey),
    ttl: SUMMARY_TTL,
    run: () =>
      (async () => {
        const signedWorkspace = cachedSignedWorkspace(sdkUrl, nextTarget.directory)
        // A signed inventory match is canonical placement authority — it wins
        // over (and skips) the liveness read, same precedent as
        // `terminalScopedPlacement`'s own precedence between the two.
        const workspace = signedWorkspace ??
          await opts.resolveWorkspaceRuntime?.({ directory: nextTarget.directory }).catch(() => null)
        return await logTransport(nextTarget.site, nextTarget.directory, request, opts, workspace, signedWorkspace)
          .fetch(logsPath(nextTarget.id, nextTarget.directory))
      })()
        .then((res) => (res.ok ? res.text() : ""))
        .then(parseSummary)
        .catch(() => null),
  })
}

export const aliasTerminalLogSummary = (oldId: string, newId: string): void => {
  const prev = text(oldId)
  const next = text(newId)
  if (!prev || !next || prev === next) return
  rememberRecovery(alias, prev, next)
}
