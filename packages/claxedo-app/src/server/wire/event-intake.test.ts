/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createEventIntake } from "../event-intake"
import type { ServerEvent } from "../events"
import { placementId, projectId, sessionId } from "../ids"
import { createStatusOwner } from "../status"
import type { Transport } from "../transport"
import type { SessionLocation } from "../types"
import type { Workspaces } from "../workspaces"

const workspaces = {
  address: { placementFor: (_directory: string, workspaceId?: string) => ({ placementId: placementId(workspaceId ?? "local"), projectId: projectId("j1") }) },
  learn: async () => undefined,
} as unknown as Workspaces

const notice = (sessionId: string) => ({
  type: "session.status.changed",
  ownerUserId: "user_reader",
  orgId: "org_1",
  sessionId,
  workspaceId: "ws_1",
  status: "busy",
  awaitingInput: false,
  ts: 1,
})

test("event intake: a status notice for a session whose own stream is open is dropped, any other one lands", () => {
  const streamed = (ref: SessionLocation) => ref.sessionId === "ses_open"
  const intake = createEventIntake({ serverUrl: "http://server.test", queryClient: new QueryClient(), workspaces, status: createStatusOwner({} as Transport), streamed })
  const events: ServerEvent[] = []
  intake.subscribe((event) => events.push(event))

  intake.frame(notice("ses_open"))
  intake.frame(notice("ses_closed"))
  intake.frame({ directory: "/work", payload: { type: "session.status", properties: { sessionID: "ses_open", status: { type: "busy" } } } })

  expect(events.map((event) => (event.type === "statusChanged" ? [String(event.ref.sessionId), event.waitingOnUser] : undefined))).toEqual([
    ["ses_closed", false],
    ["ses_open", undefined],
  ])
})

test("event intake: an account's reader notice lands as readerChanged, open stream or not", () => {
  const intake = createEventIntake({ serverUrl: "http://server.test", queryClient: new QueryClient(), workspaces, status: createStatusOwner({} as Transport), streamed: () => true })
  const events: ServerEvent[] = []
  intake.subscribe((event) => events.push(event))

  intake.frame({ type: "session.reader.changed", ownerUserId: "user_reader", sessionId: "ses_open", workspaceId: "ws_1", seenAt: 30, settledAt: 30, ts: 1 })

  expect(events).toEqual([{ type: "readerChanged", ref: { placementId: placementId("ws_1"), projectId: projectId("j1"), sessionId: sessionId("ses_open") }, reader: { seenAt: 30, settledAt: 30 } }])
})
