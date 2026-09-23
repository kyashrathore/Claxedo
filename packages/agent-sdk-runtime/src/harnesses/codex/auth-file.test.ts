import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isOwnerOnlyFile } from "@claxedo/helpers/fs"
import { readCodexAuthFile, writeCodexAuthFile } from "./auth-file"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-file-"))
  roots.push(root)
  return root
}

describe("Codex auth file", () => {
  test("writes auth.json owner-only and readable back", async () => {
    const home = temporaryRoot()
    await writeCodexAuthFile(home, { type: "codex_auth", access: "token-1" })
    const file = path.join(home, "auth.json")
    expect(await isOwnerOnlyFile(file)).toBe(true)
    expect(readCodexAuthFile(home)).toMatchObject({ access: "token-1" })
  })

  test.skipIf(process.platform === "win32")("repairs the mode on a pre-existing permissive auth file", async () => {
    const home = temporaryRoot()
    const file = path.join(home, "auth.json")
    fs.writeFileSync(file, "{}\n")
    fs.chmodSync(file, 0o644)
    await writeCodexAuthFile(home, { type: "codex_auth", access: "token-2" })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(readCodexAuthFile(home)).toMatchObject({ access: "token-2" })
  })

  test.skipIf(process.platform === "win32")("narrows a permissive home directory", async () => {
    const home = temporaryRoot()
    fs.chmodSync(home, 0o755)
    await writeCodexAuthFile(home, { type: "codex_auth" })
    expect(fs.statSync(home).mode & 0o777).toBe(0o700)
  })

  test.skipIf(process.platform === "win32")("refuses a symlinked home instead of writing through it", async () => {
    const outside = temporaryRoot()
    const root = temporaryRoot()
    const home = path.join(root, "linked-home")
    fs.symlinkSync(outside, home)
    await expect(writeCodexAuthFile(home, { type: "codex_auth" })).rejects.toThrow()
    expect(fs.existsSync(path.join(outside, "auth.json"))).toBe(false)
  })

  test.skipIf(process.platform === "win32")("replaces a symlink at auth.json instead of writing through it", async () => {
    const home = temporaryRoot()
    const elsewhere = path.join(home, "elsewhere.json")
    fs.writeFileSync(elsewhere, "untouched\n")
    fs.symlinkSync(elsewhere, path.join(home, "auth.json"))
    await writeCodexAuthFile(home, { type: "codex_auth", access: "token-3" })
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("untouched\n")
    const file = path.join(home, "auth.json")
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
    expect(readCodexAuthFile(home)).toMatchObject({ access: "token-3" })
  })

  test("answers undefined for a missing auth file", () => {
    const home = temporaryRoot()
    expect(readCodexAuthFile(home)).toBeUndefined()
  })
})
