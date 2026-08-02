import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createStatusHooksManifest, writeStatusHooksArtifacts } from "./setup"

const dirs: string[] = []
const originalCodexNativeHooks = process.env.CLAXEDO_CODEX_NATIVE_HOOKS

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (originalCodexNativeHooks === undefined) delete process.env.CLAXEDO_CODEX_NATIVE_HOOKS
  else process.env.CLAXEDO_CODEX_NATIVE_HOOKS = originalCodexNativeHooks
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

  it("ignores ambient native Codex hook env unless the option is set", async () => {
    const root = temp()
    const manifest = createStatusHooksManifest(root)
    process.env.CLAXEDO_CODEX_NATIVE_HOOKS = "1"

    await writeStatusHooksArtifacts(manifest, {
      port: 4312,
      force: true,
    })

    expect(existsSync(manifest.files.codexNotify)).toBe(true)
    expect(existsSync(manifest.files.codexWatcher)).toBe(true)
    expect(readFileSync(path.join(manifest.dirs.bin, "codex"), "utf-8")).toContain(manifest.files.codexNotify)
  })

  it("uses native Codex hook artifacts when explicitly requested", async () => {
    const root = temp()
    const manifest = createStatusHooksManifest(root)

    await writeStatusHooksArtifacts(manifest, {
      port: 4312,
      force: true,
      codexNativeHooks: true,
    })

    expect(existsSync(manifest.files.codexNotify)).toBe(false)
    expect(existsSync(manifest.files.codexWatcher)).toBe(false)
    expect(readFileSync(path.join(manifest.dirs.bin, "codex"), "utf-8")).toContain(manifest.files.notify)
  })
})
