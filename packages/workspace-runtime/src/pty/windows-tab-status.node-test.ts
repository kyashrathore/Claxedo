import { testSessionCore } from "@claxedo/session-core/testing"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { withSessionCore } from "../session-context"

async function waitFor(check: () => boolean, timeoutMs = 30_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

if (process.platform !== "win32") void test("a Windows tab reports an agent typed by name", { skip: "cmd.exe tabs exist only on Windows" }, () => {})
else void test("a Windows tab reports an agent typed by name: cmd.exe runs its Claxedo wrapper, which reports Busy, then Idle", { timeout: 90_000 }, async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "windows-tab-status-"))
  const previous = { history: process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR, path: process.env.PATH }
  const received: URLSearchParams[] = []
  const server = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
    incoming.on("end", () => {
      received.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))
      outgoing.writeHead(200, { "content-type": "application/json" }).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const fakes = path.join(tmpDir, "fake-clis")
  await fs.mkdir(fakes, { recursive: true })
  await fs.writeFile(path.join(fakes, "aider.cmd"), "@echo fake-aider-ran\r\n@exit /b 0\r\n")
  process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = path.join(tmpDir, "history")
  process.env.PATH = `${fakes};${process.env.PATH ?? ""}`
  const { Pty } = await import("./index")
  try {
    const info = await withSessionCore(testSessionCore(tmpDir), () =>
      Pty.create({ cwd: tmpDir, env: { CLAXEDO_PORT: String(port) } }, volatileLaunchOwnership()))
    Pty.write(info.id, "aider\r\n")
    await waitFor(() => received.length >= 2)
    assert.match(Pty.snapshot(info.id), /fake-aider-ran/)
    assert.deepEqual(
      received.map((form) => [form.get("terminalId"), form.get("provider"), JSON.parse(form.get("providerEvent") ?? "{}").hook_event_name]),
      [[info.id, "aider", "Busy"], [info.id, "aider", "Idle"]],
    )
  } finally {
    await Pty.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previous.history === undefined) delete process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR
    else process.env.WORKSPACE_RUNTIME_PTY_HISTORY_DIR = previous.history
    process.env.PATH = previous.path
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})
