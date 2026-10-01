import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { SubagentObservation, SubagentStatus } from "@claxedo/agent-runtime-contract"
import type { BackgroundTaskRef, BackgroundTaskStopResult } from "../../contract"
import { CodexChild, type ChildSpawn } from "./children"
import { childFramesDelivered, deliverChildFrame } from "./child-delivery"
import type { Entry } from "./entry"
import { CodexNoActiveTurnError } from "./errors"
import type { RpcMessage } from "./rpc"
import { codexCollabAgentCall, codexSubagentActivity, type CodexCollabAgentCall } from "./translate"

type Observed = Omit<SubagentObservation, "observationId" | "status">

function observeNativeChild(entry: Entry, child: CodexChild, id: string, status: SubagentStatus, fields: Partial<Observed> = {}) {
  return entry.broker.observeSubagent({ observationId: `codex:native:${child.threadId}:${id}`, harnessExecutionId: entry.session.binding.upstreamSessionId,
    stableCorrelationId: child.threadId, providerId: child.threadId, providerKind: "codex", mode: "background", transcript: { kind: "live" },
    status, ...fields })
}

function reportTo(entry: Entry): (error: unknown) => void {
  return (error) => entry.broker.reportFailure(error)
}

function spawnNative(entry: Entry, threadId: string, spawn: ChildSpawn): void {
  if (entry.children.has(threadId)) return
  const child = entry.children.add(new CodexChild(threadId, spawn))
  const { toolCallId, ...described } = spawn
  child.enqueue(async () => {
    const ref = await observeNativeChild(entry, child, `spawn:${toolCallId ?? threadId}`, "running",
      { ...described, ...(toolCallId ? { toolCallId, toolCallRole: "spawn" } : {}) })
    if (ref) entry.broker.associateChild(threadId, ref)
  }, reportTo(entry))
  for (const message of entry.children.claim(threadId)) codexChildFrame(entry, child, message)
}

function taskName(agentPath: string | undefined): string {
  return agentPath?.split("/").filter(Boolean).at(-1) ?? "Codex subagent"
}

function awaitInteraction(child: CodexChild | undefined, toolCallId: string): void {
  if (child && !child.calls.has(toolCallId)) child.interaction = toolCallId
}

function collabCall(entry: Entry, message: RpcMessage, call: CodexCollabAgentCall, fromSession: boolean): void {
  if (call.toolCallRole === "spawn") {
    if (message.method !== "item/completed") return
    for (const threadId of call.receiverThreadIds) spawnNative(entry, threadId, { ...(fromSession ? { toolCallId: call.id } : {}), label: "Codex subagent",
      ...(call.prompt ? { description: call.prompt } : {}), ...(call.model ? { subagentType: call.model } : {}) })
    return
  }
  for (const threadId of call.receiverThreadIds) {
    const child = entry.children.get(threadId)
    if (!child) continue
    if (fromSession) awaitInteraction(child, call.id)
    if (message.method === "item/completed" && call.statuses[threadId] === "killed") {
      child.enqueue(async () => { await observeNativeChild(entry, child, `shutdown:${call.id}`, "killed") }, reportTo(entry))
    }
  }
}

export function observeNativeChildren(entry: Entry, message: RpcMessage): void {
  if (message.method !== "item/started" && message.method !== "item/completed") return
  const params = asRecordOrEmpty(message.params)
  const sender = asString(params.threadId)
  const fromSession = sender === entry.session.binding.upstreamSessionId
  if (!fromSession && !entry.children.has(sender)) return
  const activity = codexSubagentActivity(params.item)
  if (activity?.kind === "started") spawnNative(entry, activity.agentThreadId, { ...(fromSession ? { toolCallId: activity.id } : {}), label: taskName(activity.agentPath) })
  if (activity?.kind === "interacted" && fromSession) awaitInteraction(entry.children.get(activity.agentThreadId), activity.id)
  const call = codexCollabAgentCall(params.item)
  if (call) collabCall(entry, message, call, fromSession)
}

function childTurnOutcome(turn: Record<string, unknown>): { status: SubagentStatus; label?: string } {
  const error = asString(asRecordOrEmpty(turn.error).message)
  if (turn.status === "failed" || (turn.status === "interrupted" && error)) return { status: "failed", label: error ?? "Codex subagent failed" }
  return { status: turn.status === "interrupted" ? "interrupted" : "completed" }
}

function childTurnStarted(entry: Entry, child: CodexChild, turnId: string): void {
  const reopened = child.state === "idle"
  child.turnId = turnId
  entry.children.move(child, "turn-started")
  if (!reopened) return
  const call = child.interaction ?? turnId
  child.interaction = undefined
  child.calls.add(call)
  child.enqueue(async () => { await observeNativeChild(entry, child, `${turnId}:running`, "running", { toolCallId: call, toolCallRole: "interaction" }) }, reportTo(entry))
}

function childTurnEnded(entry: Entry, child: CodexChild, turn: Record<string, unknown>): void {
  entry.children.move(child, "turn-ended")
  const outcome = childTurnOutcome(turn)
  child.outcome = outcome.status
  child.enqueue(async () => {
    await childFramesDelivered(entry)
    await observeNativeChild(entry, child, `${asString(turn.id) ?? "turn"}:${outcome.status}`, outcome.status, outcome.label ? { label: outcome.label } : {})
  }, reportTo(entry))
}

export function codexChildFrame(entry: Entry, child: CodexChild, message: RpcMessage): void {
  const turn = asRecordOrEmpty(asRecordOrEmpty(message.params).turn)
  const turnId = asString(turn.id)
  if (message.method === "turn/started" && turnId) childTurnStarted(entry, child, turnId)
  child.enqueue(() => deliverChildFrame(entry, child, message), reportTo(entry))
  if (message.method === "turn/completed") childTurnEnded(entry, child, turn)
}

export async function stopCodexChild(entry: Entry, task: BackgroundTaskRef): Promise<BackgroundTaskStopResult> {
  const child = entry.children.byCall(task.toolCallId)
  const notFound = { ok: false as const, status: "not_found" as const, message: `No running Codex subagent was started by ${task.toolCallId}` }
  if (!child || child.state !== "running" || !child.turnId) return notFound
  try { await entry.rpc.request("turn/interrupt", { threadId: child.threadId, turnId: child.turnId }) }
  catch (error) {
    if (error instanceof CodexNoActiveTurnError) return notFound
    throw error
  }
  return { ok: true }
}
