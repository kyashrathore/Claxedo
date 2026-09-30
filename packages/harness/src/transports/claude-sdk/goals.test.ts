import { expect, test } from "bun:test"
import { background, collect, frame, init, rebound, reply, result, setup, texts, turnBroker, until, userTurn } from "./test-support/live"

const activeGoal = () => frame({ type: "active_goal", value: { condition: "Ship", iterations: 1, set_at: 1_700_000_000, tokens_at_start: 0 } })
const cleared = () => frame({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "Goal cleared" })
const interrupted = () => frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, terminal_reason: "aborted_streaming", errors: [] })

async function goalStarted() {
  const context = await setup()
  const started = context.transport.goals.start(context.session, "Ship")
  await until(() => context.launches[0]?.prompts.length === 1)
  const claude = context.launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(activeGoal())
  expect(await started).toMatchObject({ ok: true, goal: { objective: "Ship", status: "active" } })
  return { ...context, claude }
}

test("a native Goal is a turn on the session's Claude process, answered with the Goal Claude reported", async () => {
  const { transport, claude, own, launches } = await goalStarted()
  expect(claude.prompts).toEqual(["/goal Ship"])
  claude.frames.push(reply("working on it"))
  claude.frames.push(result())
  await own[0]!.done
  expect(own[0]!.input).toEqual({ reason: "goal" })
  expect(texts(own[0]!.events).join()).toContain("working on it")
  expect(launches).toHaveLength(1)
  claude.frames.end()
  await transport.dispose()
})

test("a Goal started while a background task lingers runs on that same process", async () => {
  const { transport, session, launches } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start the job"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("job"))
  claude.frames.push(result())
  await first
  const started = transport.goals.start(rebound(session), "Ship")
  await until(() => claude.prompts.length === 2)
  claude.frames.push(init())
  claude.replay(1)
  claude.frames.push(activeGoal())
  expect((await started).ok).toBe(true)
  expect(launches).toHaveLength(1)
  expect(claude.controls).toEqual([])
  claude.frames.push(result())
  claude.frames.push(background())
  claude.frames.end()
  await transport.dispose()
})

test("a Goal whose turn fails clears the native Goal so Claude stops pursuing it, and blocks it", async () => {
  const { transport, claude, own, goals, launches } = await goalStarted()
  claude.frames.fail(new Error("Claude Code process exited with code 1"))
  await own[0]!.done
  await until(() => launches[1]?.prompts.length === 1)
  expect(launches[1]!.prompts).toEqual(["/goal clear"])
  launches[1]!.frames.push(init())
  launches[1]!.replay(0)
  launches[1]!.frames.push(cleared())
  await until(() => goals.at(-1)?.status === "blocked")
  expect(goals.at(-1)).toMatchObject({ status: "blocked", lastReason: "Error: Claude Code process exited with code 1" })
  launches[1]!.frames.end()
  await transport.dispose()
})

test("stop interrupts the Goal turn, which then does not report success, and clears and pauses the Goal", async () => {
  const { transport, session, claude, own, launches } = await goalStarted()
  const stopped = transport.goals.stop(rebound(session))
  await until(() => claude.controls.includes("interrupt"))
  claude.frames.push(interrupted())
  await own[0]!.done
  expect(own[0]!.events.some(({ event }) => event.type === "finish")).toBe(false)
  await claude.stdinClosed
  claude.frames.end()
  await until(() => launches[1]?.prompts.length === 1)
  expect(launches[1]!.prompts).toEqual(["/goal clear"])
  launches[1]!.frames.push(init())
  launches[1]!.replay(0)
  launches[1]!.frames.push(cleared())
  expect(await stopped).toMatchObject({ ok: true, goal: { status: "paused" } })
  launches[1]!.frames.end()
  await transport.dispose()
})

test("a Goal whose work goes to the background stays active while its process lingers and pauses once nothing runs it", async () => {
  const { transport, claude, own, goals } = await goalStarted()
  claude.frames.push(background("job"))
  claude.frames.push(result())
  await own[0]!.done
  expect(goals.at(-1)?.status).toBe("active")
  expect(claude.stdinOpen()).toBe(true)
  claude.frames.push(background())
  await claude.stdinClosed
  claude.frames.end()
  await until(() => goals.at(-1)?.status === "paused")
  await transport.dispose()
})
