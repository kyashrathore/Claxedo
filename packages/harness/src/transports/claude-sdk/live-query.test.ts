import { expect, test } from "bun:test"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { AsyncPushQueue } from "@claxedo/helpers"
import type { HarnessServices, HarnessSession, ProviderTurnInput, ProviderTurnResult, RoutedEvent, SessionBroker, StartInput, TurnBroker, TurnInput, TurnRef } from "../../contract"
import { ClaudeSdkTransport } from "./index"
import type { ClaudeQueryLauncher } from "./query-options"

const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local",
  owner: { kind: "machine-owner" }, config: { harness: { id: "claude", access: "native" } },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }
const services = { log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as HarnessServices

const frame = (value: Record<string, unknown>) => ({ session_id: "up1", uuid: crypto.randomUUID(), ...value }) as unknown as SDKMessage
const init = () => frame({ type: "system", subtype: "init" })
const background = (...ids: string[]) => frame({ type: "system", subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: "local_bash", description: "sleep" })) })
const notification = (id: string) => frame({ type: "system", subtype: "task_notification", task_id: id, status: "completed", output_file: "/tmp/out", summary: "done" })
const reply = (text: string) => frame({ type: "assistant", parent_tool_use_id: null,
  message: { id: `m-${text}`, role: "assistant", model: "claude", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } })
const result = () => frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" })

type Claude = { frames: AsyncPushQueue<SDKMessage>; prompts: string[]; users: SDKUserMessage[]; controls: string[]
  stdinClosed: Promise<void>; stdinOpen: () => boolean; replay: (index: number) => void }

function scriptedLaunches(options: { failFirst?: unknown } = {}) {
  const launches: Claude[] = []
  let attempts = 0
  const launcher = { launch: async (spec: Parameters<ClaudeQueryLauncher["launch"]>[0]) => {
    if (attempts++ === 0 && options.failFirst) throw options.failFirst
    const frames = new AsyncPushQueue<SDKMessage>()
    let open = true
    const prompts: string[] = []
    const users: SDKUserMessage[] = []
    const controls: string[] = []
    const stdinClosed = (async () => {
      for await (const message of spec.prompt as AsyncIterable<SDKUserMessage>) {
        const content = message.message.content
        users.push(message)
        prompts.push(typeof content === "string" ? content : content.map((part) => "text" in part ? part.text : "").join(""))
      }
      open = false
    })()
    spec.abort.signal.addEventListener("abort", () => frames.end(), { once: true })
    const replay = (index: number) => frames.push({ ...users[index]!, session_id: "up1", isReplay: true } as unknown as SDKMessage)
    launches.push({ frames, prompts, users, controls, stdinClosed, stdinOpen: () => open, replay })
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close() { controls.push("close"); frames.end() },
      async interrupt() { controls.push("interrupt") }, async stopTask(task: string) { controls.push(`stop ${task}`) } } as unknown as Query
  } } as unknown as ClaudeQueryLauncher
  return { launches, launcher }
}

function sessionBroker() {
  const own: { input: ProviderTurnInput; events: RoutedEvent[]; done: Promise<void> }[] = []
  let busy = false
  let rebinds = 0
  const broker = {
    sessionId: "s1", config: () => input.config, goal: { read: () => null, publish: async () => {} }, publish: async () => {}, meter() {},
    reportFailure: (error: unknown) => { throw error },
    rebind: async (upstreamSessionId: string) => (rebinds += 1, Object.freeze({ sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "claude-sdk", upstreamSessionId })),
    admitProviderTurn: async (turnInput: ProviderTurnInput, run: (broker: TurnBroker, turn: TurnRef) => AsyncIterable<RoutedEvent>): Promise<ProviderTurnResult> => {
      if (busy) return { admitted: false, reason: "busy" }
      const turn = { turnId: `own-${own.length + 1}`, assistantMessageId: `own-a${own.length + 1}` }
      const entry = { input: turnInput, events: [] as RoutedEvent[], done: Promise.resolve() }
      entry.done = (async () => { for await (const event of run(turnBroker(), turn)) entry.events.push(event) })()
      own.push(entry)
      return { admitted: true, turn, settled: entry.done.then(() => ({ state: "completed" as const })) }
    },
  } as unknown as SessionBroker
  return { broker, own, setBusy: (value: boolean) => { busy = value }, rebound: () => rebinds > 1 }
}

function turnBroker(): TurnBroker {
  return { signal: new AbortController().signal, observeSubagent: async () => undefined, associateChild() {} } as unknown as TurnBroker
}

function userTurn(id: string, text: string, modelID = "default"): TurnInput {
  return { turnId: id, userMessageId: `u-${id}`, assistantMessageId: `a-${id}`, todos: [], model: { providerID: "anthropic", modelID },
    origin: { actor: input.owner, via: "loopback", reissued: false }, prompt: { agent: "", assistantMessageId: `a-${id}`, parts: [{ type: "text", text }] } }
}

function rebound(session: HarnessSession): HarnessSession {
  return { ...session, binding: { ...session.binding, upstreamSessionId: "up1" } }
}

async function collect(stream: AsyncIterable<RoutedEvent>): Promise<RoutedEvent[]> {
  const events: RoutedEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function texts(events: RoutedEvent[]): string[] {
  return events.map(({ event }) => JSON.stringify(event))
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

async function setup() {
  const { launches, launcher } = scriptedLaunches()
  const sessions = sessionBroker()
  const transport = new ClaudeSdkTransport(services, { executable: "claude", configRoot: "/tmp/claude-test", userConfigRoot: "/tmp/claude-user", env: {} })
  Object.assign(transport, { launcher })
  const session = await transport.start(input, sessions.broker)
  return { transport, session, launches, ...sessions }
}

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
