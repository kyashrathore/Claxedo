import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { getClaxedoMcpStdioConfig, resolveClaxedoMcpCommand } from "./agent-hooks"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-agent-hooks-"))
  dirs.push(dir)
  return dir
}

describe("agent-hooks claxedo-mcp resolution", () => {
  test("prefers a Node-run bundle next to the runtime executable", () => {
    const dir = temp()
    const execPath = path.join(dir, "bin", "node")
    const jsPath = path.join(dir, "bin", "claxedo-mcp.js")

    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    fs.writeFileSync(execPath, "")
    fs.writeFileSync(jsPath, "")

    expect(resolveClaxedoMcpCommand({ execPath, devPath: path.join(dir, "missing.ts") })).toEqual([execPath, jsPath])
  })

  test("uses the explicit Node + tsx dev entrypoint when no artifact exists", () => {
    const dir = temp()
    const execPath = path.join(dir, "bin", "node")
    const devPath = path.join(dir, "claxedo-mcp-dev.ts")
    const loader = path.resolve(import.meta.dirname, "../../workspace-runtime/node_modules/tsx/dist/loader.mjs")

    fs.mkdirSync(path.dirname(execPath), { recursive: true })
    fs.writeFileSync(execPath, "")
    fs.writeFileSync(devPath, "import './noop'\n")

    expect(resolveClaxedoMcpCommand({ execPath, devPath })).toEqual([execPath, "--import", loader, devPath])
    expect(getClaxedoMcpStdioConfig(4310, { execPath, devPath })).toEqual({
      command: execPath,
      args: ["--import", loader, devPath],
      env: {
        OPENCODE_API_URL: "http://localhost:4310",
      },
    })
  })
})
