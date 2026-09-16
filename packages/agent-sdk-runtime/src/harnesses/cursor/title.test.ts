import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@cursor/sdk"
import { generateCursorTitle } from "./title"

const request = { directory: "/work", system: "Name it", user: "User: add leap-year tests", signal: new AbortController().signal }

function fakeAgent(messages: SDKMessage[], options: { failSend?: boolean } = {}) {
  const calls: string[] = []
  const agent = {
    agentId: "title-agent",
    async send(message: string, sendOptions?: { model?: { id: string } }) {
      calls.push(`send:${message.split("\n")[0]}:${sendOptions?.model?.id ?? "-"}`)
      if (options.failSend) throw new Error("no model")
      return {
        async *stream() { yield* messages },
        async wait() { return { status: "finished" } },
        async cancel() { calls.push("cancel") },
      }
    },
    close() { calls.push("close") },
  }
  return { agent, calls }
}

const assistant = (text: string): SDKMessage => ({
  type: "assistant",
  agent_id: "title-agent",
  run_id: "run-1",
  message: { role: "assistant", content: [{ type: "text", text }] },
} as SDKMessage)

describe("generateCursorTitle", () => {
  test("sends one prompt on a throwaway local agent, returns the reply text, closes the agent", async () => {
    const { agent, calls } = fakeAgent([assistant("Add "), assistant("leap-year tests")])
    await expect(generateCursorTitle({ request, model: { id: "auto" }, createAgent: async () => agent })).resolves.toBe("Add leap-year tests")
    expect(calls).toEqual(["send:Name it:auto", "close"])
  })

  test("a failed run yields null and still closes the agent", async () => {
    const { agent, calls } = fakeAgent([], { failSend: true })
    await expect(generateCursorTitle({ request, createAgent: async () => agent })).resolves.toBeNull()
    expect(calls).toEqual(["send:Name it:-", "close"])
  })
})
