/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { placementId, projectId, sessionId, type SessionReader } from "@/server"
import type { SessionView } from "@/session"
import { markSeenWhileShown } from "./seen-while-shown"

const ref = { projectId: projectId("p1"), placementId: placementId("w1"), sessionId: sessionId("s1") }

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function shownSession() {
  const [completedAt, setCompletedAt] = createSignal(10)
  const [shown, setShown] = createSignal(false)
  const [reader, setReader] = createSignal<SessionReader>({})
  const writes: number[] = []
  const state = { refuse: false }
  const list = {
    readerOf: () => reader(),
    markSeen: async (_ref: unknown, at: number) => {
      writes.push(at)
      if (state.refuse) throw new Error("offline")
      setReader({ seenAt: at })
    },
  }
  const view = () => ({ ref, row: () => ({ lastTurn: { status: "completed", completedAt: completedAt() } }) }) as unknown as SessionView
  const dispose = createRoot((dispose) => {
    markSeenWhileShown(view, shown, list)
    return dispose
  })
  return { setCompletedAt, setShown, setReader, writes, state, dispose }
}

test("seen while shown: one write per turn end while the session is shown, none while it is hidden", async () => {
  const session = shownSession()
  await settle()
  expect(session.writes).toEqual([])
  session.setShown(true)
  await settle()
  expect(session.writes).toEqual([10])
  session.setCompletedAt(20)
  await settle()
  expect(session.writes).toEqual([10, 20])
  session.dispose()
})

test("seen while shown: a refused write is tried once more when the session is shown again, never in a loop", async () => {
  const session = shownSession()
  session.state.refuse = true
  session.setShown(true)
  await settle()
  session.setReader({})
  await settle()
  expect(session.writes).toEqual([10])
  session.setShown(false)
  session.setShown(true)
  await settle()
  session.setReader({})
  await settle()
  expect(session.writes).toEqual([10, 10])
  session.dispose()
})
