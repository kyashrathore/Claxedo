import { describe, expect, test } from "bun:test"
import { PiJsonLines, PiRpcProcess } from "./rpc-process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

describe("Pi JSONL", () => {
  test("handles chunks, CRLF and literal Unicode separators without splitting JSON strings", () => {
    const parser = new PiJsonLines()
    expect(parser.read('{"type":"notice","text":"a\u2028b')).toEqual([])
    expect(parser.read('\u2029c"}\r\n{"type":"ready"}\n')).toEqual([
      { type: "notice", text: "a\u2028b\u2029c" },
      { type: "ready" },
    ])
  })
  test("rejects malformed protocol records", () => {
    expect(() => new PiJsonLines().read("null\n")).toThrow("Invalid Pi RPC record")
    expect(() => new PiJsonLines().read("not json\n")).toThrow()
  })
})

test.skipIf(!process.env.PI_EXECUTABLE)(
  "real pinned Pi answers correlated requests and rejects unknown commands",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-rpc-"))
    const rpc = new PiRpcProcess({
      binary: process.env.PI_EXECUTABLE!,
      directory,
      args: ["--mode", "rpc", "--no-session"],
      env: { ...process.env, PI_CODING_AGENT_DIR: directory },
    })
    try {
      const [state, catalog] = await Promise.all([rpc.request("get_state"), rpc.request("get_available_models")])
      expect(state).toHaveProperty("sessionId")
      expect(catalog).toHaveProperty("models")
      await expect(rpc.request("unknown-command")).rejects.toThrow()
      const exited = new Promise<void>((resolve) => rpc.onExit(() => resolve()))
      rpc.dispose()
      await exited
      await expect(rpc.request("get_state")).rejects.toThrow("disposed")
    } finally {
      rpc.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)

test.skipIf(!process.env.PI_EXECUTABLE)(
  "real Pi does not load an untrusted checkout extension",
  async () => {
    const fs = await import("node:fs/promises")
    const directory = await mkdtemp(path.join(tmpdir(), "pi-untrusted-"))
    const extensionDir = path.join(directory, ".pi", "extensions")
    const marker = path.join(directory, "extension-loaded")
    await fs.mkdir(extensionDir, { recursive: true })
    await fs.writeFile(
      path.join(extensionDir, "untrusted.ts"),
      `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
    )
    const rpc = new PiRpcProcess({
      binary: process.env.PI_EXECUTABLE!,
      directory,
      args: ["--mode", "rpc", "--no-session"],
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "managed-profile") },
    })
    try {
      expect(await rpc.request("get_state")).toHaveProperty("sessionId")
      expect(
        await fs.stat(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      rpc.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)
