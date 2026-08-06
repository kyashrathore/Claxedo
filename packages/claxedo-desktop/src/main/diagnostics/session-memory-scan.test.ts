import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanSessionMemoryStores, type SessionMemoryDatabase } from "./session-memory-scan"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("session memory store scan", () => {
  test("scans Codex, Claude, Claxedo, and merges the triggered warm snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "claxedo-session-memory-"))
    roots.push(root)
    const codexHome = join(root, "codex")
    const claudeHome = join(root, "claude")
    const databasePath = join(root, "opencode.db")
    await mkdir(join(codexHome, "sessions", "2026", "01", "01"), { recursive: true })
    await mkdir(join(claudeHome, "projects", "repo"), { recursive: true })
    await writeFile(join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", thread_name: "Image task" })}\n`)
    await writeFile(
      join(codexHome, "sessions", "2026", "01", "01", "rollout-11111111-1111-1111-1111-111111111111.jsonl"),
      [
        JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ type: "input_image", image_url: `data:image/png;base64,${"a".repeat(300)}` }] } }),
        JSON.stringify({ type: "compacted", payload: { replacement_history: [{ text: "summary" }] } }),
      ].join("\n"),
    )
    await writeFile(
      join(claudeHome, "projects", "repo", "22222222-2222-2222-2222-222222222222.jsonl"),
      [
        JSON.stringify({ type: "custom-title", customTitle: "Claude image task" }),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "b".repeat(300) } }] } }),
      ].join("\n"),
    )
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
      paths: { codexHome, claudeHome, databases: [{ path: databasePath, profile: "test" }] },
      warmSessions: warm,
      openDatabase: () => database,
      now: () => times.shift()!,
    })

    expect(result.durationMs).toBe(25)
    expect(result.sources.map((source) => [source.harness, source.state, source.sessionCount])).toEqual([
      ["codex", "scanned", 1],
      ["claude", "scanned", 1],
      ["claxedo", "scanned", 1],
    ])
    expect(result.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "11111111-1111-1111-1111-111111111111", title: "Image task", harness: "codex" }),
      expect.objectContaining({ sessionId: "22222222-2222-2222-2222-222222222222", title: "Claude image task", harness: "claude" }),
      expect.objectContaining({ sessionId: "ses_claxedo", harness: "claxedo" }),
    ]))
    expect(result.stored.imageBytes).toBeGreaterThan(600)
    expect(result.stored.compactionBytes).toBeGreaterThan(30)
    expect(result.resident).toEqual(warm[0]!.buckets)
  })
})
