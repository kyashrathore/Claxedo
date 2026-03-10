import type { FileDiff, Session } from "@opencode-ai/sdk/v2"
import type { ReviewMode } from "./types"

export type ReviewPopoverMode = "session-turn" | "session" | "staged" | "uncommitted" | "to-from"

export type ReviewModeStats = {
  additions: number
  deletions: number
  files: number
  loading: boolean
  ready: boolean
  error?: string
}

export type ReviewContext = {
  directory: string
  sessionID?: string
  groupId: string
  activeType?: string
}

export type ReviewSourceMeta = {
  title: string
  sessionCount: number
  turnCount: number
  sessionChanges: {
    additions: number
    deletions: number
  }
  turnChanges: {
    additions: number
    deletions: number
  }
}

export const REVIEW_POPOVER_MODES = [
  "session-turn",
  "session",
  "staged",
  "uncommitted",
  "to-from",
] as const satisfies readonly ReviewPopoverMode[]

export const REVIEW_MODE_LABEL: Record<ReviewMode, string> = {
  "session-turn": "Session turn",
  session: "Session",
  staged: "Staged",
  uncommitted: "Uncommitted",
  "vs-base": "vs base (legacy)",
  "to-from": "to / from",
}

type Patch = Partial<ReviewModeStats>

type SessionClient = {
  diffTargets: (input: { directory: string }) => Promise<{ data?: { defaultRef?: string; candidates?: string[] } }>
  diff: (input: {
    sessionID: string
    directory: string
    mode: "staged" | "uncommitted" | "to-from"
    fromRef?: string
    toRef?: string
  }) => Promise<{ data?: FileDiff[] }>
}

function baseStats(): ReviewModeStats {
  return {
    additions: 0,
    deletions: 0,
    files: 0,
    loading: false,
    ready: false,
  }
}

export function sumChanges(diffs: FileDiff[]) {
  return diffs.reduce(
    (acc, diff) => ({
      additions: acc.additions + (diff.additions ?? 0),
      deletions: acc.deletions + (diff.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  )
}

export function pickPreviewSessionId(input: { directory: string; sessions: Session[]; preferred?: string }) {
  const list = input.sessions
    .filter((item) => item.directory === input.directory && !item.time.archived)
    .slice()
    .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
  if (input.preferred && list.some((item) => item.id === input.preferred)) return input.preferred
  return list[0]?.id
}

export function createReviewIntentAdapter(input: {
  session: SessionClient
  formatError: (error: unknown) => string
  debugErrorShape?: (error: unknown) => unknown
  log?: (event: string, payload?: Record<string, unknown>) => void
}) {
  let baseReq = 0
  let previewReq = 0
  const rowReq: Partial<Record<ReviewPopoverMode, number>> = {}
  const log = input.log ?? (() => undefined)

  const patchDiff = (
    mode: ReviewPopoverMode,
    diffs: FileDiff[],
    patch: (mode: ReviewPopoverMode, next: Patch) => void,
  ) => {
    patch(mode, {
      additions: diffs.reduce((sum, item) => sum + (item.additions ?? 0), 0),
      deletions: diffs.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
      files: diffs.length,
      loading: false,
      ready: true,
      error: undefined,
    })
  }

  const clearHiddenModeStats = (args: {
    allModes: readonly ReviewPopoverMode[]
    visibleModes: ReviewPopoverMode[]
    patch: (mode: ReviewPopoverMode, next: Patch) => void
  }) => {
    for (const mode of args.allModes) {
      if (args.visibleModes.includes(mode)) continue
      args.patch(mode, {
        loading: false,
        ready: false,
        error: undefined,
      })
    }
  }

  const syncSessionModeStats = (args: {
    visibleModes: ReviewPopoverMode[]
    source: ReviewSourceMeta | undefined
    patch: (mode: ReviewPopoverMode, next: Patch) => void
  }) => {
    if (args.visibleModes.includes("session-turn")) {
      if (args.source) {
        args.patch("session-turn", {
          additions: args.source.turnChanges.additions,
          deletions: args.source.turnChanges.deletions,
          files: args.source.turnCount,
          loading: false,
          ready: true,
          error: undefined,
        })
      } else {
        args.patch("session-turn", {
          ...baseStats(),
          error: "Open a session to review turn changes",
        })
      }
    }

    if (args.visibleModes.includes("session")) {
      if (args.source) {
        args.patch("session", {
          additions: args.source.sessionChanges.additions,
          deletions: args.source.sessionChanges.deletions,
          files: args.source.sessionCount,
          loading: false,
          ready: true,
          error: undefined,
        })
      } else {
        args.patch("session", {
          ...baseStats(),
          error: "Open a session to review session changes",
        })
      }
    }
  }

  const loadBaseTargets = async (args: {
    directory: string
    mode: ReviewPopoverMode
    reviewWorktree: string
    context: ReviewContext | undefined
    activeWorkspaceId: string | undefined
    activeSessionId: string | undefined
    routeDir: string | undefined
    routeTabId: string | undefined
    routeSessionId: string | undefined
  }) => {
    const directory = args.directory.trim()
    if (!directory) return { kind: "ignored" as const }

    const req = ++baseReq
    log("review base targets fetch start", {
      directory,
      mode: args.mode,
      reviewWorktree: args.reviewWorktree,
      contextDirectory: args.context?.directory,
      contextSessionID: args.context?.sessionID,
      contextGroupID: args.context?.groupId,
      contextActiveType: args.context?.activeType,
      activeWorkspaceId: args.activeWorkspaceId,
      activeSessionId: args.activeSessionId,
      routeDir: args.routeDir,
      routeTabId: args.routeTabId,
      routeSessionId: args.routeSessionId,
    })

    let failed: string | undefined
    const data = await input.session
      .diffTargets({ directory })
      .then((result) => result.data)
      .catch((error) => {
        failed = input.formatError(error)
        log("review base targets fetch failed", {
          directory,
          mode: args.mode,
          error: failed,
          detail: input.debugErrorShape?.(error),
        })
        return undefined
      })

    if (req !== baseReq) return { kind: "stale" as const }
    if (!data) {
      return {
        kind: "error" as const,
        message: failed,
        defaultRef: "",
        candidates: [] as string[],
      }
    }

    log("review base targets fetch success", {
      directory,
      defaultRef: data.defaultRef,
      candidates: data.candidates?.length ?? 0,
    })

    return {
      kind: "ok" as const,
      defaultRef: data.defaultRef ?? "",
      candidates: data.candidates ?? [],
    }
  }

  const refreshDiffModeStats = (args: {
    modes: ReviewPopoverMode[]
    directory: string | undefined
    sessionID: string | undefined
    from: string
    to: string
    context: ReviewContext | undefined
    patch: (mode: ReviewPopoverMode, next: Patch) => void
  }) => {
    const run = (
      mode: ReviewPopoverMode,
      sdkMode: "staged" | "uncommitted" | "to-from",
      fromRef?: string,
      toRef?: string,
    ) => {
      if (!args.directory) {
        args.patch(mode, {
          loading: false,
          ready: false,
          error: "Select a worktree",
        })
        return
      }

      if (!args.sessionID) {
        args.patch(mode, {
          loading: false,
          ready: false,
          error: "No session available in this worktree",
        })
        return
      }

      const req = ++previewReq
      rowReq[mode] = req
      args.patch(mode, {
        loading: true,
        ready: false,
        error: undefined,
      })

      log("review mode stats fetch start", {
        mode,
        sdkMode,
        directory: args.directory,
        sessionID: args.sessionID,
        contextDirectory: args.context?.directory,
        contextSessionID: args.context?.sessionID,
        contextGroupID: args.context?.groupId,
        contextActiveType: args.context?.activeType,
        fromRef,
        toRef,
      })

      void input.session
        .diff({
          sessionID: args.sessionID,
          directory: args.directory,
          mode: sdkMode,
          fromRef,
          toRef,
        })
        .then((result) => {
          if (rowReq[mode] !== req) return
          const diffs = result.data ?? []
          patchDiff(mode, diffs, args.patch)
          log("review mode stats fetch success", {
            mode,
            sdkMode,
            directory: args.directory,
            files: diffs.length,
          })
        })
        .catch((error) => {
          if (rowReq[mode] !== req) return
          const message = input.formatError(error)
          args.patch(mode, {
            loading: false,
            ready: false,
            error: message,
          })
          log("review mode stats fetch failed", {
            mode,
            sdkMode,
            directory: args.directory,
            sessionID: args.sessionID,
            fromRef,
            toRef,
            error: message,
            detail: input.debugErrorShape?.(error),
          })
        })
    }

    for (const mode of args.modes) {
      if (mode === "staged") {
        run(mode, "staged")
        continue
      }

      if (mode === "uncommitted") {
        run(mode, "uncommitted")
        continue
      }

      if (mode === "to-from") {
        if (!args.from || !args.to) {
          args.patch(mode, {
            loading: false,
            ready: false,
            error: "Enter from and to refs",
          })
          continue
        }
        run(mode, "to-from", args.from, args.to)
      }
    }
  }

  return {
    clearHiddenModeStats,
    syncSessionModeStats,
    loadBaseTargets,
    refreshDiffModeStats,
  }
}
