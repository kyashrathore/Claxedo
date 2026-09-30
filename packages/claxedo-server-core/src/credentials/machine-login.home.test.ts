import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expect, test } from "vitest"

const PINNED_CODEX = path.resolve(import.meta.dirname, "../../../harness/node_modules/.bin/codex")

const run = promisify(execFile)

async function hashes(root: string): Promise<Record<string, string>> {
  const rows: Record<string, string> = {}
  for (const name of await fs.readdir(root, { recursive: true })) {
    const file = path.join(root, name)
    const stat = await fs.lstat(file)
    rows[name] = stat.isFile() ? createHash("sha256").update(await fs.readFile(file)).digest("hex") : stat.isSymbolicLink() ? `link:${await fs.readlink(file)}` : "dir"
  }
  return rows
}

test("reading the machine's Codex login leaves the person's ~/.codex byte-identical and runs Codex in a Claxedo-owned home", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-machine-login-"))
  try {
    const codex = path.join(home, ".codex")
    await fs.mkdir(codex)
    await fs.writeFile(path.join(codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-machine-login-fixture" }))
    await fs.writeFile(path.join(codex, "config.toml"), "check_for_update_on_startup = false\n")
    const before = await hashes(codex)
    const script = `import { readMachineLogins } from ${JSON.stringify(path.join(import.meta.dirname, "machine-login.ts"))}\n` +
      "console.log(JSON.stringify(await readMachineLogins([\"codex\"], { fresh: true })))\n"
    const env: Record<string, string> = { PATH: `${path.dirname(PINNED_CODEX)}${path.delimiter}${process.env.PATH ?? ""}`, HOME: home,
      CLAXEDO_DATA_DIR: path.join(home, ".claxedo"), HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" }
    const { stdout } = await run("bun", ["--eval", script], { cwd: import.meta.dirname, env, timeout: 60_000 })
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]")).toEqual([expect.objectContaining({ harness: "codex", state: "signed_in" })])
    expect(await hashes(codex)).toEqual(before)
    const accountHome = path.join(home, ".claxedo", "state", "codex-account-read")
    expect(await fs.readlink(path.join(accountHome, "auth.json"))).toBe(await fs.realpath(path.join(codex, "auth.json")))
    expect((await fs.readdir(accountHome)).length).toBeGreaterThan(2)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
}, 90_000)
