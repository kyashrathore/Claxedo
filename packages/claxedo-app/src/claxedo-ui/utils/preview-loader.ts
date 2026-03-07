/**
 * Shared data-fetching logic for terminal session previews, log summaries,
 * and session message prefetching. Used by both TopTabBar and GenericLeafNode
 * to avoid ~200 lines of duplicated code.
 */

import { createStore } from "solid-js/store"
import { type createDebugLogger } from "../../overrides/utils/debug"
import { errorText } from "./text"
import {
  cachedTerminalSessionPreview,
  loadTerminalSessionPreview,
  type TerminalSessionPreview,
} from "./terminal-session-preview"
import {
  cachedTerminalLogSummary,
  loadTerminalLogSummary,
  type TerminalLogSummary,
} from "./terminal-log-summary"

export type DebugLogger = ReturnType<typeof createDebugLogger>

export type PreviewLoaderDeps = {
  /** SDK base URL getter */
  sdkUrl: () => string
  /** Whether session API calls should run */
  serverHealthy: () => boolean
  /** Global sync child store factory */
  globalSyncChild: (
    directory: string,
    options?: { bootstrap?: boolean },
  ) => [store: { message: Record<string, any[]>; part: Record<string, any[]> }, setStore: (...args: any[]) => void]
  /** Session messages fetcher */
  fetchSessionMessages: (params: {
    directory: string
    sessionID: string
    limit: number
  }) => Promise<{ data?: Array<{ info: any; parts?: any[] }> }>
  /** Debug logger instance */
  debug: DebugLogger
}

export function createPreviewLoader(deps: PreviewLoaderDeps) {
  const inflight = new Set<string>()
  const fail = new Map<string, number>()
  const failMs = 10_000
  const [terminalSession, setTerminalSession] = createStore<Record<string, TerminalSessionPreview | null>>({})
  const [terminalLog, setTerminalLog] = createStore<Record<string, TerminalLogSummary | null>>({})

  const ensureTerminalLogs = (terminalId: string, directory?: string) => {
    if (!terminalId || terminalId.startsWith("pending-") || !directory) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("terminal log skipped", { reason: "invalid-log-ref", terminalId, directory })
      }
      return
    }

    const cached = cachedTerminalLogSummary(deps.sdkUrl(), terminalId, directory)
    if (cached !== undefined) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("terminal log cache hit", { terminalId, directory, title: cached?.title })
      }
      setTerminalLog(terminalId, cached)
      return
    }

    const key = `terminal-log:${terminalId}:${directory}`
    if (inflight.has(key)) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("terminal log skipped", { reason: "terminal-log-inflight", terminalId, directory })
      }
      return
    }

    if (deps.debug.enabled(2)) {
      deps.debug.verbose("terminal log load start", { terminalId, directory })
    }

    inflight.add(key)
    void loadTerminalLogSummary(deps.sdkUrl(), terminalId, directory)
      .then((resolved) => {
        if (deps.debug.enabled(2)) {
          deps.debug.verbose("terminal log load resolved", {
            terminalId,
            directory,
            title: resolved?.title,
            recentCount: resolved?.recent.length ?? 0,
          })
        }
        setTerminalLog(terminalId, resolved)
      })
      .catch((error) => {
        deps.debug.log("terminal log load failed", { terminalId, directory, error: errorText(error) })
      })
      .finally(() => {
        inflight.delete(key)
      })
  }

  const ensureSessionMessages = (directory: string, sessionId: string) => {
    if (!directory || !sessionId || sessionId === "new") {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("summary prefetch skipped", { reason: "invalid-session-ref", directory, sessionId })
      }
      return
    }
    if (!deps.serverHealthy()) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("summary prefetch skipped", { reason: "server-unhealthy", directory, sessionId })
      }
      return
    }
    const key = `session:${directory}:${sessionId}`
    if ((fail.get(key) ?? 0) > Date.now()) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("summary prefetch skipped", { reason: "session-failed", directory, sessionId })
      }
      return
    }
    if (inflight.has(key)) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("summary prefetch skipped", { reason: "session-inflight", directory, sessionId })
      }
      return
    }
    const [store, setStore] = deps.globalSyncChild(directory, { bootstrap: false })
    const existing = store.message[sessionId]
    if (existing !== undefined) {
      const hasMissingParts = existing.some((message: any) => (store.part[message.id] ?? []).length === 0)
      if (!hasMissingParts) {
        if (deps.debug.enabled(2)) {
          deps.debug.verbose("summary prefetch skipped", {
            reason: "session-cached",
            directory,
            sessionId,
            messages: existing.length,
          })
        }
        return
      }
    }

    if (deps.debug.enabled(2)) {
      deps.debug.verbose("summary prefetch start", { directory, sessionId })
    }

    inflight.add(key)
    void deps
      .fetchSessionMessages({ directory, sessionID: sessionId, limit: 8 })
      .then((result) => {
        fail.delete(key)
        const rows = (result.data ?? []).filter((row) => !!row?.info?.id)
        if (!rows.length) {
          setStore("message", sessionId, [])
          if (deps.debug.enabled(2)) {
            deps.debug.verbose("summary prefetch empty", { directory, sessionId })
          }
          return
        }

        const infos = rows
          .map((row) => row.info)
          .filter((info: any) => !!info?.id)
          .slice()
          .sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        setStore("message", sessionId, infos)

        rows.forEach((row) => {
          if (!row?.info?.id) return
          const parts = (row.parts ?? []).filter((part: any) => !!part?.id)
          setStore("part", row.info.id, parts)
        })

        if (deps.debug.enabled(2)) {
          deps.debug.verbose("summary prefetch loaded", {
            directory,
            sessionId,
            messageCount: infos.length,
            partCount: rows.reduce((sum, row) => sum + (row.parts?.length ?? 0), 0),
          })
        }
      })
      .catch((error) => {
        fail.set(key, Date.now() + failMs)
        deps.debug.log("summary prefetch failed", { directory, sessionId, error: errorText(error) })
      })
      .finally(() => {
        inflight.delete(key)
      })
  }

  const ensureTerminalSession = (terminalId: string, fallbackDirectory?: string) => {
    if (!terminalId || terminalId.startsWith("pending-")) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("terminal summary skipped", { reason: "invalid-terminal-id", terminalId, fallbackDirectory })
      }
      return
    }

    const cached = cachedTerminalSessionPreview(deps.sdkUrl(), terminalId)
    if (cached !== undefined) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("terminal summary cache hit", {
          terminalId,
          sessionId: cached?.sessionId,
          workspaceId: cached?.workspaceId,
        })
      }
      setTerminalSession(terminalId, cached)
      const directory = cached?.workspaceId || fallbackDirectory
      const provider = (cached?.provider || "").toLowerCase()
      if (directory && provider === "opencode") {
        ensureTerminalLogs(terminalId, directory)
      }
      if (!directory || !cached?.sessionId || (provider && provider !== "opencode")) return
      ensureSessionMessages(directory, cached.sessionId)
      return
    }

    const key = `terminal:${terminalId}`
    if (inflight.has(key)) {
      if (deps.debug.enabled(2)) {
        deps.debug.verbose("terminal summary skipped", { reason: "terminal-inflight", terminalId })
      }
      return
    }

    if (deps.debug.enabled(2)) {
      deps.debug.verbose("terminal summary load start", { terminalId, fallbackDirectory })
    }

    inflight.add(key)
    void loadTerminalSessionPreview(deps.sdkUrl(), terminalId)
      .then((resolved) => {
        if (deps.debug.enabled(2)) {
          deps.debug.verbose("terminal summary load resolved", {
            terminalId,
            sessionId: resolved?.sessionId,
            workspaceId: resolved?.workspaceId,
          })
        }
        setTerminalSession(terminalId, resolved)
        const directory = resolved?.workspaceId || fallbackDirectory
        const provider = (resolved?.provider || "").toLowerCase()
        if (directory && provider === "opencode") {
          ensureTerminalLogs(terminalId, directory)
        }
        if (!directory || !resolved?.sessionId || (provider && provider !== "opencode")) return
        ensureSessionMessages(directory, resolved.sessionId)
      })
      .catch((error) => {
        deps.debug.log("terminal summary load failed", { terminalId, error: errorText(error) })
      })
      .finally(() => {
        inflight.delete(key)
      })
  }

  return {
    terminalSession,
    terminalLog,
    ensureTerminalLogs,
    ensureSessionMessages,
    ensureTerminalSession,
  }
}
