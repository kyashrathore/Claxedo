/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test"
import { createAttentionHistory } from "./attention-history"
import type { Transport } from "./transport"
import type { HostedAccount } from "./account"

const notice = { cursor: 4, sessionId: "s1", workspaceId: "w1", projectId: "p1", generation: 1, title: "Recovered", event: { sequence: 8, openedAt: 1, kind: "question", requestId: "q1" } }

function localTransport(read: (path: string) => Promise<unknown>): Transport {
  return { loopback: true, json: read } as Transport
}

async function settle() {
  for (let tick = 0; tick < 24; tick++) await Promise.resolve()
}

test("startup and gaps recover durable history in pages and classify every recovered notice as replay", async () => {
  const queries: string[] = []
  const frames: unknown[] = []
  const history = createAttentionHistory({
    transport: localTransport(async (path) => {
      queries.push(path)
      const after = Number(new URL(path, "http://localhost").searchParams.get("after"))
      return after === 0 ? { events: [notice], next: 4, through: 9 } : { events: [], through: 9 }
    }),
    frame: (frame) => frames.push(frame),
  })
  history.recover()
  await settle()
  expect(queries).toEqual(["/api/claxedo/session-attention?after=0&limit=256", "/api/claxedo/session-attention?after=4&limit=256"])
  expect(frames).toEqual([{ ...notice, type: "session.attention.raised", replayed: true }])
  history.recover()
  await settle()
  expect(queries.at(-1)).toBe("/api/claxedo/session-attention?after=9&limit=256")
  history.dispose()
})

test("signed desktop recovers local and account sources independently", async () => {
  const local: string[] = []
  const hosted: unknown[] = []
  const account = { run: async (operation: string, input: unknown) => { hosted.push({ operation, input }); return { events: [], through: 7 } } } as HostedAccount
  const history = createAttentionHistory({ transport: localTransport(async (path) => { local.push(path); return { events: [], through: 2 } }), account, frame: () => undefined })
  history.recover()
  await settle()
  history.recover()
  await settle()
  expect(local.at(-1)).toContain("after=2")
  expect(hosted).toEqual([{ operation: "session.attention.history", input: { after: 0, limit: 256 } }, { operation: "session.attention.history", input: { after: 7, limit: 256 } }])
  history.dispose()
})

test("a share change during recovery resets the next admitted read to include new visibility", async () => {
  const cursors: number[] = []
  let resolve: (value: unknown) => void = () => undefined
  const history = createAttentionHistory({ transport: localTransport(async (path) => {
    cursors.push(Number(new URL(path, "http://localhost").searchParams.get("after")))
    return cursors.length === 1 ? new Promise((done) => { resolve = done }) : { events: [], through: 20 }
  }), frame: () => undefined })
  history.recover()
  history.recover(true)
  resolve({ events: [], through: 10 })
  await settle()
  expect(cursors).toEqual([0, 0])
  history.dispose()
})

test("disposal prevents a pending account answer from publishing attention", async () => {
  const frames: unknown[] = []
  let resolve: (value: unknown) => void = () => undefined
  const history = createAttentionHistory({ transport: localTransport(() => new Promise((done) => { resolve = done })), frame: (frame) => frames.push(frame) })
  history.recover()
  history.dispose()
  resolve({ events: [notice], through: 4 })
  await settle()
  expect(frames).toEqual([])
})

test("an unavailable history source reports failure and keeps its cursor for the next explicit recovery", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined)
  const cursors: number[] = []
  const history = createAttentionHistory({ transport: localTransport(async (path) => {
    cursors.push(Number(new URL(path, "http://localhost").searchParams.get("after")))
    if (cursors.length === 1) throw new TypeError("source offline")
    return { events: [], through: 10 }
  }), frame: () => undefined })
  try {
    history.recover()
    await settle()
    expect(cursors).toEqual([0])
    expect(errors).toHaveBeenCalledWith("Session attention history could not be recovered", expect.objectContaining({ source: "local", error: expect.objectContaining({ class: "network" }) }))
    history.recover()
    await settle()
    expect(cursors).toEqual([0, 0])
  } finally {
    history.dispose()
    errors.mockRestore()
  }
})

test("a share visibility reset survives an in-flight recovery failure", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined)
  const cursors: number[] = []
  let reject: (error: unknown) => void = () => undefined
  const history = createAttentionHistory({ transport: localTransport(async (path) => {
    cursors.push(Number(new URL(path, "http://localhost").searchParams.get("after")))
    return cursors.length === 2 ? new Promise((_, fail) => { reject = fail }) : { events: [], through: 20 }
  }), frame: () => undefined })
  try {
    history.recover()
    await settle()
    history.recover()
    history.recover(true)
    reject(new TypeError("source offline"))
    await settle()
    expect(cursors).toEqual([0, 20])
    history.recover()
    await settle()
    expect(cursors).toEqual([0, 20, 0])
  } finally {
    history.dispose()
    errors.mockRestore()
  }
})

test("a malformed durable notice reports failure without advancing the recovery cursor", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => undefined)
  const cursors: number[] = []
  const frames: unknown[] = []
  const history = createAttentionHistory({ transport: localTransport(async (path) => {
    cursors.push(Number(new URL(path, "http://localhost").searchParams.get("after")))
    return { events: [{ ...notice, ...(cursors.length === 1 ? { projectId: undefined } : {}) }], through: 4 }
  }), frame: (frame) => frames.push(frame) })
  try {
    history.recover()
    await settle()
    expect(frames).toEqual([])
    expect(errors).toHaveBeenCalledWith("Session attention history could not be recovered", expect.objectContaining({ error: expect.objectContaining({ class: "internal" }) }))
    history.recover()
    await settle()
    expect(cursors).toEqual([0, 0])
    expect(frames).toEqual([{ ...notice, type: "session.attention.raised", replayed: true }])
  } finally {
    history.dispose()
    errors.mockRestore()
  }
})
