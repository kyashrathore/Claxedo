import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import { threadOf, type CodexHandlers } from "./frame"
import { harnessNotice } from "./notices"
import type { CodexAppServerAdapterState } from "./state"
import { turnUsage } from "./token-usage"

export function reportedModelKey(threadId: string, turnId?: string) {
  return turnId ? `${threadId}\0${turnId}` : threadId
}

export function codexReportedModel(method: string, payload: unknown): { threadId: string; turnId?: string; model: string } | undefined {
  const row = asRecord(payload) ?? {}
  const threadId = text(row.threadId)
  if (!threadId) return undefined
  if (method === "thread/settings/updated") {
    const model = text(asRecord(row.threadSettings)?.model)
    return model ? { threadId, model } : undefined
  }
  if (method === "model/rerouted") {
    const turnId = text(row.turnId)
    const model = text(row.toModel)
    return turnId && model ? { threadId, turnId, model } : undefined
  }
  return undefined
}

function recordReportedModel(state: CodexAppServerAdapterState, method: string, payload: unknown): CodexAppServerAdapterState {
  const reported = codexReportedModel(method, payload)
  if (!reported) return state
  return {
    ...state,
    reportedModels: boundKeyedRecord({ ...state.reportedModels, [reportedModelKey(reported.threadId, reported.turnId)]: reported.model }, RETAINED_WIRE_KEYS_MAX),
  }
}

export const usageHandlers: CodexHandlers = {
  "thread/tokenUsage/updated": ({ state, event, context, row }) => {
    const threadId = threadOf(event, context)
    const byThread = state.turnUsageByThread ?? {}
    const { [threadId]: _previous, ...otherThreads } = byThread
    const reported = state.reportedModels ?? {}
    const result = turnUsage(row, own(byThread, threadId), threadId, (turnId) =>
      (turnId ? own(reported, reportedModelKey(threadId, turnId)) : undefined) ?? own(reported, threadId))
    if (!result) return []
    return {
      state: {
        ...state,
        turnUsageByThread: boundKeyedRecord({ ...otherThreads, [threadId]: result.turnUsage }, RETAINED_WIRE_KEYS_MAX),
      },
      events: [result.event],
    }
  },
  "model/rerouted": ({ state, method, row }) => ({
    state: recordReportedModel(state, method, row),
    events: [harnessNotice({
      code: "codex_app_server.model_rerouted",
      message: `Model rerouted from ${text(row.fromModel) ?? "unknown"} to ${text(row.toModel) ?? "unknown"}`,
      severity: "info",
      details: row,
    })],
  }),
  "thread/settings/updated": ({ state, method, row }) => ({ state: recordReportedModel(state, method, row), events: [] }),
}
