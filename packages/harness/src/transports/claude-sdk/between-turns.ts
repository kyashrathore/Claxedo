import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { claudeTranslator, translateClaude } from "./events"
import type { ClaudeLiveQuery } from "./live-query"
import type { ClaudeEntry } from "./turns"

export function claudeChildDelivery(entry: ClaudeEntry, live: () => ClaudeLiveQuery): (frame: SDKMessage) => Promise<void> {
  let translator: ReturnType<typeof claudeTranslator> | undefined
  return async (frame) => {
    try {
      translator ??= claudeTranslator(entry.session.binding.sessionId, [], live().tasks, live().memory)
      for (const event of await translateClaude(frame, translator.runtime, translator.tasks, entry.broker)) await entry.broker.publishChild(event)
    } catch (error) {
      entry.broker.reportFailure(error)
    }
  }
}

export function claudeBackgroundWork(entry: ClaudeEntry): (active: boolean) => void {
  let published = Promise.resolve()
  return (active) => {
    published = published.then(() => entry.broker.publish({ type: "background-work", active }))
      .then(undefined, (error: unknown) => entry.broker.reportFailure(error))
  }
}
