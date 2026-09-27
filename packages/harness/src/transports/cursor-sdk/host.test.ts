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
function fixture(stage: "open" | "send", cancel?: () => Promise<void>, terminal?: Promise<void>) {
  const entered = deferred<void>()
  const resume = deferred<void>()
  const streaming = deferred<void>()
  const replies: HostReply[] = []
  let sent = 0
  let cancelled = 0
  const run = { id: "run", cancel: async () => { cancelled++; await cancel?.() }, stream: async function* () { streaming.resolve(); await terminal },
    wait: async () => ({ status: cancelled ? "cancelled" : "finished" }) } as unknown as Run
  let closed = 0
  const agent = { agentId: "agent", close() { closed++ }, send: async () => {
    sent++
    if (stage === "send") { entered.resolve(); await resume.promise }
    return run
  } } as unknown as SDKAgent
  const sdk = async () => ({ Agent: { create: async () => {
    if (stage === "open") { entered.resolve(); await resume.promise }
    return agent
  } } }) as unknown as Promise<Pick<typeof import("@cursor/sdk"), "Agent" | "Cursor">>
  return { runtime: new CursorHostRuntime((reply) => replies.push(reply), sdk), entered, resume, streaming, replies,
    sent: () => sent, cancelled: () => cancelled, closed: () => closed }
}

for (const kind of ["run", "title"] as const) test(`${kind} stream failure releases the session for the next run`, async () => {
  let breakStream!: (error: Error) => void
  const f = fixture("send", undefined, new Promise<void>((_resolve, reject) => { breakStream = reject }))
  f.resume.resolve()
  const running = f.runtime.receive({ id: 1, kind, session, prompt: "work" })
  await f.streaming.promise
  breakStream(new Error("stream broke"))
  await running
  await f.runtime.receive({ id: 2, kind, session, prompt: "next" })
  expect(f.replies).toEqual([{ id: 1, kind: "error", message: "stream broke" }, { id: 2, kind: "error", message: "stream broke" }])
  if (kind === "title") expect(f.closed()).toBe(2)
})

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

for (const kind of ["run", "title"] as const) test(`${kind} cancellation failure during send reaches the caller and preserves the live run`, async () => {
  const terminal = deferred<void>()
  let attempts = 0
  const f = fixture("send", async () => {
    if (++attempts === 1) throw new Error("cancel failed")
    terminal.resolve()
  }, terminal.promise)
  const running = f.runtime.receive({ id: 1, kind, session, prompt: "work" })
  await f.entered.promise
  const cancelling = f.runtime.receive({ id: 2, kind: "cancel", sessionId: session.sessionId })
  f.resume.resolve()
  await cancelling
  try {
    expect(f.replies.find((reply) => reply.id === 2)).toEqual({ id: 2, kind: "error", message: "cancel failed" })
    expect(f.replies.find((reply) => reply.id === 1)).toBeUndefined()
    await f.runtime.receive({ id: 4, kind, session, prompt: "overlapping" })
    expect(f.replies.find((reply) => reply.id === 4)).toEqual({ id: 4, kind: "error", message: "Cursor run already active" })
    await f.runtime.receive({ id: 3, kind: "cancel", sessionId: session.sessionId })
    expect(f.cancelled()).toBe(2)
    expect(f.replies.find((reply) => reply.id === 3)).toEqual({ id: 3, kind: "result" })
  } finally { terminal.resolve(); await running }
  await f.runtime.receive({ id: 5, kind, session, prompt: "next" })
  expect(f.replies.find((reply) => reply.id === 5)).toMatchObject({ id: 5, kind: "result" })
})

for (const kind of ["run", "title"] as const) for (const fails of [false, true]) test(`${kind} concurrent cancellations share ${fails ? "failure" : "success"}`, async () => {
  const cancelEntered = deferred<void>()
  const finishCancel = deferred<void>()
  const terminal = deferred<void>()
  const f = fixture("send", async () => {
    cancelEntered.resolve()
    await finishCancel.promise
    if (fails) throw new Error("cancel failed")
  }, terminal.promise)
  const running = f.runtime.receive({ id: 1, kind, session, prompt: "work" })
  await f.entered.promise
  f.resume.resolve()
  await f.streaming.promise
  const first = f.runtime.receive({ id: 2, kind: "cancel", sessionId: session.sessionId })
  await cancelEntered.promise
  const second = f.runtime.receive({ id: 3, kind: "cancel", sessionId: session.sessionId })
  await Promise.resolve()
  const earlyReplies = f.replies.filter((reply) => reply.id === 2 || reply.id === 3)
  finishCancel.resolve()
  await Promise.all([first, second])
  terminal.resolve()
  await running
  expect(earlyReplies).toEqual([])
  expect(f.cancelled()).toBe(1)
  for (const id of [2, 3]) expect(f.replies.find((reply) => reply.id === id)).toEqual(fails
    ? { id, kind: "error", message: "cancel failed" } : { id, kind: "result" })
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

test("terminal observation retains an outstanding cancellation result for concurrent callers", async () => {
  const cancelEntered = deferred<void>()
  const finishCancel = deferred<void>()
  const terminal = deferred<void>()
  const f = fixture("send", async () => {
    cancelEntered.resolve()
    await finishCancel.promise
    throw new Error("cancel failed")
  }, terminal.promise)
  const running = f.runtime.receive({ id: 1, kind: "run", session, prompt: "work" })
  await f.entered.promise
  f.resume.resolve()
  await f.streaming.promise
  const first = f.runtime.receive({ id: 2, kind: "cancel", sessionId: session.sessionId })
  await cancelEntered.promise
  terminal.resolve()
  await running
  const second = f.runtime.receive({ id: 3, kind: "cancel", sessionId: session.sessionId })
  finishCancel.resolve()
  await Promise.all([first, second])
  expect(f.cancelled()).toBe(1)
  for (const id of [2, 3]) expect(f.replies.find((reply) => reply.id === id)).toEqual({ id, kind: "error", message: "cancel failed" })
})
