import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { bundledAcpBinary, defaultAcpBinary } from "./default-binaries"

test("resolves the canonical Claude ACP adapter shipped with the runtime", async () => {
  const binary = defaultAcpBinary("claude-agent-acp")
  const pkg = await Bun.file(path.resolve(path.dirname(binary), "../package.json")).json()

  expect(pkg.name).toBe("@agentclientprotocol/claude-agent-acp")
  expect(pkg.version).toBe("0.63.0")
  expect(pkg.bin["claude-agent-acp"]).toBe("dist/index.js")
})

test("resolves the packaged Windows ACP executable before an extensionless fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-acp-bin-"))
  const extensionless = path.join(dir, "codex-acp")
  const executable = `${extensionless}.exe`
  fs.writeFileSync(extensionless, "")
  fs.writeFileSync(executable, "")

  expect(bundledAcpBinary(dir, "codex-acp", "win32")).toBe(executable)

  fs.rmSync(dir, { recursive: true, force: true })
})

test("resolves the packaged extensionless ACP executable on non-Windows platforms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-acp-bin-"))
  const executable = path.join(dir, "codex-acp")
  fs.writeFileSync(executable, "")

  expect(bundledAcpBinary(dir, "codex-acp", "darwin")).toBe(executable)
  expect(bundledAcpBinary(dir, "codex-acp", "linux")).toBe(executable)

  fs.rmSync(dir, { recursive: true, force: true })
})

test("falls back to the extensionless packaged executable on Windows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-acp-bin-"))
  const executable = path.join(dir, "codex-acp")
  fs.writeFileSync(executable, "")

  expect(bundledAcpBinary(dir, "codex-acp", "win32")).toBe(executable)

  fs.rmSync(dir, { recursive: true, force: true })
})
