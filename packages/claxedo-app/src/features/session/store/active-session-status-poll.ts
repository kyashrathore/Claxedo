import { queryOptions, useQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import type { AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-client"
import { paneQueryOptions, parkedPaneQueryOptions, type PaneQueryOptions } from "./pane-query-observer"
import { sessionStatusPollingRemovalGate, waitForActiveStatusPollDelay } from "./session-status-telemetry"

export const ACTIVE_SESSION_STATUS_POLL_DELAY_MS = 60_000
export const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000

type ActiveSessionStatusPollStartedKeys = Pick<Set<string>, "has" | "add">

export function activeSessionStatusPollScope(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
  return `${input.directory}\0${input.sessionID}`
}

export function activeSessionStatusPollRequestKey(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
  return ["runtime", "session-status-poll", input.directory, input.sessionID] as const
}

export async function waitForFirstActiveSessionStatusPoll(input: {
  key: string
  startedKeys: ActiveSessionStatusPollStartedKeys
  wait?: (delay: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}) {
  if (input.startedKeys.has(input.key)) return
  await (input.wait ?? waitForActiveStatusPollDelay)(ACTIVE_SESSION_STATUS_POLL_DELAY_MS, input.signal)
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
  input.startedKeys.add(input.key)
}

export function shouldStartActiveSessionStatusPolling(input: {
  directory?: string
  sessionID: string
}) {
  return activeSessionStatusPollingDecision(input).shouldStart
}

export function activeSessionStatusPollingDecision(input: {
  directory?: string
  sessionID: string
}) {
  const gate = sessionStatusPollingRemovalGate(input)
  return {
    shouldStart: !gate.canDisablePolling,
    ...gate,
  }
}

export function activeSessionStatusPollQueryOptions(input: {
  directory: AgentRuntimeDirectory
  sessionID: string
  enabled: boolean
  startedKeys: ActiveSessionStatusPollStartedKeys
  refresh: (signal: AbortSignal) => Promise<boolean>
}): PaneQueryOptions<boolean> {
  const scope = activeSessionStatusPollScope(input)
  return paneQueryOptions<boolean>(queryOptions({
    queryKey: activeSessionStatusPollRequestKey(input),
    queryFn: async ({ signal }) => {
      await waitForFirstActiveSessionStatusPoll({
        key: scope,
        startedKeys: input.startedKeys,
        signal,
      })
      return input.refresh(signal)
    },
    enabled: input.enabled,
    refetchInterval: ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    // This query owns a timer/request, not reusable session data. Once its
    // pane observer leaves, keeping its queryFn would retain the disposed Solid
    // owner and SDK graph for the global QueryClient's normal 30-minute gcTime.
    gcTime: 0,
  }))
}

export function createActiveSessionStatusPoll(input: {
  active: Accessor<boolean>
  directory: Accessor<AgentRuntimeDirectory>
  sessionID: Accessor<string | undefined>
  enabled: Accessor<boolean>
  refresh: (sessionID: string, signal: AbortSignal) => Promise<boolean>
}) {
  const startedKeys = new Set<string>()
  return useQuery<boolean>(() => {
    if (!input.active()) return parkedPaneQueryOptions<boolean>("active-status-poll", "inactive")
    const directory = input.directory()
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return parkedPaneQueryOptions<boolean>("active-status-poll", "no-session")
    return activeSessionStatusPollQueryOptions({
      directory,
      sessionID,
      enabled: input.enabled(),
      startedKeys,
      refresh: (signal) => input.refresh(sessionID, signal),
    })
  })
}
