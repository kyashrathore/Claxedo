import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai"
import type { StreamFn } from "@mariozechner/pi-agent-core"

/** Scripted pi worker: each call streams the next queued output as one assistant turn. */
export function piWorkerStream(outputs: string[], calls: string[]): StreamFn {
  return (model, context) => {
    calls.push(JSON.stringify(context.messages.at(-1)))
    const text = outputs.shift() ?? "work"
    const stream = createAssistantMessageEventStream()
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }
    queueMicrotask(() => {
      stream.push({ type: "start", partial: base })
      stream.push({ type: "text_start", contentIndex: 0, partial: base })
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: base })
      const done = { ...base, content: [{ type: "text" as const, text }] }
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: done })
      stream.push({ type: "done", reason: "stop", message: done })
      stream.end(done)
    })
    return stream
  }
}
