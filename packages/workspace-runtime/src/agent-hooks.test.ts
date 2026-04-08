import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { getClaxedoMcpStdioConfig, requireClaxedoMcpStdioConfig, resolveClaxedoMcpCommand } from "./agent-hooks"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-runtime-agent-hooks-"))
  dirs.push(dir)
  return dir
}

describe("workspace-runtime claxedo-mcp resolution", () => {
  test("prefers the bundled Node artifact when present", () => {
    const dir = temp()
    const execPath = path.join(dir, "bin", "node")
    const jsPath = path.join(dir, "bin", "claxedo-mcp.js")

    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    fs.writeFileSync(execPath, "")
    fs.writeFileSync(jsPath, "")

    expect(resolveClaxedoMcpCommand({ execPath, devPath: path.join(dir, "missing.ts") })).toEqual([execPath, jsPath])
  })

  test("falls back to the shared Node + tsx dev launcher without Bun env shims", () => {
    const dir = temp()
    const execPath = path.join(dir, "bin", "node")
    const devPath = path.join(dir, "claxedo-mcp-dev.ts")
    const loader = path.resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs")

    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    fs.writeFileSync(execPath, "")
    fs.writeFileSync(devPath, "import './noop'\n")

    expect(resolveClaxedoMcpCommand({ execPath, devPath })).toEqual([execPath, "--import", loader, devPath])
    expect(getClaxedoMcpStdioConfig(4821, { execPath, devPath })).toEqual({
      command: execPath,
      args: ["--import", loader, devPath],
      env: {
        OPENCODE_API_URL: "http://localhost:4821",
      },
    })
  })

  test("throws when managed claxedo-mcp is enabled but no runnable command exists", () => {
    const dir = temp()
    const execPath = path.join(dir, "bin", "node")

    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    fs.writeFileSync(execPath, "")

    expect(() => requireClaxedoMcpStdioConfig(4821, "opencode", { execPath, devPath: path.join(dir, "missing.ts") })).toThrow(
      "Managed MCP server 'claxedo-mcp' is enabled for 'opencode'",
    )
  })
})
