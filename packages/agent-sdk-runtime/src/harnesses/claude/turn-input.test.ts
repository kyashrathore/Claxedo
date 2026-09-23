import { describe, expect, test } from "bun:test"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createClaudeTurnInput } from "./turn-input"

async function read(input: AsyncIterator<SDKUserMessage>) {
  const next = await input.next()
  if (next.done) throw new Error("the turn input closed")
  return next.value
}

function replayOf(message: SDKUserMessage) {
  return { ...message, session_id: "claude-session", isReplay: true } as unknown as SDKMessage
}

describe("the Claude turn input", () => {
  test("a steer resolves only when the CLI replays its uuid", async () => {
    const turn = createClaudeTurnInput("open")
    const input = turn.prompt[Symbol.asyncIterator]()
    const opening = await read(input)
    let answered = false
    const answer = turn.steer("more").then((result) => { answered = true; return result })
    const steered = await read(input)
    expect(steered.uuid).toBeString()

    expect(turn.observe(replayOf({ ...opening, uuid: "00000000-0000-4000-8000-000000000000" }))).toBe(true)
    await Promise.resolve()
    expect(answered).toBe(false)

    expect(turn.observe(replayOf(steered))).toBe(true)
    expect(await answer).toEqual({ ok: true })
  })

  test("ignores user messages that are not replays", () => {
    const turn = createClaudeTurnInput("open")
    expect(turn.observe({ type: "user", session_id: "s", parent_tool_use_id: null, message: { role: "user", content: "tool output" } } as SDKMessage)).toBe(false)
  })

  test("an unreplayed steer is declined when the query ends and unknown when it fails", async () => {
    const ended = createClaudeTurnInput("open")
    const endedInput = ended.prompt[Symbol.asyncIterator]()
    await read(endedInput)
    const declined = ended.steer("more")
    await read(endedInput)
    ended.settle("ended", "finished first")
    expect(await declined).toEqual({ ok: false, status: "declined", message: "finished first" })
    expect(await ended.steer("after")).toMatchObject({ ok: false, status: "no_active_turn" })

    const failed = createClaudeTurnInput("open")
    const failedInput = failed.prompt[Symbol.asyncIterator]()
    await read(failedInput)
    const unknown = failed.steer("more")
    await read(failedInput)
    failed.settle("failed", "process exited")
    expect(await unknown).toEqual({ ok: false, status: "unknown", message: "process exited" })
  })

  test("refuses a steer once stdin is closed, and still delivers one written before", async () => {
    const turn = createClaudeTurnInput("open")
    const input = turn.prompt[Symbol.asyncIterator]()
    await read(input)
    void turn.steer("written before close")
    await Promise.resolve()
    turn.end()
    expect(await turn.steer("too late")).toMatchObject({ ok: false, status: "no_active_turn" })
    expect((await read(input)).message.content).toEqual([{ type: "text", text: "written before close" }])
    expect(await input.next()).toMatchObject({ done: true })
  })
})
