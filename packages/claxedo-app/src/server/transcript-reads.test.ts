/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { sessionEndpoint } from "./session-context"
import { readTurnOpened, readPart, readTurnPageBefore } from "./transcript-reads"
import type { TranscriptEntry } from "./types"
import { fakeServer, ref, shape, stored as storedMessages, storedTool } from "./test-session-server"

const stored = storedMessages as unknown as readonly TranscriptEntry[]

const settings = { reasoning: false, shell: true, edit: false }
const machine = { reachable: () => true, machine: true }

test("transcript reads: a machine session reads its older page, an opened turn and a part from its runtime", async () => {
  const server = fakeServer({
    ...machine,
    runtime: (path) => {
      if (path.startsWith(sessionEndpoint(ref, "/page"))) return Response.json({ turns: [{ messages: stored, foldableCount: 2, cursor: "at-msg-1" }] })
      if (path.startsWith(sessionEndpoint(ref, "/turn"))) return Response.json({ messages: stored, cursor: "at-msg-1" })
      if (path.startsWith(sessionEndpoint(ref, "/message/msg_2/part/prt_3"))) return Response.json(storedTool)
      return Response.json({ error: { message: path } }, { status: 500 })
    },
  })

  const page = await readTurnPageBefore(server.context, ref, shape, "at-msg-3")
  expect(page.transcript).toEqual({ entries: stored, olderCursor: "at-msg-1" })
  expect([...page.folded]).toEqual([["msg_1", { foldableCount: 2, openBefore: "at-msg-3" }]])
  expect(await readTurnOpened(server.context, ref, settings, "at-msg-2")).toEqual({ entries: stored, olderCursor: "at-msg-1" })
  expect(await readPart(server.context, ref, "msg_2", "prt_3")).toEqual(storedTool)
  expect(server.runtimeCalls).toEqual([
    `${sessionEndpoint(ref, "/page")}?before=at-msg-3&rows=40&cols=100&reasoning=0&shell=0&edit=0`,
    `${sessionEndpoint(ref, "/turn")}?reasoning=0&shell=1&edit=0&before=at-msg-2`,
    sessionEndpoint(ref, "/message/msg_2/part/prt_3"),
  ])
})

test("transcript reads: a cloud session reads an opened turn and a part from the control plane, or through a signed desktop's account", async () => {
  const server = fakeServer({ reachable: () => false })
  expect(await readTurnOpened(server.context, ref, settings, undefined)).toEqual({ entries: stored, olderCursor: "cursor_older" })
  expect(await readPart(server.context, ref, "msg_2", "prt_3")).toEqual(storedTool)
  expect(server.requests.filter((path) => path.startsWith("/api/control/sessions/ses_1"))).toEqual([
    "/api/control/sessions/ses_1/turn?workspaceId=ws_cloud&reasoning=0&shell=1&edit=0",
    "/api/control/sessions/ses_1/part?workspaceId=ws_cloud&messageId=msg_2&partId=prt_3",
  ])

  const calls: { operation: string; input?: Readonly<Record<string, unknown>> }[] = []
  const account = {
    run: async (operation: string, input?: Readonly<Record<string, unknown>>) => {
      calls.push({ operation, ...(input ? { input } : {}) })
      return operation === "session.part" ? { part: storedTool } : { messages: stored }
    },
  } as HostedAccount
  const signed = { ...server.context, account }
  await readTurnOpened(signed, ref, settings, "at-msg-2")
  await readPart(signed, ref, "msg_2", "prt_3")
  expect(calls).toEqual([
    { operation: "session.openTurn", input: { sessionId: "ses_1", workspaceId: "ws_cloud", reasoning: "0", shell: "1", edit: "0", before: "at-msg-2" } },
    { operation: "session.part", input: { sessionId: "ses_1", workspaceId: "ws_cloud", messageId: "msg_2", partId: "prt_3" } },
  ])
})

test("transcript reads: an offline machine's session pages nothing and refuses a part rather than reading the machine", async () => {
  const server = fakeServer({ reachable: () => false, machine: true })
  expect((await readTurnPageBefore(server.context, ref, shape, "cursor_older")).transcript.entries).toEqual([])
  await expect(readPart(server.context, ref, "msg_2", "prt_3")).rejects.toMatchObject({ class: "network" })
  expect(server.runtimeCalls).toEqual([])
})
