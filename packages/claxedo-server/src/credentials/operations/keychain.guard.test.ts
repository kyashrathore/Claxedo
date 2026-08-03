import { describe, expect, test } from "vitest"
import { readdirSync, readFileSync } from "fs"
import path from "path"

/**
 * The `Claude Code-credentials` Keychain item belongs to Claude Code, which
 * rotates its access token in place and issues single-use refresh tokens. A
 * write from Claxedo would either be clobbered or would strand the user's own
 * Claude Code holding a credential Anthropic has already invalidated.
 *
 * The behavioural pins live in sync.test.ts and go through the injected exec
 * seam. This guard is the structural half: a future edit that reaches for
 * `execFileSync` directly, or asks `security` for anything other than a read,
 * would slip past an injected spy but not past a read of the source.
 */
const dir = __dirname
const sources = readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.includes(".test."))

function source(file: string) {
  return readFileSync(path.join(dir, file), "utf8")
}

describe("Keychain access guard", () => {
  test("exactly one module reaches a command line, through exactly one call site", () => {
    const spawners = sources.filter((file) => /\b(execFileSync|execSync|execFile|spawnSync|spawn)\(/.test(source(file)))

    expect(spawners).toEqual(["sync.ts"])
    expect(source("sync.ts").match(/\bexecFileSync\(/g)).toHaveLength(1)
  })

  test("no credentials module can write to or delete the Keychain item", () => {
    for (const file of sources) {
      const text = source(file)
      expect(text).not.toContain("add-generic-password")
      expect(text).not.toContain("delete-generic-password")
      expect(text).not.toContain("set-generic-password")
    }
  })

  test("the only security subcommand named anywhere is the read", () => {
    const subcommands = sources.flatMap((file) => [...source(file).matchAll(/"([a-z]+-generic-password)"/g)]
      .map((match) => match[1]))

    expect([...new Set(subcommands)]).toEqual(["find-generic-password"])
  })
})
