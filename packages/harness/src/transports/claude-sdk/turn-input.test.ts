import { expect, test } from "bun:test"
import { ClaudeTurnInput } from "./turn-input"

const message = (text: string) => ({ type: "user" as const, session_id: "", message: {
  role: "user" as const, content: [{ type: "text" as const, text }],
}, parent_tool_use_id: null })

test("steering resolves only after the matching replay", async () => {
  const input = new ClaudeTurnInput(message("first"))
  const iterator = input.stream[Symbol.asyncIterator]()
  expect((await iterator.next()).value.message.content).toEqual([{ type: "text", text: "first" }])
  const accepted = input.steer(message("second"))
  const replay = (await iterator.next()).value
  expect(input.observe({ ...replay, uuid: "unrelated", isReplay: true })).toBe(true)
  let resolved = false
  void accepted.then(() => { resolved = true })
  await Promise.resolve()
  expect(resolved).toBe(false)
  input.close()
  expect(input.observe({ ...replay, isReplay: true })).toBe(true)
  expect(await accepted).toEqual({ ok: true })
  expect((await iterator.next()).done).toBe(true)
})

test.each(["ended", "failed"] as const)("an unreplayed steer settles %s", async (outcome) => {
  const input = new ClaudeTurnInput(message("first"))
  const pending = input.steer(message("second"))
  input.settle(outcome)
  expect(await pending).toMatchObject({ ok: false, status: outcome === "ended" ? "declined" : "unknown" })
  expect(await input.steer(message("late"))).toMatchObject({ ok: false, status: "no_active_turn" })
})
