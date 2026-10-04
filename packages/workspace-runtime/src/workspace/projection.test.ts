import { expect, test } from "bun:test"
import { createRuntimeProjection } from "./projection"

test("another harness's plugin changes do not change a session's launch generation", () => {
  const project = createRuntimeProjection()
  const claude = { id: "claude", access: "native" } as const
  const initial = project(claude, { generation: "runtime:1", mcp: {}, harnessLaunch: {} })
  const unrelated = { generation: "runtime:2", mcp: {}, harnessLaunch: { codex: { generation: "new", execution: { mode: "default" }, pluginRoots: [], mcpServers: [], notApplied: [] } } }
  expect(project(claude, unrelated)).toEqual(initial)
  const changed = project(claude, { ...unrelated, harnessLaunch: { claude: { generation: "changed-content", execution: { mode: "default" }, pluginRoots: [], mcpServers: [], notApplied: [] } } })
  expect(changed.generation).not.toBe(initial.generation)
})

test("effective MCP changes invalidate the launch while an unused MCP change does not", () => {
  const project = createRuntimeProjection()
  const claude = { id: "claude", access: "native" } as const
  const source = { generation: "runtime:1", mcp: {}, harnessLaunch: {} }
  const initial = project(claude, source)
  const mcp = { docs: { name: "docs", transport: "remote", source: "user", url: "https://docs.example/mcp", headers: {} } }
  const changed = project(claude, { ...source, generation: "runtime:2", mcp })
  expect(changed.generation).not.toBe(initial.generation)
  expect(project(claude, { ...source, generation: "runtime:3", mcp })).toEqual(changed)
})
