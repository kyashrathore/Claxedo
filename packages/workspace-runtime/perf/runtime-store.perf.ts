import { afterEach, describe, it } from "bun:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { messagePartUpdated } from "../src/compat-events"
import { RuntimeStore } from "../src/store"

const roots: string[] = []

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-store-perf-"))
  roots.push(root)
  return root
}

function database(store: RuntimeStore) {
  return (store as unknown as {
    db: {
      exec(sql: string): unknown
      prepare(sql: string): {
        run(...params: unknown[]): unknown
        get(...params: unknown[]): unknown
      }
    }
  }).db
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

describe("RuntimeStore performance", () => {
  it("opens a checkpointed 64 MiB journal without loading its payloads", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    const payload = JSON.stringify(messagePartUpdated({
      id: "legacy-tool-snapshot",
      sessionID: "s1",
      messageID: "m1",
      type: "text",
      text: "x".repeat(1024 * 1024),
    }))
    database(first).exec("BEGIN")
    for (const seq of Array.from({ length: 64 }, (_, index) => index + 2)) {
      database(first).prepare(`
        INSERT INTO runtime_journal (
          session_id,
          seq,
          kind,
          type,
          created_at,
          payload_json
        ) VALUES (?, ?, 'event', 'message.part.updated', ?, ?)
      `).run("s1", seq, seq, payload)
    }
    database(first).prepare(
      "UPDATE journal_checkpoint SET last_seq = ?, updated_at = ? WHERE session_id = ?",
    ).run(65, 65, "s1")
    database(first).exec("COMMIT")
    first.close()

    Bun.gc(true)
    const rss = process.memoryUsage().rss
    const started = performance.now()
    const reopened = new RuntimeStore(root)
    const elapsed = performance.now() - started
    const rssGrowth = process.memoryUsage().rss - rss

    assert.equal(reopened.getAgentSessionId("s1"), "a1")
    assert(elapsed < 100, `checkpointed reopen took ${elapsed.toFixed(1)}ms`)
    assert(rssGrowth < 32 * 1024 * 1024, `checkpointed reopen grew RSS by ${(rssGrowth / 1024 / 1024).toFixed(1)} MiB`)
    reopened.close()
  })

  it("bounds repeated full-snapshot journal storage to the latest part state", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    for (const index of Array.from({ length: 64 }, (_, value) => value)) {
      store.appendEvent({
        sessionId: "s1",
        payload: messagePartUpdated({
          id: "tool-snapshot",
          sessionID: "s1",
          messageID: "m1",
          type: "text",
          text: `${index}:${"x".repeat(512 * 1024)}`,
        }),
      })
    }

    const row = database(store).prepare(`
      SELECT COUNT(*) AS count, SUM(LENGTH(payload_json)) AS bytes
      FROM runtime_journal
      WHERE session_id = ?
        AND type = 'message.part.updated'
        AND part_id = ?
    `).get("s1", "tool-snapshot") as { count: number; bytes: number }
    assert.equal(row.count, 1)
    assert(row.bytes < 600 * 1024, `snapshot journal retained ${(row.bytes / 1024 / 1024).toFixed(1)} MiB`)
    store.close()
  })
})
