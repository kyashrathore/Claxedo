import { expect, test } from "bun:test"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

test("desktop packages the config-options-capable Codex ACP adapter", async () => {
  const pkg = await Bun.file(path.resolve(import.meta.dir, "../package.json")).json()

  expect(pkg.devDependencies["@agentclientprotocol/codex-acp"]).toBe("1.1.7")
  expect(pkg.devDependencies["@agentclientprotocol/claude-agent-acp"]).toBe("0.63.0")
  expect(pkg.devDependencies["@zed-industries/claude-agent-acp"]).toBeUndefined()
  expect(pkg.devDependencies["@zed-industries/codex-acp"]).toBeUndefined()
})

test("desktop development resolves both ACP adapters beside the server bundle", () => {
  const require = createRequire(path.resolve(import.meta.dir, "../resources/claxedo-server/index.js"))
  const claudePkg = require.resolve("@agentclientprotocol/claude-agent-acp/package.json")
  const portable = (value: string) => value.replaceAll("\\", "/")

  expect(portable(require.resolve("@agentclientprotocol/codex-acp/package.json"))).toContain(
    "@agentclientprotocol/codex-acp",
  )
  expect(portable(claudePkg)).toContain("@agentclientprotocol/claude-agent-acp")
  expect(JSON.parse(fs.readFileSync(claudePkg, "utf8")).version).toBe("0.63.0")
})
