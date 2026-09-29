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

type Claude = { frames: AsyncPushQueue<SDKMessage>; prompts: string[]; stdinClosed: Promise<void>; stdinOpen: () => boolean }

function scriptedLaunches() {
  const launches: Claude[] = []
  const launcher = { launch: async (spec: Parameters<ClaudeQueryLauncher["launch"]>[0]) => {
    const frames = new AsyncPushQueue<SDKMessage>()
    let open = true
    const prompts: string[] = []
    const stdinClosed = (async () => {
      for await (const message of spec.prompt as AsyncIterable<SDKUserMessage>) {
        const content = message.message.content
        prompts.push(typeof content === "string" ? content : content.map((part) => "text" in part ? part.text : "").join(""))
      }
      open = false
    })()
    spec.abort.signal.addEventListener("abort", () => frames.end(), { once: true })
    launches.push({ frames, prompts, stdinClosed, stdinOpen: () => open })
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close() { frames.end() } } as unknown as Query
  } } as unknown as ClaudeQueryLauncher
  return { launches, launcher }
}

function sessionBroker() {
  const own: { input: ProviderTurnInput; events: RoutedEvent[]; done: Promise<void> }[] = []
  let busy = false
  const broker = {
    sessionId: "s1", config: () => input.config, goal: { read: () => null, publish: async () => {} }, publish: async () => {}, meter() {},
    reportFailure: (error: unknown) => { throw error },
    rebind: async (upstreamSessionId: string) => Object.freeze({ sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "claude-sdk", upstreamSessionId }),
    admitProviderTurn: async (turnInput: ProviderTurnInput, run: (broker: TurnBroker, turn: TurnRef) => AsyncIterable<RoutedEvent>): Promise<ProviderTurnResult> => {
      if (busy) return { admitted: false, reason: "busy" }
      const turn = { turnId: `own-${own.length + 1}`, assistantMessageId: `own-a${own.length + 1}` }
      const entry = { input: turnInput, events: [] as RoutedEvent[], done: Promise.resolve() }
      entry.done = (async () => { for await (const event of run(turnBroker(), turn)) entry.events.push(event) })()
      own.push(entry)
      return { admitted: true, turn, settled: entry.done.then(() => ({ state: "completed" as const })) }
    },
  } as unknown as SessionBroker
  return { broker, own, setBusy: (value: boolean) => { busy = value } }
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

test("a turn with no background task closes Claude's stdin at its result, as before", async () => {
  const { transport, session, launches } = await setup()
  const turn = collect(transport.send(session, userTurn("t1", "hello"), turnBroker()))
  await until(() => launches.length === 1 && launches[0]!.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.frames.push(reply("hi"))
  claude.frames.push(result())
  await claude.stdinClosed
  claude.frames.end()
  await turn
  await transport.dispose()
})

test("a turn that leaves a background task running ends at its result with stdin open, and Claude's own turn after the task arrives as a provider turn", async () => {
  const { transport, session, launches, own } = await setup()
  const turn = collect(transport.send(session, userTurn("t1", "start the job"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
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
  claude.frames.push(background("job"))
  claude.frames.push(result())
  await first

  const second = collect(transport.send(rebound(session), userTurn("t2", "and another thing"), turnBroker()))
  await until(() => claude.prompts.length === 2)
  expect(claude.prompts).toEqual(["start the job", "and another thing"])
  claude.frames.push(init())
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

test("a message whose launch differs from the lingering process closes that process and starts a new one", async () => {
  const { transport, session, launches } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start the job"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
  claude.frames.push(background("job"))
  claude.frames.push(result())
  await first

  const second = collect(transport.send(rebound(session), userTurn("t2", "switch models", "sonnet"), turnBroker()))
  await claude.stdinClosed
  claude.frames.end()
  await until(() => launches.length === 2 && launches[1]!.prompts.length === 1)
  expect(launches[1]!.prompts).toEqual(["switch models"])
  launches[1]!.frames.push(init())
  launches[1]!.frames.push(result())
  await launches[1]!.stdinClosed
  launches[1]!.frames.end()
  await second
  await transport.dispose()
})

test("bookkeeping frames between turns wait for Claude's own turn instead of opening one", async () => {
  const { transport, session, launches, own } = await setup()
  const first = collect(transport.send(session, userTurn("t1", "start two jobs"), turnBroker()))
  await until(() => launches[0]?.prompts.length === 1)
  const claude = launches[0]!
  claude.frames.push(init())
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
