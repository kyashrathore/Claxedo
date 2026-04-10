import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { DOC_AGENT_MD, OPENCODE_JSONC, OPENCODE_PLUGIN } from "../../constants"
import { createStatusHooksManifest } from "../../core/setup"
import { opencodePaths } from "./config"
import { setupOpencodeIntegration } from "./setup"

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
      mcp: {
        demo: {
          name: "demo",
          source: "user",
          transport: "stdio",
          command: "demo",
          args: ["serve"],
          env: { A: "1" },
        },
      },
    })

    expect(existsSync(path.join(manifest.dirs.bin, "opencode"))).toBe(true)
    expect(existsSync(path.join(dir.plugin, OPENCODE_PLUGIN))).toBe(true)
    expect(existsSync(path.join(dir.agent, DOC_AGENT_MD))).toBe(true)
    expect(existsSync(path.join(dir.config, OPENCODE_JSONC))).toBe(true)
    expect(readFileSync(path.join(manifest.dirs.bin, "opencode"), "utf-8")).toContain(dir.config)
    expect(readFileSync(path.join(dir.plugin, OPENCODE_PLUGIN), "utf-8")).toContain(manifest.files.notify)
    expect(readFileSync(path.join(dir.config, OPENCODE_JSONC), "utf-8")).toContain('"demo"')
  })
})
