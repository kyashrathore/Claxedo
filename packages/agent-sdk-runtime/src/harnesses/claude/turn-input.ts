import { randomUUID } from "node:crypto"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { SteerResult } from "../../adapter-contract"

export type ClaudeTurnPrompt = string | AsyncIterable<SDKUserMessage>

/**
 * The SDK's `Options` has no field for the CLI's `--replay-user-messages`, so
 * it travels through `extraArgs`, the SDK's pass-through for CLI flags. With it
 * the CLI echoes every user message it reads from stdin back on stdout as an
 * `SDKUserMessageReplay` (`isReplay: true`, same `uuid`) when it adds that
 * message to the conversation, next to the model request that carries it. That
 * echo is the only evidence that a steered message reached the model; a stdin
 * write alone proves nothing.
 *
 * Measured against Claude Code 2.1.280: a message written during a tool call
 * is replayed at the next tool boundary and answered inside the same turn; one
 * written during a text-only reply is replayed after that reply's `result` and
 * runs as a follow-on turn of the same query, even when stdin has already
 * closed. `priority: "now"` ends the running turn at the boundary instead, so
 * steered messages carry no priority.
 */
export const CLAUDE_TURN_INPUT_ARGS: Record<string, string | null> = { "replay-user-messages": null }

export type ClaudeTurnInput = {
  prompt: AsyncIterable<SDKUserMessage>
  /** Resolves once the CLI replays the message, or once the query ends without replaying it. */
  steer(prompt: ClaudeTurnPrompt): Promise<SteerResult>
  /** Consumes the CLI's replay of a stdin message; true when `message` was one. */
  observe(message: SDKMessage): boolean
  /** Closes the query's stdin. Already-written messages still run. */
  end(): void
  /**
   * Closes the input and answers every steer the CLI never replayed. A query
   * that ended on its own or was aborted never gave that message to the model;
   * one that failed may have, between committing it and echoing it.
   */
  settle(outcome: "ended" | "failed", message: string): void
}

export function claudeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  }
}

type PendingSteer = { unreplayed: Set<string>; resolve: (result: SteerResult) => void }

/**
 * The turn's input as a stream the driver holds open until `end()`.
 *
 * `query()` writes each yielded message to the CLI's stdin as it arrives and
 * closes stdin the moment the iterable RETURNS, so a generator that yields the
 * prompt and finishes, which is what a plain string prompt compiles to, can
 * never carry a second message.
 */
export function createClaudeTurnInput(opening: ClaudeTurnPrompt): ClaudeTurnInput {
  const pending: SDKUserMessage[] = []
  const waiters: Array<() => void> = []
  const steers = new Set<PendingSteer>()
  let ended = false
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve()
  }
  const collect = async (prompt: ClaudeTurnPrompt) => {
    if (typeof prompt === "string") return [claudeUserMessage(prompt)]
    const messages: SDKUserMessage[] = []
    for await (const message of prompt) messages.push(message)
    return messages
  }
  const opened = collect(opening).then((messages) => {
    pending.push(...messages)
    wake()
  })
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
    async steer(prompt) {
      const messages = (await collect(prompt)).map((message) => ({ ...message, uuid: randomUUID() }))
      if (ended) return { ok: false, status: "no_active_turn", message: "This Claude turn no longer accepts input" }
      const replayed = new Promise<SteerResult>((resolve) => {
        steers.add({ unreplayed: new Set(messages.map((message) => message.uuid)), resolve })
      })
      pending.push(...messages)
      wake()
      return await replayed
    },
    observe(message) {
      if (message.type !== "user" || !("isReplay" in message) || message.isReplay !== true) return false
      for (const steer of steers) {
        if (!steer.unreplayed.delete(message.uuid) || steer.unreplayed.size) continue
        steers.delete(steer)
        steer.resolve({ ok: true })
      }
      return true
    },
    end() {
      ended = true
      wake()
    },
    settle(outcome, message) {
      ended = true
      wake()
      for (const steer of steers) steer.resolve({ ok: false, status: outcome === "ended" ? "declined" : "unknown", message })
      steers.clear()
    },
  }
}
