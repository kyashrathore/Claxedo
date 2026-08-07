import { expect, test } from "bun:test"
import path from "node:path"

test("desktop packages match the ACP runtime launch pins", async () => {
  const desktop = await Bun.file(path.join(import.meta.dir, "../package.json")).json()
  const runtime = await Bun.file(path.join(import.meta.dir, "../../agent-sdk-runtime/package.json")).json()
  const pins = await Bun.file(path.join(import.meta.dir, "../../agent-sdk-runtime/src/harnesses/acp/session.ts")).text()

  expect(desktop.devDependencies["@agentclientprotocol/claude-agent-acp"]).toBe("0.63.0")
  expect(desktop.devDependencies["@agentclientprotocol/codex-acp"]).toBe("1.1.7")
  expect(runtime.dependencies["@agentclientprotocol/claude-agent-acp"]).toBe("0.63.0")
  expect(runtime.dependencies["@agentclientprotocol/codex-acp"]).toBe("1.1.7")
  expect(pins).toContain('claude: { package: "@agentclientprotocol/claude-agent-acp", version: "0.63.0" }')
  expect(pins).toContain('codex: { package: "@agentclientprotocol/codex-acp", version: "1.1.7" }')
})
