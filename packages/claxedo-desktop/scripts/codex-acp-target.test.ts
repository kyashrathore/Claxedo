import { expect, test } from "bun:test"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { codexAcpTarget } from "./codex-acp-target"

test("maps desktop targets to the matching Codex vendor and Bun executable", () => {
  const targets = [
    ["darwin", "arm64", "aarch64-apple-darwin", "bun-darwin-arm64"],
    ["darwin", "x64", "x86_64-apple-darwin", "bun-darwin-x64-baseline"],
    ["linux", "arm64", "aarch64-unknown-linux-musl", "bun-linux-arm64"],
    ["linux", "x64", "x86_64-unknown-linux-musl", "bun-linux-x64-baseline"],
    ["win32", "arm64", "aarch64-pc-windows-msvc", "bun-windows-arm64"],
    ["win32", "x64", "x86_64-pc-windows-msvc", "bun-windows-x64-baseline"],
  ] as const

  targets.forEach(([platform, arch, triple, bun]) => {
    expect(codexAcpTarget(platform, arch)).toEqual({ triple, bun })
  })
})

test("rejects unsupported Codex ACP targets", () => {
  expect(() => codexAcpTarget("freebsd", "x64")).toThrow("Unsupported Codex ACP target: freebsd/x64")
})

test("desktop packages the config-options-capable Codex ACP adapter", async () => {
  const pkg = await Bun.file(path.resolve(import.meta.dir, "../package.json")).json()

  expect(pkg.devDependencies["@agentclientprotocol/codex-acp"]).toBe("1.1.2")
  expect(pkg.devDependencies["@agentclientprotocol/claude-agent-acp"]).toBe("0.60.0")
  expect(pkg.devDependencies["@openai/codex"]).toBe("0.144.4")
  expect(pkg.devDependencies["@zed-industries/claude-agent-acp"]).toBeUndefined()
  expect(pkg.devDependencies["@zed-industries/codex-acp"]).toBeUndefined()
})

test("desktop development resolves both ACP adapters beside the server bundle", () => {
  const require = createRequire(path.resolve(import.meta.dir, "../resources/claxedo-server/index.js"))
  const claudePkg = require.resolve("@agentclientprotocol/claude-agent-acp/package.json")

  expect(require.resolve("@agentclientprotocol/codex-acp/package.json")).toContain("@agentclientprotocol/codex-acp")
  expect(claudePkg).toContain("@agentclientprotocol/claude-agent-acp")
  expect(JSON.parse(fs.readFileSync(claudePkg, "utf8")).version).toBe("0.60.0")
})
