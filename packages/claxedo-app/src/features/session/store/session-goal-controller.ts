import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import type { SessionRef } from "@/platform/identity/session-ref"
import { queryClient } from "@/platform/query/query-client"
import { createActivePaneProjection } from "./active-pane-projection"
import {
  mutateSessionGoalData,
  observeSessionGoalInvalidation,
  sessionGoalAuthorityScope,
  sessionGoalKey,
  syncSessionGoalData,
  type SessionGoalData,
  type SessionGoalMutation,
} from "./session-goal-query"
import type { SessionGoalTransportScope } from "./session-transport"

export function createSessionGoalController(input: {
  active: Accessor<boolean>
  sessionID: Accessor<string | undefined>
  directory: Accessor<string>
  client: SessionGoalTransportScope["client"]
  serverUrl: Accessor<string | undefined>
  signedControlPlane?: Accessor<boolean | undefined>
  workspaceId?: Accessor<string | undefined>
  workspaceKind?: Accessor<"cloud" | "user-hosted" | undefined>
  sessionRef?: Accessor<SessionRef | undefined>
  source: Accessor<SessionGoalData | undefined>
  suppressed: (sessionID: string) => boolean
}) {
  const data = createActivePaneProjection({
    active: input.active,
    read: input.source,
    initial: undefined as ReturnType<typeof input.source>,
  })
  const request = (sessionID: string, signal?: AbortSignal) => {
    const signedControlPlane = input.signedControlPlane?.() ?? false
    return {
      client: input.client,
      directory: input.directory(),
      sessionID,
      claxedoServerUrl: input.serverUrl(),
      signedControlPlane,
      workspaceId: signedControlPlane ? input.workspaceId?.() : undefined,
      workspaceKind: signedControlPlane ? input.workspaceKind?.() : undefined,
      sessionRef: input.sessionRef?.(),
      signal,
    }
  }
  const sync = async (sessionID: string, opts?: { force?: boolean; signal?: AbortSignal }) => {
    if (input.suppressed(sessionID)) return false
    const transport = request(sessionID, opts?.signal)
    // A cached entry short-circuits the read, but only while it is still
    // TRUSTED. An SSE replay gap invalidates the entry, and skipping the refetch
    // there is what left a stale Goal status pinned until reload.
    const cached = queryClient.getQueryState<SessionGoalData>(sessionGoalKey(sessionGoalAuthorityScope(transport)))
    if (cached?.data !== undefined && !cached.isInvalidated && !opts?.force) return true
    return syncSessionGoalData({
      request: transport,
      currentSessionID: input.sessionID,
      currentDirectory: input.directory,
      signal: opts?.signal,
    })
  }
  const refreshGoal = (opts?: { force?: boolean; signal?: AbortSignal }) => {
    const sessionID = input.sessionID()
    return !sessionID || sessionID === "new" ? Promise.resolve(false) : sync(sessionID, opts)
  }
  // Give `invalidateSessionGoalData` something to actually re-read: the pane's
  // Goal query is a cache mirror, so invalidation on its own never refetches.
  createEffect(() => {
    if (!input.active()) return
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return
    onCleanup(observeSessionGoalInvalidation(
      sessionGoalAuthorityScope(request(sessionID)),
      () => { void sync(sessionID, { force: true }) },
    ))
  })
  const mutate = async (mutation: SessionGoalMutation) => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") throw new Error("A session is required to change a Goal")
    if (!await sync(sessionID)) throw new Error("Goal state is no longer current")
    return mutateSessionGoalData({ request: request(sessionID), mutation })
  }
  return {
    sync,
    actions: {
      goal: createMemo(() => data()?.goal),
      goalCapabilities: createMemo(() => data()?.capabilities),
      refreshGoal,
      pauseGoal: () => mutate("pause"),
      resumeGoal: () => mutate("resume"),
      stopGoal: () => mutate("stop"),
      deleteGoal: () => mutate("delete"),
    },
  }
}
