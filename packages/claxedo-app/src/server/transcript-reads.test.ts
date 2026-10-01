/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HostedAccount } from "./account"
import { sessionEndpoint } from "./session-context"
import { readPart, readTurnPageBefore } from "./transcript-reads"
import type { TranscriptEntry } from "./types"
import { fakeServer, ref, shape, stored as storedMessages, storedTool } from "./test-session-server"

const stored = storedMessages as unknown as readonly TranscriptEntry[]

const machine = { reachable: () => true, machine: true }

test("transcript reads: a machine session reads its older page and a part from its runtime", async () => {
  const server = fakeServer({
    ...machine,
    runtime: (path) => {
      if (path.startsWith(sessionEndpoint(ref, "/page"))) return Response.json({ turns: [{ messages: stored, cursor: "at-msg-1" }] })
      if (path.startsWith(sessionEndpoint(ref, "/message/msg_2/part/prt_3"))) return Response.json(storedTool)
      return Response.json({ error: { message: path } }, { status: 500 })
    },
  })

  expect(await readTurnPageBefore(server.context, ref, shape, "at-msg-3")).toEqual({ entries: stored, olderCursor: "at-msg-1" })
  expect(await readPart(server.context, ref, "msg_2", "prt_3")).toEqual(storedTool)
  expect(server.runtimeCalls).toEqual([
    `${sessionEndpoint(ref, "/page")}?before=at-msg-3&rows=40&cols=100&reasoning=0&shell=0&edit=0`,
    sessionEndpoint(ref, "/message/msg_2/part/prt_3"),
  ])
})

test("transcript reads: a cloud session reads a part from the control plane, or through a signed desktop's account", async () => {
  const server = fakeServer({ reachable: () => false })
  expect(await readPart(server.context, ref, "msg_2", "prt_3")).toEqual(storedTool)
  expect(server.requests.filter((path) => path.startsWith("/api/control/sessions/ses_1"))).toEqual([
    "/api/control/sessions/ses_1/part?workspaceId=ws_cloud&messageId=msg_2&partId=prt_3",
  ])

  const calls: { operation: string; input?: Readonly<Record<string, unknown>> }[] = []
  const account = {
    channel: "port",
    run: async (operation: string, input?: Readonly<Record<string, unknown>>) => {
      calls.push({ operation, ...(input ? { input } : {}) })
      return { part: storedTool }
    },
  } as HostedAccount
  const signed = { ...server.context, account }
  await readPart(signed, ref, "msg_2", "prt_3")
  expect(calls).toEqual([
    { operation: "session.part", input: { sessionId: "ses_1", workspaceId: "ws_cloud", messageId: "msg_2", partId: "prt_3" } },
  ])
})

test("transcript reads: an offline machine's session refuses an older page and a part rather than reading the machine", async () => {
  const server = fakeServer({ reachable: () => false, machine: true })
  await expect(readTurnPageBefore(server.context, ref, shape, "cursor_older")).rejects.toMatchObject({ class: "network" })
  await expect(readPart(server.context, ref, "msg_2", "prt_3")).rejects.toMatchObject({ class: "network" })
  expect(server.runtimeCalls).toEqual([])
})
