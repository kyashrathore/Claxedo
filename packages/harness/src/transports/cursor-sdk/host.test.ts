import { expect, test } from "bun:test"
import type { Run, SDKAgent } from "@cursor/sdk"
import type { TurnBroker } from "../../contract"
import { CursorHostRuntime } from "./host"
import type { HostReply, HostSession } from "./protocol"
import { streamCursorRun, type CursorRun } from "./turn"

const session: HostSession = { sessionId: "s1", directory: "/tmp", apiKey: "test", mcpServers: {}, local: {} }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture(stage: "open" | "send") {
  const entered = deferred<void>()
  const resume = deferred<void>()
  const replies: HostReply[] = []
  let sent = 0
  let cancelled = 0
  const run = { id: "run", cancel: async () => { cancelled++ }, stream: async function* () {},
    wait: async () => ({ status: cancelled ? "cancelled" : "finished" }) } as unknown as Run
  const agent = { agentId: "agent", close() {}, send: async () => {
    sent++
    if (stage === "send") { entered.resolve(); await resume.promise }
    return run
  } } as unknown as SDKAgent
  const sdk = async () => ({ Agent: { create: async () => {
    if (stage === "open") { entered.resolve(); await resume.promise }
    return agent
  } } }) as unknown as Promise<Pick<typeof import("@cursor/sdk"), "Agent" | "Cursor">>
  return { runtime: new CursorHostRuntime((reply) => replies.push(reply), sdk), entered, resume, replies,
    sent: () => sent, cancelled: () => cancelled }
}

for (const kind of ["run", "title"] as const) for (const stage of ["open", "send"] as const) test(`${kind} cancellation while ${stage} is pending remains effective`, async () => {
  const f = fixture(stage)
  const running = f.runtime.receive({ id: 1, kind, session, prompt: "work" })
  await f.entered.promise
  const cancelling = f.runtime.receive({ id: 2, kind: "cancel", sessionId: session.sessionId })
  f.resume.resolve()
  await Promise.all([running, cancelling])
  if (stage === "open") expect(f.sent()).toBe(0)
  else expect(f.cancelled()).toBe(1)
  expect(f.replies.find((reply) => reply.id === 1)).not.toMatchObject({ value: { status: "finished" } })
})

test("a pre-aborted turn sends no host command", async () => {
  const commands: unknown[] = []
  const controller = new AbortController()
  controller.abort(new Error("turn cancelled"))
  const input = { session, prompt: "work", broker: { signal: controller.signal } as TurnBroker,
    host: { call: async (command: unknown) => { commands.push(command); return { kind: "result", value: { agentId: "agent", runId: "run", status: "finished" } } } },
  } as unknown as CursorRun
  const consume = async () => { for await (const _event of streamCursorRun(input)) {} }
  await expect(consume()).rejects.toThrow("turn cancelled")
  expect(commands).toEqual([])
})
