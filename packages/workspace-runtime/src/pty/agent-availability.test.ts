import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BIN_DIR } from "../agent-hooks"
import { installedAgents } from "./agent-availability"

const roots: string[] = []

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-availability-"))
  roots.push(dir)
  return dir
}

async function executable(dir: string, name: string) {
  const file = path.join(dir, name)
  await fs.writeFile(file, "#!/bin/sh\n", { mode: 0o755 })
  return file
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("installedAgents", () => {
  test("reports only the names that resolve to an executable file on PATH", async () => {
    const dir = await tempDir()
    await executable(dir, "claude")
    await fs.mkdir(path.join(dir, "codex"))

    expect(await installedAgents(["claude", "codex", "gemini"], { PATH: dir })).toEqual(["claude"])
  })

  /**
   * Named so it cannot collide with a shim the runtime materializes: this
   * writes into the real BIN_DIR, and deleting a name the runtime owns would
   * break the machine's hooks until the next setup run.
   */
  test("ignores the wrapper directory, which holds a shim per agent either way", async () => {
    const real = await tempDir()
    await executable(real, "codex")
    await fs.mkdir(BIN_DIR, { recursive: true })
    const probe = "zzz-availability-probe"
    const shim = await executable(BIN_DIR, probe)

    try {
      expect(await installedAgents(["codex", probe], { PATH: `${BIN_DIR}${path.delimiter}${real}` }))
        .toEqual(["codex"])
    } finally {
      await fs.rm(shim, { force: true })
    }
  })

  test("a non-executable file is not an installed agent", async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, "droid"), "", { mode: 0o644 })

    expect(await installedAgents(["droid"], { PATH: dir })).toEqual([])
  })

  test("an empty PATH finds nothing rather than falling back to the process PATH", async () => {
    expect(await installedAgents(["claude"], { PATH: "" })).toEqual([])
  })
})
