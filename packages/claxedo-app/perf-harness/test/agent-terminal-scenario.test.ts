import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createTerminalWorkload,
  TERMINAL_COMPLETE_MARKER,
  TERMINAL_START_MARKER,
  TERMINAL_SUSTAINED_DURATION_MS,
  TERMINAL_SUSTAINED_LOAD_MIB_S,
} from "../src/agent-terminal-scenario"

describe("Claxedo terminal workload", () => {
  test("builds a deterministic framed byte stream", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-terminal-workload-"))
    try {
      const result = await createTerminalWorkload(root, {
        id: "terminal-1",
        columns: 120,
        rows: 36,
        expectedBytes: 15,
        expectedSha256: "test-only",
        chunks: [
          { sequence: 0, atMs: 0, bytesBase64: Buffer.from("before\r\n").toString("base64") },
          { sequence: 1, atMs: 1, bytesBase64: Buffer.from("after\r\n").toString("base64") },
        ],
        inputSentinels: ["probe-1"],
      }, { durationMs: 100, loadMiBS: 0.0002, ticks: 2 })
      expect(result.expectedBytes).toBe(Buffer.byteLength(
        `${TERMINAL_START_MARKER}before\r\nafter\r\n\u001b[33m⟦input-ready:probe-1⟧\u001b[0m\r\n\u001b[36m⟦input:probe-1⟧\u001b[0m\r\nbefore\r\nafter\r\n${TERMINAL_COMPLETE_MARKER}`,
      ))
      expect(result.sustainedDurationMs).toBe(100)
      expect(result.expectedSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.command).toContain("terminal-workload.mjs")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })


  // The canonical corpus is a GENERATED 5.6MB artifact under the gitignored
  // `.artifacts/` — it exists only on machines that materialised it (see
  // agent-corpus-materializer). Skipping when absent follows the lane's own
  // gating convention (`requireBinary`'s GATING pattern): the pin can only be
  // checked against the thing it pins, and a fresh checkout does not have it.
  // The skip is visible in the reporter, never a silent pass.
  const CANONICAL_CORPUS = path.resolve(
    import.meta.dir,
    "../../../../.artifacts/agent-app-benchmark/corpus-agent-app-core-v1-8c8ac43d5f3a.json",
  )

  test.skipIf(!existsSync(CANONICAL_CORPUS))(
    "production contract pins the canonical ten-second wire stream", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-terminal-sustained-"))
    try {
      const corpusPath = CANONICAL_CORPUS
      const corpus = await Bun.file(corpusPath).json()
      const stream = corpus.sessions[0].terminalStreams[0]
      const result = await createTerminalWorkload(root, stream)
      expect(result.sustainedDurationMs).toBe(TERMINAL_SUSTAINED_DURATION_MS)
      expect(result.offeredLoadMiBS).toBeGreaterThanOrEqual(TERMINAL_SUSTAINED_LOAD_MIB_S)
      expect(result.expectedBytes).toBe(220_201_166)
      expect(result.expectedSha256).toBe("f43e5bf0baeade571dec6540f3e7e827077ba171836bef63b1b0bf3ea77f518b")
      expect(result.expectedModelHash).toBe("8d7e396ae2659a881ed49361466059d43ea3b1dba210b9499e610b0be12aa330")
      expect(result.inputByteThresholds).toHaveLength(2)
      expect(result.inputByteThresholds[0]!).toBeGreaterThan(70 * 1024 * 1024)
      expect(result.inputByteThresholds[1]!).toBeGreaterThan(140 * 1024 * 1024)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps the PTY workload alive until the measured model has drained", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-terminal-lifecycle-"))
    try {
      await createTerminalWorkload(root, {
        id: "terminal-lifecycle",
        columns: 120,
        rows: 36,
        expectedBytes: 15,
        expectedSha256: "test-only",
        chunks: [
          { sequence: 0, atMs: 0, bytesBase64: Buffer.from("before\r\n").toString("base64") },
          { sequence: 1, atMs: 1, bytesBase64: Buffer.from("after\r\n").toString("base64") },
        ],
        inputSentinels: ["probe-1"],
      }, { durationMs: 50, loadMiBS: 0.001, ticks: 2 })
      const child = Bun.spawn([
        process.execPath,
        path.join(root, "terminal-workloads", "terminal-workload.mjs"),
        path.join(root, "terminal-workloads", "terminal-lifecycle.json"),
      ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      let exited = false
      void child.exited.then(() => { exited = true })
      await Bun.sleep(45)
      child.stdin.write("probe-1\n")
      await child.stdin.flush()

      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ""
      while (!output.includes("⟦t3-benchmark-complete⟧")) {
        const next = await reader.read()
        if (next.done) break
        output += decoder.decode(next.value, { stream: true })
      }
      await Bun.sleep(20)
      expect(output).toContain("⟦input:probe-1⟧")
      expect(output).toContain("⟦t3-benchmark-complete⟧")
      expect(exited).toBe(false)

      child.stdin.write("T3_TERMINAL_SHUTDOWN\n")
      await child.stdin.flush()
      child.stdin.end()
      expect(await child.exited).toBe(0)
      reader.releaseLock()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
