import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { RoutedEvent, TurnBroker, TurnInput } from "../../contract"
import { claudeProcessFailed, claudeStreamEndedWithoutResult } from "./errors"
import { claudeTranslator, translateClaude } from "./events"
import type { ClaudeClaim, ClaudeLiveQuery } from "./live-query"
import { ClaudeMirroredUsage } from "./mirrored-usage"
import { observeClaudeSessionMessage } from "./session-events"
import type { ClaudeEntry } from "./turns"

export type ClaudeScope = { assistantMessageId: string; todos: TurnInput["todos"]; broker: TurnBroker; signal: AbortSignal; final: boolean }

async function* claimedFrames(live: ClaudeLiveQuery, claim: ClaudeClaim) {
  try {
    for await (const frame of claim.frames) yield frame
  } catch (error) {
    throw claudeProcessFailed(error, live.stderr)
  }
}

export async function* translatedClaim(entry: ClaudeEntry, live: ClaudeLiveQuery, claim: ClaudeClaim, scope: ClaudeScope): AsyncGenerator<RoutedEvent, boolean> {
  if (claim.dropped) yield claim.dropped
  await live.childrenDelivered
  const { runtime, tasks } = claudeTranslator(scope.assistantMessageId, scope.todos, live.tasks)
  const mirroredUsage = new ClaudeMirroredUsage(runtime, { broker: entry.broker, assistantMessageId: scope.assistantMessageId, directory: entry.input.directory })
  live.usage.target(mirroredUsage)
  try {
    let result: SDKMessage | undefined
    for await (const message of claimedFrames(live, claim)) {
      const observed = await observeClaudeSessionMessage(message, entry, entry.broker, scope.signal)
      if (observed.kind === "active-goal") continue
      const incorporated = live.input.observe(observed.message)
      if (incorporated) {
        for (const messageId of incorporated) yield { event: { type: "input-incorporated", messageId } }
        continue
      }
      if (observed.message.type === "result") { result = observed.message; continue }
      if (observed.message.type === "system" && observed.message.subtype === "elicitation_complete") await scope.broker.completeElicitation(observed.message.elicitation_id)
      for (const event of await translateClaude(observed.message, runtime, tasks, scope.broker)) yield event
    }
    if (!scope.final) return true
    if (result) {
      mirroredUsage.release()
      for (const event of await translateClaude(result, runtime, tasks, scope.broker)) yield event
    }
    if (!result && !scope.signal.aborted) throw claudeStreamEndedWithoutResult()
    return true
  } finally { mirroredUsage.release() }
}

export async function commandResult(entry: ClaudeEntry, claim: ClaudeClaim, signal: AbortSignal): Promise<SDKMessage | undefined> {
  let result: SDKMessage | undefined
  for await (const frame of claim.frames) {
    const observed = await observeClaudeSessionMessage(frame, entry, entry.broker, signal)
    if (observed.kind === "message" && observed.message.type === "result") result = observed.message
  }
  return result
}
