import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createStatusHooksManifest, writeStatusHooksArtifacts } from "./setup"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "status-hooks-core-"))
  dirs.push(dir)
  return dir
}

describe("writeStatusHooksArtifacts", () => {
  it("writes generic hook artifacts and returns the manifest", async () => {
    const root = temp()
    const manifest = createStatusHooksManifest(root)

    const result = await writeStatusHooksArtifacts(manifest, {
      port: 4312,
      force: true,
      configureExternal: false,
    })

    expect(result).toEqual(manifest)
    expect(existsSync(manifest.files.notify)).toBe(true)
    expect(existsSync(manifest.files.geminiHook)).toBe(true)
    expect(existsSync(manifest.files.cursorHook)).toBe(true)
    expect(existsSync(manifest.files.copilotHook)).toBe(true)
    expect(existsSync(path.join(manifest.dirs.bin, "claude"))).toBe(true)
    expect(existsSync(path.join(manifest.dirs.bin, "codex"))).toBe(true)
    expect(existsSync(path.join(manifest.dirs.bin, "amp"))).toBe(true)
    expect(existsSync(path.join(manifest.dirs.bin, "copilot"))).toBe(true)
    expect(existsSync(path.join(manifest.dirs.shell, ".zshrc"))).toBe(true)
    expect(existsSync(path.join(manifest.dirs.bash, "rcfile"))).toBe(true)
    expect(readFileSync(manifest.files.notify, "utf-8")).toContain("4312")
    expect(readFileSync(path.join(manifest.dirs.bin, "amp"), "utf-8")).toContain('hook_event_name":"Busy"')
  })
})
