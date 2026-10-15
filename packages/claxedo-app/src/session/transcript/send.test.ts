/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerError, type PromptInput, type Server, type ServerEvent } from "@/server"
import type { TranscriptDeps } from "./context"
import { createTranscriptContext, type TranscriptContext } from "./context"
import { applyServerEvent } from "./events"
import { sendPrompt } from "./send"
import { readSnapshot } from "./snapshot"
import { transcriptRef, transcriptServer } from "./test-support/transcript-server"

const PROMPT: PromptInput = { clientRequestId: "req_1", text: "reply with exactly ACK-86", attachments: [], messageId: "msg_3" }

const runtimeUser = { id: "msg_3", role: "user", sessionID: "ses_1", time: { created: 3 } }
const runtimeReply = { id: "msg_3_r", role: "assistant", sessionID: "ses_1", parentID: "msg_3", time: { created: 4 } }

const upserted = (message: object): ServerEvent => ({ type: "messageUpserted", ref: transcriptRef, message }) as unknown as ServerEvent

async function sendingTab(prompt: (context: TranscriptContext) => Promise<void>) {
  const failed: string[] = []
  const { server: base, deps: baseDeps } = transcriptServer()
  let context: TranscriptContext | undefined
  const server = { ...base, sessions: { ...base.sessions, queue: async () => [], prompt: () => prompt(context!) } } as unknown as Server
  const deps = { ...baseDeps, list: { ...baseDeps.list, sendStarted: () => undefined, sendFailed: (_session: string, request: string) => failed.push(request) } } as unknown as TranscriptDeps
  return createRoot(async () => {
    context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    return { context, failed }
  })
}

const messageIds = (context: TranscriptContext) => context.data.messages.map((message) => message.id)

test("a send whose answer is lost after the runtime showed its message keeps that message and the turn it runs, and counts as accepted", async () => {
  const { context, failed } = await sendingTab(async (tab) => {
    applyServerEvent(tab, upserted(runtimeUser))
    throw new ServerError({ class: "network", message: "Failed to fetch" })
  })
  await sendPrompt(context, PROMPT)
  applyServerEvent(context, upserted(runtimeReply))
  expect(messageIds(context)).toEqual(["msg_2", "msg_2_r", "msg_3", "msg_3_r"])
  expect(failed).toEqual([])
})

test("a send that fails before the runtime showed its message takes its own message back, and the runtime's later message still shows", async () => {
  const { context, failed } = await sendingTab(async () => {
    throw new ServerError({ class: "network", message: "Failed to fetch" })
  })
  await expect(sendPrompt(context, PROMPT)).rejects.toMatchObject({ class: "network" })
  expect(messageIds(context)).toEqual(["msg_2", "msg_2_r"])
  expect(failed).toEqual(["req_1"])
  applyServerEvent(context, upserted(runtimeUser))
  applyServerEvent(context, upserted(runtimeReply))
  expect(messageIds(context)).toEqual(["msg_2", "msg_2_r", "msg_3", "msg_3_r"])
})
