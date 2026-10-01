import type { Frame } from "./protocol"

const usage = (tokens: number) => ({ totalTokens: tokens * 2, inputTokens: tokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: tokens, reasoningOutputTokens: 0 })

export function subAgentActivity(method: "item/started" | "item/completed", parent: string, parentTurn: string,
  item: { id: string; kind: "started" | "interacted" | "interrupted" | "completed"; agentThreadId: string; agentPath: string }): Frame {
  return { method, params: { item: { type: "subAgentActivity", ...item }, threadId: parent, turnId: parentTurn,
    ...(method === "item/started" ? { startedAtMs: 1790756094662 } : { completedAtMs: 1790756094662 }) } }
}

export function collabAgentToolCall(method: "item/started" | "item/completed", parent: string, parentTurn: string,
  item: { id: string; tool: string; receiverThreadIds: string[]; prompt: string | null; agentsStates: Record<string, { status: string; message: null }> }): Frame {
  return { method, params: { item: { type: "collabAgentToolCall", status: method === "item/started" ? "inProgress" : "completed",
    senderThreadId: parent, model: method === "item/started" ? "" : "gpt-4.1", reasoningEffort: "medium", ...item }, threadId: parent, turnId: parentTurn } }
}

export function turnStarted(threadId: string, turnId: string): Frame {
  return { method: "turn/started", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null,
    startedAt: 1790756210, completedAt: null, durationMs: null } } }
}

export function turnCompleted(threadId: string, turnId: string, status = "completed", error: unknown = null): Frame {
  return { method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "summary", status, error,
    startedAt: 1790756210, completedAt: 1790756210, durationMs: 13 } } }
}

export function agentMessage(threadId: string, turnId: string, id: string, text: string): Frame[] {
  const item = (value: string) => ({ type: "agentMessage", id, text: value, phase: null, memoryCitation: null, delivery: null, questions: null })
  return [
    { method: "item/started", params: { item: item(""), threadId, turnId, startedAtMs: 1790756210446 } },
    { method: "item/agentMessage/delta", params: { threadId, turnId, itemId: id, delta: text } },
    { method: "item/completed", params: { item: item(text), threadId, turnId, completedAtMs: 1790756210446 } },
  ]
}

export function tokenUsage(threadId: string, turnId: string, total: number, last: number): Frame {
  return { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: usage(total), last: usage(last), modelContextWindow: 258400 } } }
}
