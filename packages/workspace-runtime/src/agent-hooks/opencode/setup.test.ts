import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { OPENCODE_DOC_AGENT_FILE } from "@claxedo/agent-extensions"
import { createStatusHooksManifest } from "../core/setup"
import { OPENCODE_PLUGIN } from "./constants"
import { opencodePaths, setupOpencodeIntegration } from "./setup"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "status-hooks-opencode-"))
  dirs.push(dir)
  return dir
}

describe("setupOpencodeIntegration", () => {
  it("consumes the manifest and writes OpenCode-specific artifacts", async () => {
    const root = temp()
    const manifest = createStatusHooksManifest(root)
    const dir = opencodePaths(root)

    await setupOpencodeIntegration({
      manifest,
      force: true,
    })

    expect(existsSync(path.join(manifest.dirs.bin, "opencode"))).toBe(true)
    expect(existsSync(path.join(dir.plugin, OPENCODE_PLUGIN))).toBe(true)
    expect(existsSync(path.join(dir.agent, OPENCODE_DOC_AGENT_FILE))).toBe(true)
    expect(readFileSync(path.join(manifest.dirs.bin, "opencode"), "utf-8")).toContain(dir.config)
    expect(readFileSync(path.join(dir.plugin, OPENCODE_PLUGIN), "utf-8")).toContain(manifest.files.notify)
  })
})
