/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerError, type Server, type TranscriptPage, type TranscriptPart } from "@/server"
import { createTranscriptContext } from "./context"
import { loadOlder } from "./older"
import { readSnapshot } from "./snapshot"
import { settleEndedTurn, settleTurn } from "./settle"
import { transcriptRef, shell, withShell, latest, firstReadOf, transcriptServer } from "./test-support/transcript-server"

test("settlement: a missed preamble lands before the tool and final answer in the authority's order", async () => {
  const preamble = { ...latest.entries[1].parts[0], id: "preamble", text: "I will check the branch" }
  const final = { ...latest.entries[1].parts[0], text: "dev" }
  const partial = withShell({ ...latest, entries: [latest.entries[0], { ...latest.entries[1], parts: [final] }] }, shell("dev"))
  const canonical = { entries: [latest.entries[0], { ...latest.entries[1], parts: [preamble, shell("", true), final] }] } as TranscriptPage
  const { server: base, deps } = transcriptServer(firstReadOf(partial))
  const server = { ...base, sessions: { ...base.sessions, turn: async () => canonical } } as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await loadOlder(context)
    await settleTurn(context)
    expect(context.data.parts["msg_2_r"]).toEqual([preamble, shell("dev"), final])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.data.partsWithText.preamble).toBe(true)
    dispose()
  })
})

test("settlement: a failed authority read preserves the live transcript", async () => {
  const { server: base, deps } = transcriptServer()
  const server = { ...base, sessions: { ...base.sessions, turn: async () => { throw new ServerError({ class: "network", message: "Unavailable" }) } } } as Server
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    await createRoot(async (dispose) => {
      const context = createTranscriptContext(server, transcriptRef, deps)
      await readSnapshot(context)
      await settleTurn(context)
      expect(context.data.messages.map((message) => message.id)).toEqual(["msg_2", "msg_2_r"])
      expect(context.data.parts["msg_2_r"]).toEqual([...latest.entries[1].parts])
      dispose()
    })
    expect(log).toHaveBeenCalledTimes(1)
  } finally {
    log.mockRestore()
  }
})

test("settlement: a turn the session's status ends, as idle, interrupted or failed, is read again so its open tools stop running", async () => {
  const running = { ...shell(""), state: { status: "running", input: { command: "sleep 120" }, title: "sleep", metadata: {}, time: { start: 1 } } } as TranscriptPart
  const ended = { ...shell(""), state: { status: "error", input: { command: "sleep 120" }, error: "Interrupted: The workspace machine stopped during this turn", metadata: {}, time: { start: 1, end: 3 } } } as TranscriptPart
  const reads: string[] = []
  const { server: base, deps } = transcriptServer(firstReadOf(withShell(latest, running)))
  const server = { ...base, sessions: { ...base.sessions, turn: async (_ref: unknown, turnId: string) => {
    reads.push(turnId)
    return withShell(latest, ended)
  } } } as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await settleEndedTurn(context, { kind: "working" })
    await settleEndedTurn(context, { kind: "retrying", message: "Retrying" })
    expect(reads).toEqual([])
    expect(context.data.parts["msg_2_r"]?.[0]?.type === "tool" && context.data.parts["msg_2_r"][0].state.status).toBe("running")
    await settleEndedTurn(context, { kind: "interrupted", message: "The previous run stopped" })
    expect(context.data.parts["msg_2_r"]?.[0]).toEqual(ended)
    await settleEndedTurn(context, { kind: "idle" })
    await settleEndedTurn(context, { kind: "failed", error: new ServerError({ class: "internal", message: "Failed" }) })
    expect(reads).toEqual(["msg_2", "msg_2", "msg_2"])
    dispose()
  })
})
