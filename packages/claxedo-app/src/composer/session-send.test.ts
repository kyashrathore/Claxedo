/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { promptText } from "./model"
import { createComposerPersistence } from "./persistence"
import { createComposerSend } from "./send"
import { createComposerStore, type ComposerStore } from "./store"
import { ServerError, type QueuedPrompt, type TranscriptMessage } from "@/server"
import type { SessionView } from "@/session"

const KEY = "session:goal"
let messageIds = 0
const newMessageId = () => `msg_test_${++messageIds}`

type DeliveredPrompt = { text: string; delivery?: unknown; messageId?: string }

function sessionComposer(deliver: (prompt: DeliveredPrompt) => Promise<void>, session: { store?: ComposerStore; joinsQueue?: boolean; messages?: () => TranscriptMessage[]; queued?: () => QueuedPrompt[] } = {}) {
  const store = session.store ?? createComposerStore()
  store.setPrompt(KEY, [{ type: "text", content: "Reply only DONE-A.", start: 0, end: 18 }], 18)
  const view = { send: deliver, messages: session.messages ?? (() => []), queue: { items: session.queued ?? (() => []) } } as unknown as SessionView
  const send = createRoot(() => createComposerSend({
    key: () => KEY, store, mode: () => "normal", normalMode: () => undefined,
    submission: async () => ({}), joinsQueue: () => session.joinsQueue ?? true, goalCapable: () => false,
    view: () => view, queuedReplace: () => undefined,
    focusEditor: () => undefined, goalStopFailed: () => undefined, newMessageId,
  }))
  return { store, send }
}

function lostAnswer(sent: string[]) {
  return async (prompt: DeliveredPrompt) => {
    sent.push(prompt.messageId ?? "")
    throw new ServerError({ class: "network", message: "Failed to fetch" })
  }
}

test("a send to an open session goes out under the message id the composer gave it", async () => {
  const sent: DeliveredPrompt[] = []
  const { send } = sessionComposer(async (prompt) => { sent.push(prompt) }, { joinsQueue: false })
  await send.send()
  expect(sent.map((prompt) => [prompt.text, prompt.delivery, prompt.messageId?.startsWith("msg_")])).toEqual([["Reply only DONE-A.", undefined, true]])
})

test("a send whose answer was lost comes back as a draft that the transcript, once it shows the message arrived, spends instead of leaving it to be sent twice", async () => {
  const sent: string[] = []
  const [messages, setMessages] = createSignal<TranscriptMessage[]>([])
  const { store, send } = sessionComposer(lostAnswer(sent), { messages })
  await send.send()
  expect(promptText(store.draft(KEY).prompt)).toBe("Reply only DONE-A.")
  setMessages([{ id: sent[0], role: "user", sessionID: "goal" }])
  expect(promptText(store.draft(KEY).prompt)).toBe("")
})

test("a lost send that the runtime queued is spent once the queue holds it", async () => {
  const sent: string[] = []
  const [queued, setQueued] = createSignal<QueuedPrompt[]>([])
  const { store, send } = sessionComposer(lostAnswer(sent), { queued })
  await send.send()
  setQueued([{ seq: 1, messageId: sent[0], queuedAt: 1, held: false, parts: [{ type: "text", text: "Reply only DONE-A." }] }])
  expect(promptText(store.draft(KEY).prompt)).toBe("")
})

test("a returned draft the person edits is a new message, which the earlier send arriving does not take away", async () => {
  const sent: string[] = []
  const [messages, setMessages] = createSignal<TranscriptMessage[]>([])
  const { store, send } = sessionComposer(lostAnswer(sent), { messages })
  await send.send()
  store.setCursor(KEY, 4)
  store.setPrompt(KEY, [{ type: "text", content: "Reply only DONE-B.", start: 0, end: 18 }], 18)
  setMessages([{ id: sent[0], role: "user", sessionID: "goal" }])
  expect(promptText(store.draft(KEY).prompt)).toBe("Reply only DONE-B.")
})

test("a lost send's draft that a reload brings back is spent by the reloaded transcript that shows it arrived", async () => {
  const saved = new Map<string, string>()
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key) } as unknown as Storage
  const sent: string[] = []
  await sessionComposer(lostAnswer(sent), { store: createComposerStore(createComposerPersistence(storage, "server")) }).send.send()
  const reloaded = createComposerStore(createComposerPersistence(storage, "server"))
  reloaded.retain(KEY)
  expect(promptText(reloaded.draft(KEY).prompt)).toBe("Reply only DONE-A.")
  createRoot(() => createComposerSend({
    key: () => KEY, store: reloaded, mode: () => "normal", normalMode: () => undefined,
    submission: async () => ({}), joinsQueue: () => false, goalCapable: () => false,
    view: () => ({ messages: () => [{ id: sent[0], role: "user", sessionID: "goal" }], queue: { items: () => [] } }) as unknown as SessionView,
    queuedReplace: () => undefined, focusEditor: () => undefined, goalStopFailed: () => undefined, newMessageId,
  }))
  expect(promptText(reloaded.draft(KEY).prompt)).toBe("")
})

test("a send to an open session empties the composer at once, so a follow-up typed while it is delivered is a message of its own", async () => {
  let deliver = () => {}
  const delivered = new Promise<void>((resolve) => { deliver = resolve })
  const { store, send } = sessionComposer(() => delivered)
  const sent = send.send()
  expect(promptText(store.draft(KEY).prompt)).toBe("")
  store.setPrompt(KEY, [{ type: "text", content: "Reply only PONG-52.", start: 0, end: 19 }], 19)
  deliver()
  await sent
  expect(send.state().kind).toBe("accepted")
  expect(promptText(store.draft(KEY).prompt)).toBe("Reply only PONG-52.")
  expect(store.history(KEY, "normal").map((entry) => promptText(entry.prompt))).toEqual(["Reply only DONE-A."])
})

test("a send to an open session that fails puts its text back ahead of anything typed since", async () => {
  let refuse = (_error: Error) => {}
  const refused = new Promise<void>((_resolve, reject) => { refuse = reject })
  const { store, send } = sessionComposer(() => refused)
  const sent = send.send()
  store.setPrompt(KEY, [{ type: "text", content: "and then this", start: 0, end: 13 }], 13)
  refuse(new ServerError({ class: "network", code: "runtime_unavailable", message: "The workspace is not running" }))
  await sent
  expect(send.state().kind).toBe("rejected")
  expect(promptText(store.draft(KEY).prompt)).toBe("Reply only DONE-A.\n\nand then this")
  expect(store.history(KEY, "normal")).toEqual([])
})

test("a send to an open session that fails with nothing typed since restores exactly what was sent", async () => {
  const { store, send } = sessionComposer(async () => { throw new ServerError({ class: "network", code: "runtime_unavailable", message: "down" }) })
  await send.send()
  expect(send.state().kind).toBe("rejected")
  expect(promptText(store.draft(KEY).prompt)).toBe("Reply only DONE-A.")
})

test("Enter on a follow-up while the previous send is still being delivered sends it, queued, once that send lands", async () => {
  const prompts: { text: string; delivery: unknown }[] = []
  let deliver = () => {}
  const first = new Promise<void>((resolve) => { deliver = resolve })
  const { store, send } = sessionComposer(async (prompt) => {
    prompts.push({ text: prompt?.text ?? "", delivery: prompt?.delivery })
    if (prompts.length === 1) await first
  })
  const sent = send.send()
  store.setPrompt(KEY, [{ type: "text", content: "Reply only FOLLOW-2.", start: 0, end: 20 }], 20)
  await send.send()
  expect(promptText(store.draft(KEY).prompt)).toBe("Reply only FOLLOW-2.")
  deliver()
  await sent
  expect(prompts).toEqual([{ text: "Reply only DONE-A.", delivery: "queue" }, { text: "Reply only FOLLOW-2.", delivery: "queue" }])
  expect(promptText(store.draft(KEY).prompt)).toBe("")
  expect(send.state().kind).toBe("accepted")
})

test("Enter on a follow-up while a send that then fails is delivered sends nothing more, and the composer holds both texts", async () => {
  let sends = 0
  let refuse = (_error: Error) => {}
  const refused = new Promise<void>((_resolve, reject) => { refuse = reject })
  const { store, send } = sessionComposer(() => { sends++; return refused })
  const sent = send.send()
  store.setPrompt(KEY, [{ type: "text", content: "and then this", start: 0, end: 13 }], 13)
  await send.send()
  refuse(new ServerError({ class: "network", code: "runtime_unavailable", message: "The workspace is not running" }))
  await sent
  expect(sends).toBe(1)
  expect(send.state().kind).toBe("rejected")
  expect(promptText(store.draft(KEY).prompt)).toBe("Reply only DONE-A.\n\nand then this")
})
