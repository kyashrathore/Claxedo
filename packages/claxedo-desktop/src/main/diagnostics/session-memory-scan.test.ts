import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanSessionMemoryStores, type SessionMemoryDatabase } from "./session-memory-scan"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("session memory store scan", () => {
  test("scans only Claxedo-owned databases and merges the triggered warm snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "claxedo-session-memory-"))
    roots.push(root)
    const databasePath = join(root, "opencode.db")
    await writeFile(databasePath, "fixture")
    const database: SessionMemoryDatabase = {
      prepare: () => ({
        all: () => [{
          id: "ses_claxedo",
          title: "Claxedo task",
          updatedAt: 10,
          chatBytes: 100,
          imageBytes: 20,
          compactionBytes: 30,
          totalBytes: 150,
        }],
      }),
      close: () => undefined,
    }
    const warm = [{
      sessionId: "ses_warm",
      mounted: false,
      recency: 0,
      messageCount: 4,
      buckets: { chatBytes: 40, imageBytes: 50, compactionBytes: 60, totalBytes: 150 },
    }]
    const times = [1_000, 1_025]

    const result = await scanSessionMemoryStores({
      paths: { databases: [{ path: databasePath, profile: "test" }] },
      warmSessions: warm,
      openDatabase: () => database,
      now: () => times.shift()!,
    })

    expect(result.durationMs).toBe(25)
    expect(result.sources.map((source) => [source.harness, source.state, source.sessionCount])).toEqual([
      ["claxedo", "scanned", 1],
    ])
    expect(result.sessions).toEqual([
      expect.objectContaining({ sessionId: "ses_claxedo", title: "Claxedo task", harness: "claxedo" }),
    ])
    expect(result.stored).toEqual({ chatBytes: 100, imageBytes: 20, compactionBytes: 30, totalBytes: 150 })
    expect(result.resident).toEqual(warm[0]!.buckets)
  })
})
