import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { expect, test } from "vitest"

for (const mode of ["homes", "opencode", "selected", "empty"]) {
  test(`activation reaches session launch without personal home writes: ${mode}`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-homes-child-"))
    try {
      await fs.mkdir(path.join(home, ".codex"))
      await fs.writeFile(path.join(home, ".codex/config.toml"), "caller-owned sentinel\n")
      const { stdout } = await promisify(execFile)("bun", [path.join(import.meta.dirname, "../test-support/activation-launch.mjs"), mode], {
        env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") },
      })
      expect(stdout.trim()).toBe(`${mode}: passed`)
      expect(await fs.readFile(path.join(home, ".codex/config.toml"), "utf8")).toBe("caller-owned sentinel\n")
      expect(await fs.readdir(home)).toEqual([".codex"])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
}
