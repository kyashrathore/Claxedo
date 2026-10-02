import { expect } from "bun:test"
import type { Query, SDKMessage, SDKUserMessage, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { AsyncPushQueue } from "@claxedo/helpers"
import type { HarnessServices, HarnessSession, ProviderTurnInput, ProviderTurnResult, ProviderTurnSettlement, RoutedEvent, SessionBroker, StartInput, TurnBroker, TurnInput, TurnRef } from "../../../contract"
import { CLAUDE_CODE_RANGE } from "../cli-version"
import { goalSessionStore } from "../goal-state"
import { ClaudeSdkTransport } from "../index"
import type { ClaudeQueryLauncher } from "../query-options"

export const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local",
  owner: { kind: "machine-owner" }, config: { harness: { id: "claude", access: "native" } },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }
export const services = { log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as HarnessServices

export const frame = (value: Record<string, unknown>) => ({ session_id: "up1", uuid: crypto.randomUUID(), ...value }) as unknown as SDKMessage
export const init = (version: string = CLAUDE_CODE_RANGE.max) => frame({ type: "system", subtype: "init", claude_code_version: version })
export const background = (...ids: string[]) => backgroundTasks(...ids.map((id) => ({ id, type: "local_bash" })))
export const backgroundTasks = (...tasks: { id: string; type: string; ambient?: boolean }[]) => frame({ type: "system", subtype: "background_tasks_changed",
  tasks: tasks.map((task) => ({ task_id: task.id, task_type: task.type, description: "work", ...(task.ambient ? { ambient: true } : {}) })) })
export const notification = (id: string) => frame({ type: "system", subtype: "task_notification", task_id: id, status: "completed", output_file: "/tmp/out", summary: "done" })
export const reply = (text: string) => frame({ type: "assistant", parent_tool_use_id: null,
  message: { id: `m-${text}`, role: "assistant", model: "claude", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } })
export const result = () => frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" })

type Claude = { frames: AsyncPushQueue<SDKMessage>; prompts: string[]; users: SDKUserMessage[]; controls: string[]
  stdinClosed: Promise<void>; stdinOpen: () => boolean; replay: (index: number) => void; transcript: (entry: SessionStoreEntry) => Promise<void>
  turn: Parameters<ClaudeQueryLauncher["launch"]>[0]["turn"] }

export function scriptedLaunches(options: { failFirst?: unknown; failModel?: unknown } = {}) {
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
      for await (const message of spec.prompt) {
        const content = message.message.content
        users.push(message)
        prompts.push(typeof content === "string" ? content : content.map((part) => "text" in part ? part.text : "").join(""))
      }
      open = false
    })()
    spec.abort.signal.addEventListener("abort", () => frames.end(), { once: true })
    const replay = (index: number) => frames.push({ ...users[index]!, session_id: "up1", isReplay: true } as unknown as SDKMessage)
    const store = goalSessionStore(spec.broker, spec.abort.signal)
    const transcript = (entry: SessionStoreEntry) => store.append({ projectKey: "work", sessionId: "up1" }, [entry])
    launches.push({ frames, prompts, users, controls, stdinClosed, stdinOpen: () => open, replay, transcript, turn: spec.turn })
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close() { controls.push("close"); frames.end() },
      async interrupt() { controls.push("interrupt") }, async stopTask(task: string) { controls.push(`stop ${task}`) },
      async setModel(model: string) { controls.push(`model ${model}`); if (options.failModel) throw options.failModel },
      async applyFlagSettings(settings: unknown) { controls.push(`settings ${JSON.stringify(settings)}`) },
      async setPermissionMode(mode: string) { controls.push(`mode ${mode}`) } } as unknown as Query
  } } as unknown as ClaudeQueryLauncher
  return { launches, launcher }
}

type Goal = RuntimeGoalSnapshot | null

export function sessionBroker() {
  const own: { input: ProviderTurnInput; events: RoutedEvent[]; done: Promise<void> }[] = []
  const goals: Goal[] = []
  const children: RoutedEvent[] = []
  const published: unknown[] = []
  const publishedTargets: (string | undefined)[] = []
  let busy = false
  let rebinds = 0
  const broker = {
    sessionId: "s1", config: () => input.config, publish: async (event: unknown, target?: string) => { published.push(event); publishedTargets.push(target) }, meter() {},
    observeSubagent: async () => undefined, associateChild() {}, publishChild: async (event: RoutedEvent) => { children.push(event) },
    goal: { read: () => goals.at(-1) ?? null, publish: async (goal: Goal) => { goals.push(goal) } },
    reportFailure: (error: unknown) => { throw error },
    rebind: async (upstreamSessionId: string) => (rebinds += 1, Object.freeze({ sessionId: "s1", workspaceId: "w1", directory: "/work", connectionId: "claude-sdk", upstreamSessionId })),
    admitProviderTurn: async (turnInput: ProviderTurnInput, run: (broker: TurnBroker, turn: TurnRef) => AsyncIterable<RoutedEvent>): Promise<ProviderTurnResult> => {
      if (busy) return { admitted: false, reason: "busy" }
      const turn = { turnId: `own-${own.length + 1}`, assistantMessageId: `own-a${own.length + 1}` }
      const entry = { input: turnInput, events: [] as RoutedEvent[], done: Promise.resolve() }
      const settled = (async (): Promise<ProviderTurnSettlement> => {
        try { for await (const event of run(turnBroker(), turn)) entry.events.push(event) } catch (error) { return { state: "failed", error: String(error) } }
        return { state: "completed" }
      })()
      entry.done = settled.then(() => undefined)
      own.push(entry)
      return { admitted: true, turn, settled }
    },
  } as unknown as SessionBroker
  return { broker, own, goals, children, published, publishedTargets, setBusy: (value: boolean) => { busy = value }, rebound: () => rebinds > 1 }
}

export function turnBroker(): TurnBroker {
  return { signal: new AbortController().signal, origin: { actor: input.owner, via: "loopback", reissued: false },
    observeSubagent: async () => undefined, associateChild() {} } as unknown as TurnBroker
}

export function userTurn(id: string, text: string, modelID = "default"): TurnInput {
  return { turnId: id, userMessageId: `u-${id}`, assistantMessageId: `a-${id}`, todos: [], model: { providerID: "anthropic", modelID },
    origin: { actor: input.owner, via: "loopback", reissued: false }, prompt: { agent: "", assistantMessageId: `a-${id}`, parts: [{ type: "text", text }] } }
}

export function rebound(session: HarnessSession): HarnessSession {
  return { ...session, binding: { ...session.binding, upstreamSessionId: "up1" } }
}

export async function collect(stream: AsyncIterable<RoutedEvent>): Promise<RoutedEvent[]> {
  const events: RoutedEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

export function texts(events: RoutedEvent[]): string[] {
  return events.map(({ event }) => JSON.stringify(event))
}

export async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

export async function setup(options?: Parameters<typeof scriptedLaunches>[0]) {
  const { launches, launcher } = scriptedLaunches(options)
  const sessions = sessionBroker()
  const transport = new ClaudeSdkTransport(services, { executable: "claude", configRoot: "/tmp/claude-test", userConfigRoot: "/tmp/claude-user", env: {} })
  Object.assign(transport, { launcher })
  const session = await transport.start(input, sessions.broker)
  return { transport, session, launches, ...sessions }
}
