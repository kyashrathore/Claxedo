import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cleanupOrphanedHistory, createDiskHistory, historyPath } from "./history-disk"

let root: string
const previous = process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pty-history-cleanup-"))
  process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = path.join(root, "history")
})

afterEach(async () => {
  if (previous === undefined) delete process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
  else process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = previous
  await fs.rm(root, { recursive: true, force: true })
})

async function writeAged(directory: string, id: string, content: string, ageMs: number) {
  const file = historyPath(directory, id)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  const when = new Date(Date.now() - ageMs)
  await fs.utimes(file, when, when)
  return file
}

const DAY = 24 * 60 * 60 * 1000

describe("cleanupOrphanedHistory", () => {
  test("removes transcripts past the retention window", async () => {
    const stale = await writeAged("/proj", "pty_stale", "old output", 10 * DAY)
    const result = await cleanupOrphanedHistory(undefined, 7 * DAY)
    expect(result.removed).toBe(1)
    await expect(fs.readFile(stale, "utf8")).rejects.toThrow()
  })

  test("keeps transcripts inside the window — they are still restorable", async () => {
    const fresh = await writeAged("/proj", "pty_fresh", "recent output", 1 * DAY)
    await cleanupOrphanedHistory(undefined, 7 * DAY)
    expect(await fs.readFile(fresh, "utf8")).toBe("recent output")
  })

  test("does not touch non-log files", async () => {
    const file = historyPath("/proj", "pty_x")
    await fs.mkdir(path.dirname(file), { recursive: true })
    const other = path.join(path.dirname(file), "notes.txt")
    await fs.writeFile(other, "keep me")
    const when = new Date(Date.now() - 30 * DAY)
    await fs.utimes(other, when, when)
    await cleanupOrphanedHistory(undefined, 7 * DAY)
    expect(await fs.readFile(other, "utf8")).toBe("keep me")
  })

  test("tolerates a missing root", async () => {
    process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = path.join(root, "does-not-exist")
    const result = await cleanupOrphanedHistory(undefined, 7 * DAY)
    expect(result.removed).toBe(0)
  })

  test("NEVER deletes the bucket of a live session that has not flushed yet", async () => {
    // Regression: the sweep used to rmdir empty buckets. A session creates its
    // bucket at startup and writes ~8ms later on the first flush; a sweep in
    // that window deleted the directory out from under a LIVE terminal and
    // every subsequent append failed with ENOENT.
    const directory = path.join(root, "live-project")
    const history = await createDiskHistory({ directory, id: "pty_live", limit: 1024 * 1024 })

    // Bucket exists, file does not yet — exactly the vulnerable window.
    await cleanupOrphanedHistory(undefined, 7 * DAY)

    history.append("output after the sweep\n")
    await history.close()

    expect(await fs.readFile(historyPath(directory, "pty_live"), "utf8")).toContain(
      "output after the sweep",
    )
  })
})

describe("createDiskHistory memory contract", () => {
  test("does not read the transcript into memory at startup", async () => {
    const directory = path.join(root, "big")
    const file = historyPath(directory, "pty_big")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "x".repeat(4 * 1024 * 1024))

    const history = await createDiskHistory({ directory, id: "pty_big", limit: 16 * 1024 * 1024 })
    // `size()` reflects the file without the content ever being resident.
    expect(history.size()).toBeGreaterThan(4 * 1024 * 1024 - 1)
    await history.close()
  })

  test("snapshot reads the tail from disk, capped", async () => {
    const directory = path.join(root, "tail")
    const history = await createDiskHistory({ directory, id: "pty_tail", limit: 1024 * 1024 })
    history.append("A".repeat(1000) + "TAIL-MARKER")
    const snap = await history.snapshot(64)
    expect(snap.length).toBeLessThanOrEqual(64)
    expect(snap).toContain("TAIL-MARKER")
    await history.close()
  })

  test("snapshot flushes staged output first, so a session that dies immediately still restores", async () => {
    const directory = path.join(root, "staged")
    const history = await createDiskHistory({ directory, id: "pty_staged", limit: 1024 * 1024 })
    history.append("written but not yet flushed")
    expect(await history.snapshot()).toContain("written but not yet flushed")
    await history.close()
  })

  test("compaction trims the FILE to the limit, keeping the tail", async () => {
    const directory = path.join(root, "compact")
    const limit = 4096
    const history = await createDiskHistory({ directory, id: "pty_compact", limit })
    history.append("O".repeat(limit))
    await history.close()
    history.append("NEWEST-CONTENT")
    await history.close()

    const onDisk = await fs.readFile(historyPath(directory, "pty_compact"), "utf8")
    expect(onDisk.length).toBeLessThanOrEqual(limit)
    expect(onDisk).toContain("NEWEST-CONTENT")
  })
})
