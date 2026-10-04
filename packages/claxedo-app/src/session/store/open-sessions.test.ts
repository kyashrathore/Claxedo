/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type SessionOutline, type SessionLocation, type TranscriptPage } from "@/server"
import type { RetainedSession, SessionTranscript, TranscriptSeed } from "../transcript"
import { createOpenSessions } from "./open-sessions"

const ref = (id: string): SessionLocation => ({ projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId(id) })
const page = (id: string): TranscriptPage => ({ entries: [{ info: { id: `${id}-user`, role: "user", sessionID: id }, parts: [] }] })
const outline = (id: string): SessionOutline => ({ turns: [{ id: `${id}-user`, createdAt: 1, preview: {} }], complete: true })
const kept = (latestTurn: TranscriptPage, kept?: SessionOutline): RetainedSession => ({ latestTurn, outline: kept })

function sessions(limit: number, cachedLimit: number) {
  const made: { id: string; seed?: TranscriptSeed }[] = []
  const stamps = new Map<string, number>()
  const retained = new Map<string, RetainedSession>()
  const open = createOpenSessions({
    limit,
    cachedLimit,
    owner: null,
    make: (at, seed) => {
      made.push({ id: at.sessionId, ...(seed ? { seed } : {}) })
      return { ref: at, retained: () => retained.get(at.sessionId) } as unknown as SessionTranscript
    },
    onEvicted: () => undefined,
    stamp: (id) => stamps.get(id),
  })
  return { open, made, stamps, retained }
}

test("open sessions: an evicted idle session keeps its latest turn and outline, and a return opens from them unless the row moved", () => {
  const { open, made, stamps, retained } = sessions(1, 4)
  retained.set("s1", kept(page("s1"), outline("s1")))
  stamps.set("s1", 10)
  open.get(ref("s1"))
  open.get(ref("s2"))
  expect(open.counts()).toEqual({ open: 1, cached: 1 })
  open.get(ref("s1"))
  expect(made.at(-1)?.seed?.outline).toEqual(outline("s1"))
  expect(made.at(-1)?.seed?.latestTurn).toEqual(page("s1"))
  open.get(ref("s2"))
  stamps.set("s1", 11)
  open.get(ref("s1"))
  expect(made.at(-1)?.seed, "a row updated since the turn was kept").toBeUndefined()
})

test("open sessions: a session without a list row is never opened from a kept turn", () => {
  const { open, made, stamps, retained } = sessions(1, 4)
  retained.set("unlisted", kept(page("unlisted")))
  open.get(ref("unlisted"))
  open.get(ref("other"))
  open.get(ref("unlisted"))
  expect(made.at(-1)?.seed, "no row when the turn was kept").toBeUndefined()
  retained.set("dropped", kept(page("dropped")))
  stamps.set("dropped", 10)
  open.get(ref("dropped"))
  open.get(ref("other"))
  stamps.delete("dropped")
  open.get(ref("dropped"))
  expect(made.at(-1)?.seed, "the row is gone on return").toBeUndefined()
})

test("open sessions: evicted turns stay at their cap, dropping the oldest first, and an event or a stream gap frees one", () => {
  const { open, made, stamps, retained } = sessions(1, 2)
  for (let index = 0; index < 6; index += 1) {
    retained.set(`s${index}`, kept(page(`s${index}`)))
    stamps.set(`s${index}`, index)
    open.get(ref(`s${index}`))
  }
  expect(open.counts()).toEqual({ open: 1, cached: 2 })
  open.forgetCached(sessionId("s4"))
  expect(open.counts().cached).toBe(1)
  open.get(ref("s2"))
  expect(made.at(-1)?.seed, "the oldest kept turn was dropped").toBeUndefined()
  open.get(ref("s3"))
  expect(made.at(-1)?.seed?.latestTurn).toEqual(page("s3"))
  open.forgetCached()
  expect(open.counts().cached).toBe(0)
})
