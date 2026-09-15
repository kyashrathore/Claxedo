import { describe, expect, test } from "bun:test"
import { AgentRuntimeRequestError } from "@/platform/runtime/agent/agent-runtime-request-error"
import { replaceQueuedPrompt } from "./submit-queued-edit"

function harness(replace: () => Promise<void>) {
  const calls = { clearEdit: 0, clearInput: 0, failed: [] as unknown[] }
  const run = () => replaceQueuedPrompt({
    edit: { seq: 3, messageId: "msg_3" },
    parts: [{ type: "text", text: "edited" }],
    replace,
    clearEdit: () => { calls.clearEdit += 1 },
    clearInput: () => { calls.clearInput += 1 },
    showFailed: (err) => { calls.failed.push(err) },
  })
  return { calls, run }
}

describe("replaceQueuedPrompt", () => {
  test("a replaced message clears the draft and the edit, and the send is done", async () => {
    const sent: unknown[] = []
    const { calls, run } = harness(async () => { sent.push("replace") })
    expect(await run()).toBe(true)
    expect(sent).toEqual(["replace"])
    expect(calls).toEqual({ clearEdit: 1, clearInput: 1, failed: [] })
  })

  test("a message the runtime no longer holds ends the edit and hands the draft back as a new send", async () => {
    const { calls, run } = harness(async () => { throw new AgentRuntimeRequestError("gone", 409) })
    expect(await run()).toBe(false)
    expect(calls).toEqual({ clearEdit: 1, clearInput: 0, failed: [] })
  })

  test("any other failure keeps both the draft and the edit so the send can be retried", async () => {
    const failure = new AgentRuntimeRequestError("offline", 503)
    const { calls, run } = harness(async () => { throw failure })
    expect(await run()).toBe(true)
    expect(calls).toEqual({ clearEdit: 0, clearInput: 0, failed: [failure] })
  })
})
