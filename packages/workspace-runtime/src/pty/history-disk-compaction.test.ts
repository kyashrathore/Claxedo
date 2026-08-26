import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createDiskHistory, historyPath } from "./history-disk"
import { safeTrimStartUtf8 } from "./safe-slice"

const roots: string[] = []
const previousHistoryRoot = process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR

async function fixture(limit: number, id: string = crypto.randomUUID()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pty-history-compaction-"))
  roots.push(root)
  const directory = path.join(root, "workspace")
  const historyRoot = path.join(root, "history")
  process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = historyRoot
  const file = historyPath(directory, id, historyRoot)
  const history = await createDiskHistory({ directory, id, limit })
  return { root, directory, historyRoot, file, history }
}

afterEach(async () => {
  if (previousHistoryRoot === undefined) delete process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
  else process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = previousHistoryRoot
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("disk history compaction", () => {
  test("sustained flushes amortize compaction without ever persisting past the hard cap", async () => {
    const limit = 1024
    const env = await fixture(limit, "sustained")
    const writeFile = spyOn(fs, "writeFile")
    const chunks = Array.from({ length: 32 }, (_, index) =>
      `${String(index).padStart(2, "0")}:`.padEnd(256, String(index % 10)),
    )

    try {
      for (const chunk of chunks) {
        env.history.append(chunk)
        // snapshot() flushes and awaits the same serialized disk queue without
        // changing the compaction policy, making every tested flush boundary
        // deterministic instead of depending on scheduler timing.
        await env.history.snapshot()
        expect((await fs.stat(env.file)).size).toBeLessThanOrEqual(limit)
      }
      await env.history.close()

      const compactions = writeFile.mock.calls.filter(([target]) => target === env.file).length
      // The former compact-at-limit loop rewrote on 28 of these 32 windows.
      // A lower retained watermark must leave substantial room between rewrites.
      expect(compactions).toBe(14)

      const durable = await fs.readFile(env.file, "utf8")
      expect(chunks.join("")).toEndWith(durable)
      expect(Buffer.byteLength(durable, "utf8")).toBeLessThanOrEqual(limit)
      expect(await env.history.snapshot()).toBe(durable)
    } finally {
      writeFile.mockRestore()
    }
  })

  test.each([
    ["BMP", "前置" + "古".repeat(20) + "结尾", 17],
    ["emoji", "prefix" + "😀".repeat(12) + "tail", 19],
    ["lone surrogate", "prefix\ud800tail", 64],
    ["ANSI head cut", "old-output[38;5;196mNEW-TAIL", 13],
  ])("%s content is capped in UTF-8 bytes on a safe durable boundary", async (_name, value, limit) => {
    const env = await fixture(limit)
    env.history.append(value)
    await env.history.close()

    const durable = await fs.readFile(env.file, "utf8")
    expect(durable).toBe(safeTrimStartUtf8(value, limit))
    expect(Buffer.byteLength(durable, "utf8")).toBeLessThanOrEqual(limit)
    expect(durable).toBe(Buffer.from(durable, "utf8").toString("utf8"))
    if (_name === "ANSI head cut") expect(durable).toBe("NEW-TAIL")
    if (_name === "lone surrogate") expect(durable).toBe("prefix�tail")
    expect(await env.history.snapshot()).toBe(durable)
  })

  test("an oversized startup file is repaired to the hard byte cap before use", async () => {
    const limit = 64
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pty-history-startup-"))
    roots.push(root)
    const directory = path.join(root, "workspace")
    const historyRoot = path.join(root, "history")
    const file = historyPath(directory, "oversized", historyRoot)
    const oversized = "old".repeat(100) + "😀".repeat(20) + "[31mLATEST[0m"
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, oversized)

    process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = historyRoot
    const history = await createDiskHistory({ directory, id: "oversized", limit })
    const durable = await fs.readFile(file, "utf8")
    expect(Buffer.byteLength(durable, "utf8")).toBeLessThanOrEqual(limit)
    expect(durable).toBe(safeTrimStartUtf8(oversized, limit))
    expect(await history.snapshot()).toBe(durable)
  })

  test("a pre-close crash leaves a capped file that reopens with its latest durable tail", async () => {
    const limit = 512
    const env = await fixture(limit, "crash")
    const output = Array.from({ length: 20 }, (_, index) => `${index}:`.padEnd(96, "x"))
    for (const chunk of output) {
      env.history.append(chunk)
      await Bun.sleep(12)
      expect((await fs.stat(env.file)).size).toBeLessThanOrEqual(limit)
    }

    // Do not close the first owner: reopening the same capped durable file is
    // the server-restart/crash boundary this store exists to survive.
    const reopened = await createDiskHistory({
      directory: env.directory,
      id: "crash",
      limit,
    })
    const restored = await reopened.snapshot()
    expect(output.join("")).toEndWith(restored)
    expect(restored).toContain("19:")
    expect(Buffer.byteLength(restored, "utf8")).toBeLessThanOrEqual(limit)
    await reopened.close()
  })

  test("clear linearizes an immediate append after removal", async () => {
    const env = await fixture(1024, "clear-race")
    env.history.append("BEFORE-CLEAR")
    await env.history.close()

    const clearing = env.history.clear()
    env.history.append("AFTER-CLEAR")
    await clearing
    await env.history.close()

    expect(await fs.readFile(env.file, "utf8")).toBe("AFTER-CLEAR")
    expect(await env.history.snapshot()).toBe("AFTER-CLEAR")
  })
})
