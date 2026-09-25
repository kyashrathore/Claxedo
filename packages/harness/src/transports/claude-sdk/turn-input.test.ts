import { expect, test } from "bun:test"
import { ClaudeTurnInput } from "./turn-input"

test("steering resolves only after the matching replay", async () => {
  const input = new ClaudeTurnInput("first")
  const iterator = input.stream[Symbol.asyncIterator]()
  expect((await iterator.next()).value.message.content).toEqual([{ type: "text", text: "first" }])
  const accepted = input.steer("second")
  const message = (await iterator.next()).value
  expect(input.observe({ ...message, uuid: "unrelated", isReplay: true })).toBe(true)
  let resolved = false
  void accepted.then(() => { resolved = true })
  await Promise.resolve()
  expect(resolved).toBe(false)
  input.close()
  expect(input.observe({ ...message, isReplay: true })).toBe(true)
  expect(await accepted).toEqual({ ok: true })
  expect((await iterator.next()).done).toBe(true)
})

test.each(["ended", "failed"] as const)("an unreplayed steer settles %s", async (outcome) => {
  const input = new ClaudeTurnInput("first")
  const pending = input.steer("second")
  input.settle(outcome)
  expect(await pending).toMatchObject({ ok: false, status: outcome === "ended" ? "declined" : "unknown" })
  expect(await input.steer("late")).toMatchObject({ ok: false, status: "no_active_turn" })
})
