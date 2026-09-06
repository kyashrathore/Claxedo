import { describe, expect, test } from "bun:test"
import { dispatchPrompt } from "./dispatch"
import type { PromptDispatchPayload } from "./types"

// Rubric T2: per-phase test coverage for `session/submit/*`. The dispatch
// phase is the thin boundary between phase orchestration and the chosen
// session client: it forwards the payload to promptAsync and lets errors
// bubble.

const payload: PromptDispatchPayload = {
  sessionID: "ses_1",
  directory: "/repo/main",
  agent: "build",
  model: { providerID: "anthropic", modelID: "sonnet" },
  messageID: "msg_1",
  parts: [],
}

describe("dispatchPrompt", () => {
  test("forwards the payload to promptAsync", async () => {
    const sent: unknown[] = []
    await dispatchPrompt({
      client: {
        session: {
          promptAsync: async (input) => {
            sent.push(input)
            return undefined
          },
        },
      },
      payload,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe(payload)
  })

  test("bubbles errors from promptAsync", async () => {
    let caught: unknown
    try {
      await dispatchPrompt({
        client: {
          session: {
            promptAsync: async () => {
              throw new Error("network blip")
            },
          },
        },
        payload,
      })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe("network blip")
  })
})
