import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { readRuntimeJson } from "./agent-runtime-json"
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

type AgentRuntimeGoalMutationFailure = Extract<AgentRuntimeGoalMutationResult, { ok: false }>

function isGoalMutationFailureStatus(status: string): status is AgentRuntimeGoalMutationFailure["status"] {
  return status === "unsupported" ||
    status === "unavailable" ||
    status === "not_found" ||
    status === "conflict" ||
    status === "failed"
}

/**
 * HTTP statuses the runtime uses to carry a TYPED goal-mutation failure body.
 *
 * `workspace-runtime` `routes/session-core.ts:goalMutationResponse` serializes
 * `{ ok: false, status, message }` under 404 (`not_found`), 502 (`failed`), and
 * 409 (everything else). Treating those as transport errors would make the
 * whole `ok: false` branch of `AgentRuntimeGoalMutationResult` unreachable, so
 * the client decodes them instead. Other statuses — and 404/409 bodies from
 * `goalRuntimeErrorResponse`, which are `{ error: { code, message } }` rather
 * than a mutation result — still throw.
 */
function carriesGoalMutationFailure(status: number) {
  return status === 404 || status === 409 || status === 502
}

function goalMutationFailure(body: unknown): AgentRuntimeGoalMutationFailure | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return
  const row = body as Record<string, unknown>
  if (row.ok !== false) return
  const status = row.status
  if (typeof status !== "string" || !isGoalMutationFailureStatus(status)) return
  return {
    ok: false,
    status,
    message: typeof row.message === "string" ? row.message : `Goal request failed: ${status}`,
  }
}

async function readGoalMutation(response: Response): Promise<AgentRuntimeGoalMutationResult> {
  if (response.ok) return await response.json()
  const text = await response.text()
  if (carriesGoalMutationFailure(response.status)) {
    const failure = goalMutationFailure(parseJsonBody(text))
    if (failure) return failure
  }
  throw new Error(text || `Request failed: ${response.status}`)
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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
  }) => readGoalMutation(await fetchSession({
    ...input,
    init: mutation(input.method, input.signal, input.body),
  }))

  return {
    async getGoalCapabilities(input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) {
      return readRuntimeJson<AgentRuntimeGoalCapabilities>(await fetchSession({
        ...input,
        suffix: "/goal/capabilities",
        init: { cache: "no-store", headers: { Accept: "application/json" }, signal: input.signal },
      }))
    },
    async getGoal(input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) {
      return readRuntimeJson<RuntimeGoalSnapshot | null>(await fetchSession({
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
