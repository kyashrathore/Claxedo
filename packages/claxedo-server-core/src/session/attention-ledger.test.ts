import { afterAll, afterEach, beforeEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { SessionAttentionFacts, SessionAttentionEvent } from "@claxedo/agent-runtime-contract"

const root = path.join(os.tmpdir(), `attention-ledger-${randomUUID()}`)
const previous = { data: process.env.CLAXEDO_DATA_DIR, state: process.env.CLAXEDO_STATE_DIR }
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
const [{ ClaxedoDB }, meta, ledger] = await Promise.all([import("../platform/db"), import("./meta/index"), import("./attention-ledger")])
const workspace = { id: "ws_local", project_id: "project_local", directory: "/tmp/local", kind: "local" as const, created_at: 1, updated_at: 1 }
const facts: SessionAttentionFacts = { generation: 1, sequence: 20, activitySequence: 20, activityAt: 200, working: false, awaitingInput: false }
const events: SessionAttentionEvent[] = [
  { kind: "question", sequence: 5, requestId: "q1", openedAt: 50 },
  { kind: "permission", sequence: 10, requestId: "p1", openedAt: 100 },
  { kind: "outcome", sequence: 20, outcome: "completed", openedAt: 200 },
]

beforeEach(async () => { await fs.mkdir(root, { recursive: true }) })
afterEach(async () => { ClaxedoDB.close(); await fs.rm(root, { recursive: true, force: true }) })
afterAll(() => {
  if (previous.data === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.data
  if (previous.state === undefined) delete process.env.CLAXEDO_STATE_DIR
  else process.env.CLAXEDO_STATE_DIR = previous.state
})

async function seed(id = "session", attention = facts, parentID?: string) {
  await meta.syncSessionMeta(workspace, { id, title: id, parentID, time: { created: 1, updated: 200 }, attention })
  return (await meta.sessionMeta(id))!.sessionRef!
}
const batch = (sessionId = "session", entries = events, through = 20, generation = 1) =>
  ({ sessionId, workspaceId: workspace.id, generation, through, events: entries })

test("canonical transient requests persist after acknowledgement and restart with stable cursors", async () => {
  const ref = await seed()
  const stored = ledger.appendLocalSessionAttention(ref, batch())
  expect(stored.map((row) => row.event)).toEqual(events)
  expect(stored.map((row) => row.cursor)).toEqual([1, 2, 3])
  ClaxedoDB.close()
  expect(ledger.localSessionAttentionPosition(ref, 1)).toBe(20)
  expect(ledger.appendLocalSessionAttention(ref, batch())).toEqual([])
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 2 })).toMatchObject({ through: 3, next: 2, events: [{ cursor: 1 }, { cursor: 2 }] })
  expect(ledger.listLocalSessionAttention({ after: 2, limit: 2 })).toEqual({ events: [stored[2]], through: 3 })
})

test("invalid generation, future positions, children and mutated canonical events cannot enter the ledger", async () => {
  const ref = await seed()
  const child = await seed("child", facts, "session")
  expect(() => ledger.appendLocalSessionAttention(child, batch("child"))).toThrow("Root session not found")
  expect(() => ledger.appendLocalSessionAttention(ref, batch("session", [], 21))).toThrow("Session activity changed")
  expect(() => ledger.appendLocalSessionAttention(ref, batch("session", [], 20, 2))).toThrow("Session activity changed")
  ledger.appendLocalSessionAttention(ref, batch())
  expect(() => ledger.appendLocalSessionAttention(ref, batch("session", [{ ...events[0], openedAt: 51 }], 20))).toThrow("Canonical session attention event changed")
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 }).events).toHaveLength(3)
})

test("deleting metadata hides history immediately and generation reuse cannot inherit prior events", async () => {
  const ref = await seed()
  ledger.appendLocalSessionAttention(ref, batch())
  await meta.deleteSessionMeta("session")
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 })).toEqual({ events: [], through: 3 })
  const newRef = await seed("session", { ...facts, generation: 21, sequence: 25, activitySequence: 25 })
  const second = ledger.appendLocalSessionAttention(newRef, batch("session", [{ kind: "outcome", sequence: 25, openedAt: 250, outcome: "failed" }], 25, 21))
  expect(second[0].cursor).toBeGreaterThan(3)
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 }).events).toEqual(second)
  expect(ledger.localSessionAttentionPosition(newRef, 21)).toBe(25)
})

test("ref changes preserve ordinals, merge scan positions, and cleanup never rewinds the recovery watermark", async () => {
  const fromRef = await seed()
  ledger.appendLocalSessionAttention(fromRef, batch())
  const toRef = "workspace:ws_local:session:session"
  ClaxedoDB.transaction((db) => ledger.rekeyLocalSessionAttention(db, fromRef, toRef))
  expect(ledger.localSessionAttentionPosition(toRef, 1)).toBe(20)
  expect(ledger.localSessionAttentionPosition(fromRef, 1)).toBe(0)
  expect(ClaxedoDB.raw().prepare("SELECT ordinal FROM claxedo_session_attention WHERE session_ref = ? ORDER BY ordinal").all(toRef))
    .toEqual([{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }])
  ClaxedoDB.transaction((db) => ledger.deleteLocalSessionAttention(db, toRef))
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 })).toEqual({ events: [], through: 3 })
})
