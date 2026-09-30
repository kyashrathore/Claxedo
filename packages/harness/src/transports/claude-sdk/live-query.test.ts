import { expect, test } from "bun:test"
import type { TurnBroker } from "../../contract"
import { ClaudeSdkTransport } from "./index"
import { background, collect, frame, init, input, notification, rebound, reply, result, scriptedLaunches, services, sessionBroker, setup,
  texts, turnBroker, until, userTurn } from "./test-support/live"

test("a turn with no background task closes Claude's stdin at its result and ends there", async () => {
  const { transport, session, launches } = await setup()
  const turn = collect(transport.send(session, userTurn("t1", "hello"), turnBroker()))
  await until(() => launches.length === 1 && launches[0]!.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(reply("hi"))
  claude.frames.push(result())
  await claude.stdinClosed
  expect(texts(await turn).join()).toContain("hi")
  claude.frames.end()
  await transport.dispose()
})

test("a turn that leaves a background task running ends at its result with stdin open, and Claude's own turn after the task arrives as a provider turn", async () => {
  const { transport, session, launches, own } = await setup()
  const turn = collect(transport.send(session, userTurn("t1", "start the job"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("job"))
  claude.frames.push(reply("started"))
  claude.frames.push(result())
  const events = await turn
  expect(texts(events).join()).toContain("started")
  expect(claude.stdinOpen()).toBe(true)
  expect(own).toHaveLength(0)

  claude.frames.push(background())
  claude.frames.push(notification("job"))
  await claude.stdinClosed
  claude.frames.push(init())
  claude.frames.push(reply("the job finished"))
  claude.frames.push(result())
  await until(() => own.length === 1)
  claude.frames.end()
  await own[0]!.done
  expect(own[0]!.input).toEqual({ reason: "provider" })
  expect(texts(own[0]!.events).join()).toContain("the job finished")
  expect(launches).toHaveLength(1)
  await transport.dispose()
})

test("a message sent while a background task runs goes to the same Claude process", async () => {
  const { transport, session, launches, own } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start the job"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("job"))
  claude.frames.push(result())
  await first

  const second = collect(transport.send(rebound(session), userTurn("t2", "and another thing"), turnBroker()))
  await until(() => claude.prompts.length === 2)
  expect(claude.prompts).toEqual(["start the job", "and another thing"])
  claude.frames.push(init())
  claude.replay(1)
  claude.frames.push(reply("answering while the job runs"))
  claude.frames.push(result())
  expect(texts(await second).join()).toContain("answering while the job runs")
  expect(claude.stdinOpen()).toBe(true)
  expect(launches).toHaveLength(1)
  expect(own).toHaveLength(0)

  claude.frames.push(background())
  await claude.stdinClosed
  claude.frames.end()
  await transport.dispose()
})

test("a message whose launch differs stops the lingering process's background tasks, takes its last report, and starts a new process", async () => {
  const { transport, session, launches, own } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start the job"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("job"))
  claude.frames.push(result())
  await first

  const second = collect(transport.send(rebound(session), userTurn("t2", "switch models", "sonnet"), turnBroker()))
  await claude.stdinClosed
  expect(claude.controls).toEqual(["stop job"])
  claude.frames.push(background())
  claude.frames.push(notification("job"))
  claude.frames.push(init())
  claude.frames.push(reply("the job was stopped"))
  claude.frames.push(result())
  claude.frames.end()
  await until(() => launches.length === 2 && launches[1]!.prompts.length === 1)
  expect(launches[1]!.prompts).toEqual(["switch models"])
  launches[1]!.frames.push(init())
  launches[1]!.replay(0)
  launches[1]!.frames.push(reply("on sonnet"))
  launches[1]!.frames.push(result())
  await launches[1]!.stdinClosed
  const events = texts(await second).join()
  expect(events).toContain("the job was stopped")
  expect(events).toContain("on sonnet")
  expect(own).toHaveLength(0)
  launches[1]!.frames.end()
  await transport.dispose()
})

test("bookkeeping frames between turns wait for Claude's own turn instead of opening one", async () => {
  const { transport, session, launches, own } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start two jobs"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("one", "two"))
  claude.frames.push(result())
  await first

  claude.frames.push(background("two"))
  claude.frames.push(notification("one"))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(own).toHaveLength(0)
  expect(claude.stdinOpen()).toBe(true)
  claude.frames.push(init())
  claude.frames.push(reply("one is done"))
  claude.frames.push(result())
  await until(() => own.length === 1)
  await until(() => texts(own[0]!.events).join().includes("one is done"))
  expect(claude.stdinOpen()).toBe(true)

  claude.frames.push(background())
  await claude.stdinClosed
  claude.frames.end()
  await own[0]!.done
  await transport.dispose()
})

const deadline = (ms: number) => ({ at: Date.now() + ms, signal: new AbortController().signal })

test("a launch that fails leaves the session able to run its next turn", async () => {
  const { launches, launcher } = scriptedLaunches({ failFirst: new Error("expired credential") })
  const sessions = sessionBroker()
  const transport = new ClaudeSdkTransport(services, { executable: "claude", configRoot: "/tmp/claude-test", userConfigRoot: "/tmp/claude-user", env: {} })
  Object.assign(transport, { launcher })
  const session = await transport.start(input, sessions.broker)
  await expect(collect(transport.send(session, userTurn("t1", "hello"), turnBroker()))).rejects.toThrow("expired credential")
  const second = collect(transport.send(session, userTurn("t2", "again"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  launches[0]!.frames.push(init())
  launches[0]!.replay(0)
  launches[0]!.frames.push(reply("back"))
  launches[0]!.frames.push(result())
  expect(texts(await second).join()).toContain("back")
  launches[0]!.frames.end()
  await transport.dispose()
})

test("a turn ends at its result even when the process then exits with an error", async () => {
  const { transport, session, launches } = await setup()
  const turn = collect(transport.send(session, userTurn("t1", "hello"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(reply("done"))
  claude.frames.push(result())
  await claude.stdinClosed
  claude.frames.fail(new Error("Claude Code process exited with code 1"))
  expect(texts(await turn).join()).toContain("done")
  await transport.dispose()
})

test("a prompt that races Claude's own turn waits past Claude's result for the answer to its own prompt", async () => {
  const { transport, session, launches, own, setBusy } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start two jobs"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("one", "two"))
  claude.frames.push(result())
  await first

  setBusy(true)
  claude.frames.push(background("two"))
  claude.frames.push(notification("one"))
  claude.frames.push(init())
  const second = collect(transport.send(rebound(session), userTurn("t2", "what about the other one?"), turnBroker()))
  await until(() => claude.prompts.length === 2)
  claude.frames.push(reply("one is done"))
  claude.frames.push(result())
  claude.frames.push(init())
  claude.replay(1)
  claude.frames.push(reply("two is still running"))
  claude.frames.push(result())
  const events = texts(await second).join()
  expect(events).toContain("one is done")
  expect(events).toContain("two is still running")
  expect(own).toHaveLength(0)
  expect(launches).toHaveLength(1)
  claude.frames.push(background())
  await claude.stdinClosed
  claude.frames.end()
  await transport.dispose()
})

test("a turn whose translation fails before its result ends the process instead of leaving it running unread", async () => {
  const { transport, session, launches } = await setup()
  const failing = { ...turnBroker(), observeSubagent: async () => { throw new Error("store refused the subagent") } } as unknown as TurnBroker
  const turn = collect(transport.send(session, userTurn("t1", "spawn"), failing))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(frame({ type: "assistant", parent_tool_use_id: null, message: { id: "m-agent", role: "assistant", model: "claude",
    content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "work", prompt: "work" } }], usage: { input_tokens: 1, output_tokens: 1 } } }))
  await expect(turn).rejects.toThrow("store refused the subagent")
  expect(claude.controls).toContain("close")
  await transport.dispose()
})

test("cancel interrupts the turn and keeps the process and its background task alive", async () => {
  const { transport, session, launches, ...sessions } = await setup()
  const turn = collect(transport.send(session, userTurn("t1", "start the job"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  claude.frames.push(background("job"))
  await until(sessions.rebound)
  const cancelled = transport.cancel(rebound(session), { turnId: "t1", assistantMessageId: "a-t1" }, deadline(5_000))
  await until(() => claude.controls.includes("interrupt"))
  claude.frames.push(frame({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, terminal_reason: "aborted_streaming", errors: [] }))
  expect(await cancelled).toEqual({ execution: "terminal", cleanup: "unknown" })
  await turn
  expect(claude.controls).toEqual(["interrupt"])
  expect(claude.stdinOpen()).toBe(true)
  claude.frames.push(background())
  await claude.stdinClosed
  claude.frames.end()
  await transport.dispose()
})

test("a cancel Claude does not answer by its deadline ends the process and says nothing about the turn", async () => {
  const { transport, session, launches, ...sessions } = await setup()
  const turn = collect(transport.send(session, userTurn("t1", "hello"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.replay(0)
  await until(sessions.rebound)
  expect(await transport.cancel(rebound(session), { turnId: "t1", assistantMessageId: "a-t1" }, deadline(50)))
    .toEqual({ execution: "unknown", cleanup: "unknown" })
  expect(claude.controls).toEqual(["interrupt", "close"])
  await turn
  await transport.dispose()
})
