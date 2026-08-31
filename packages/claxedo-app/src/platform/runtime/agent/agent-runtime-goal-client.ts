import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeDirectory } from "./agent-runtime-urls"

export type AgentRuntimeGoalAction = "pause" | "resume" | "delete"
export type AgentRuntimeGoalOptionalField = "tokenBudget" | "tokensUsed" | "timeUsedSeconds" | "iteration" | "lastReason"
export type AgentRuntimeGoalCapabilities = {
  implemented: boolean
  available: boolean
  unavailableReason?: string
  actions: readonly AgentRuntimeGoalAction[]
  recovery: "reconcile" | "blocked"
  optionalFields: readonly AgentRuntimeGoalOptionalField[]
}
export type AgentRuntimeGoalMutationResult =
  | { ok: true; goal: RuntimeGoalSnapshot | null }
  | { ok: false; status: "unsupported" | "unavailable" | "not_found" | "conflict" | "failed"; message: string }

export function supportsAgentRuntimeGoalAction(
  capabilities: Pick<AgentRuntimeGoalCapabilities, "implemented" | "available" | "actions">,
  action: AgentRuntimeGoalAction,
) {
  if (!capabilities.implemented || !capabilities.available) return false
  if (action === "pause" || action === "resume") {
    return capabilities.actions.includes("pause") && capabilities.actions.includes("resume")
  }
  return capabilities.actions.includes(action)
}

type FetchRuntimeSession = (input: {
  sessionID: string
  directory: AgentRuntimeDirectory
  suffix?: string
  init?: RequestInit
}) => Promise<Response>

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return await response.json()
  throw new Error((await response.text()) || `Request failed: ${response.status}`)
}

function mutation(method: "POST" | "DELETE", signal?: AbortSignal, body?: unknown): RequestInit {
  return {
    method,
    signal,
    ...(method === "POST" ? {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    } : {}),
  }
}

export function createAgentRuntimeGoalClient(fetchSession: FetchRuntimeSession) {
  const mutate = async (input: {
    directory: AgentRuntimeDirectory
    sessionID: string
    suffix?: string
    method: "POST" | "DELETE"
    signal?: AbortSignal
    body?: unknown
  }) => readJson<AgentRuntimeGoalMutationResult>(await fetchSession({
    ...input,
    init: mutation(input.method, input.signal, input.body),
  }))

  return {
    async getGoalCapabilities(input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) {
      return readJson<AgentRuntimeGoalCapabilities>(await fetchSession({
        ...input,
        suffix: "/goal/capabilities",
        init: { cache: "no-store", headers: { Accept: "application/json" }, signal: input.signal },
      }))
    },
    async getGoal(input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) {
      return readJson<RuntimeGoalSnapshot | null>(await fetchSession({
        ...input,
        suffix: "/goal",
        init: { cache: "no-store", headers: { Accept: "application/json" }, signal: input.signal },
      }))
    },
    startGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; objective: string; signal?: AbortSignal }) =>
      mutate({ ...input, suffix: "/goal", method: "POST", body: { objective: input.objective } }),
    pauseGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) =>
      mutate({ ...input, suffix: "/goal/pause", method: "POST" }),
    resumeGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) =>
      mutate({ ...input, suffix: "/goal/resume", method: "POST" }),
    stopGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) =>
      mutate({ ...input, suffix: "/goal/stop", method: "POST" }),
    deleteGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) =>
      mutate({ ...input, suffix: "/goal", method: "DELETE" }),
  }
}
