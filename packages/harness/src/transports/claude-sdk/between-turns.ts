import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { NO_BACKGROUND_WORK, type BackgroundWork } from "@claxedo/agent-runtime-contract"
import { claudeTranslator, translateClaude } from "./events"
import type { ClaudeLiveQuery } from "./live-query"
import type { ClaudeEntry } from "./turns"

export function claudeOutsideTurnDelivery(entry: ClaudeEntry, live: () => ClaudeLiveQuery): (frame: SDKMessage) => () => Promise<void> {
  let translator: { live: ClaudeLiveQuery; runtime: ReturnType<typeof claudeTranslator>["runtime"] } | undefined
  return (frame) => {
    const current = live()
    const assistantMessageId = current.transcriptOwner
    return async () => {
      try {
        if (translator?.live !== current) translator = { live: current, runtime: claudeTranslator(entry.session.binding.sessionId, [], current.tasks, current.memory).runtime }
        for (const event of await translateClaude(frame, translator.runtime, current.tasks, entry.broker)) {
          if (event.route?.kind === "child") await entry.broker.publishChild(event)
          else if (event.event.type === "harness-notice" || event.event.type === "agent-message" || event.event.type === "diagnostic") {
            await entry.broker.publish(event.event, assistantMessageId)
          }
        }
      } catch (error) {
        entry.broker.reportFailure(error)
      }
    }
  }
}

export type ClaudeBackgroundTask = { task_id: string; task_type: string; ambient?: boolean }

export function countBackgroundTasks(tasks: readonly ClaudeBackgroundTask[]): BackgroundWork {
  const work = { ...NO_BACKGROUND_WORK }
  for (const task of tasks) {
    if (task.ambient) continue
    if (task.task_type.endsWith("_agent")) work.agents++
    else if (task.task_type === "local_bash") work.shells++
    else work.other++
  }
  return work
}

export function claudeBackgroundWork(entry: ClaudeEntry): (work: BackgroundWork) => void {
  let published = Promise.resolve()
  return (work) => {
    published = published.then(() => entry.broker.publish({ type: "background-work", ...work }))
      .then(undefined, (error: unknown) => entry.broker.reportFailure(error))
  }
}
