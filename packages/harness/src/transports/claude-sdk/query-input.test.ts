import { expect, test } from "bun:test"
import { ClaudeQueryInput } from "./query-input"

const message = (text: string) => ({ type: "user" as const, session_id: "", message: {
  role: "user" as const, content: [{ type: "text" as const, text }],
}, parent_tool_use_id: null })

function opened(first: ReturnType<typeof message>) {
  const input = new ClaudeQueryInput()
  input.write(first)
  return input
}

test("steering resolves only after the matching replay", async () => {
  const input = opened(message("first"))
  const iterator = input.stream[Symbol.asyncIterator]()
  expect((await iterator.next()).value.message.content).toEqual([{ type: "text", text: "first" }])
  const accepted = input.steer(message("second"), "msg_second")
  const replay = (await iterator.next()).value
  expect(replay.uuid).toBeString()
  expect(input.observe({ ...replay, uuid: "unrelated", isReplay: true })).toEqual([])
  let resolved = false
  void accepted.then(() => { resolved = true })
  await Promise.resolve()
  expect(resolved).toBe(false)
  input.close()
  expect(input.observe({ ...replay, isReplay: true })).toEqual(["msg_second"])
  expect(await accepted).toEqual({ ok: true })
  expect((await iterator.next()).done).toBe(true)
})

test.each(["ended", "failed"] as const)("an unreplayed steer settles %s", async (outcome) => {
  const input = opened(message("first"))
  const pending = input.steer(message("second"), "msg_second")
  input.close()
  input.settle(outcome)
  expect(await pending).toEqual({ ok: false, status: outcome === "ended" ? "declined" : "unknown", message: "Claude did not replay the steer" })
  expect(await input.steer(message("late"), "msg_late")).toMatchObject({ ok: false, status: "no_active_turn" })
})

test("ordinary user messages cannot acknowledge a steer", async () => {
  const input = opened(message("first"))
  const iterator = input.stream[Symbol.asyncIterator]()
  await iterator.next()
  const pending = input.steer(message("second"), "msg_second")
  const written = (await iterator.next()).value
  expect(input.observe(written)).toBeUndefined()
  input.close()
  input.settle("ended")
  expect(await pending).toMatchObject({ ok: false, status: "declined" })
})

test("closed stdin rejects a new steer while delivering the one already written", async () => {
  const input = opened(message("first"))
  const iterator = input.stream[Symbol.asyncIterator]()
  await iterator.next()
  const pending = input.steer(message("second"), "msg_second")
  input.close()
  expect(await input.steer(message("late"), "msg_late")).toMatchObject({ ok: false, status: "no_active_turn" })
  const written = (await iterator.next()).value
  expect(written.message.content).toEqual([{ type: "text", text: "second" }])
  expect(input.observe({ ...written, isReplay: true })).toEqual(["msg_second"])
  expect(await pending).toEqual({ ok: true })
  expect((await iterator.next()).done).toBe(true)
})

test("a turn ended on an open query refuses steers but keeps stdin open for the next turn", async () => {
  const input = opened(message("first"))
  const iterator = input.stream[Symbol.asyncIterator]()
  await iterator.next()
  input.endTurn()
  expect(await input.steer(message("late"), "msg_late")).toMatchObject({ ok: false, status: "no_active_turn" })
  input.write(message("next turn"))
  expect((await iterator.next()).value.message.content).toEqual([{ type: "text", text: "next turn" }])
  const steered = input.steer(message("steer the next turn"), "msg_steer")
  expect((await iterator.next()).value.message.content).toEqual([{ type: "text", text: "steer the next turn" }])
  input.settle("failed")
  expect(await steered).toMatchObject({ ok: false, status: "unknown" })
})

test.each(["cancelled", "discarded", "refused"] as const)("a steer Claude reports %s settles declined at once and no longer holds the turn open", async (state) => {
  const input = opened(message("first"))
  const iterator = input.stream[Symbol.asyncIterator]()
  const first = (await iterator.next()).value
  input.acknowledge({ ...first, isReplay: true })
  const pending = input.steer(message("second"), "msg_second")
  const written = (await iterator.next()).value
  expect(input.replayed).toBe(false)
  input.acknowledge({ type: "command_lifecycle", command_uuid: written.uuid, state, uuid: "frame", session_id: "s" } as never)
  expect(await pending).toEqual({ ok: false, status: "declined", message: `Claude ${state} the steer before taking it in` })
  expect(input.replayed).toBe(true)
})

test("a steer's queued and started lifecycle leaves it waiting for its replay", async () => {
  const input = opened(message("first"))
  const iterator = input.stream[Symbol.asyncIterator]()
  await iterator.next()
  const pending = input.steer(message("second"), "msg_second")
  const written = (await iterator.next()).value
  for (const state of ["queued", "started", "completed"]) input.acknowledge({ type: "command_lifecycle", command_uuid: written.uuid, state, uuid: "frame", session_id: "s" } as never)
  let settled = false
  void pending.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(input.observe({ ...written, isReplay: true })).toEqual(["msg_second"])
  expect(await pending).toEqual({ ok: true })
})
