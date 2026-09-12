import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

export type ClaudeTurnPrompt = string | AsyncIterable<SDKUserMessage>

export type ClaudeTurnInput = {
  prompt: AsyncIterable<SDKUserMessage>
  /** Writes another user message into the running query. */
  steer(prompt: ClaudeTurnPrompt): Promise<void>
  /** Closes the query's stdin. Already-written messages still run. */
  end(): void
}

export function claudeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  }
}

/**
 * The turn's input as a stream the driver holds open.
 *
 * `query()` writes each yielded message to the CLI's stdin as it arrives and
 * closes stdin the moment the iterable RETURNS, so a generator that yields the
 * prompt and finishes — which is what a plain string prompt compiles to — can
 * never carry a second message. Staying open until `end()` is what makes
 * steering reachable, and the driver ends it on the turn's result rather than
 * on the write, because a message already written is still run after stdin
 * closes.
 */
export function createClaudeTurnInput(opening: ClaudeTurnPrompt): ClaudeTurnInput {
  const pending: SDKUserMessage[] = []
  const waiters: Array<() => void> = []
  let ended = false
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve()
  }
  const push = async (prompt: ClaudeTurnPrompt) => {
    if (typeof prompt === "string") pending.push(claudeUserMessage(prompt))
    else for await (const message of prompt) pending.push(message)
    wake()
  }
  const opened = push(opening)
  return {
    prompt: {
      async *[Symbol.asyncIterator]() {
        await opened
        while (true) {
          const next = pending.shift()
          if (next) {
            yield next
            continue
          }
          if (ended) return
          await new Promise<void>((resolve) => waiters.push(resolve))
        }
      },
    },
    async steer(prompt: ClaudeTurnPrompt) {
      if (ended) throw new Error("This Claude turn no longer accepts input")
      await push(prompt)
    },
    end() {
      ended = true
      wake()
    },
  }
}
