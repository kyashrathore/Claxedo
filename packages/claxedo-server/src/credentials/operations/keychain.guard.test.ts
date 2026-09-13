import { describe, expect, test } from "vitest"
import { readdirSync, readFileSync } from "fs"
import path from "path"

/**
 * Where a harness keeps its own login is that harness's business. Claxedo asks
 * the harness what it is signed in as and never opens the store behind it — not
 * the `Claude Code-credentials` Keychain item, which Claude Code rotates in
 * place and would be stranded by a write of ours, and not the token files
 * beside it.
 *
 * The behavioural pins live in machine-login.test.ts and sync.test.ts, through
 * their injected seams. This guard is the structural half: an edit that reached
 * for `security`, or ran a harness command other than the self-reports, would
 * slip past an injected spy but not past a read of the source.
 */
/**
 * Credential code lives in two places: the shared engine in
 * `@claxedo/server-core` and this product's own operations beside it. The
 * invariant is about the harnesses' own stores, not about a directory, so the
 * guard reads BOTH — a module that moved between packages must not escape it.
 */
const DIRS = [
  __dirname,
  path.resolve(__dirname, "../../../../claxedo-server-core/src/credentials"),
  path.resolve(__dirname, "../../../../claxedo-server-core/src/credentials/operations"),
]

/**
 * The self-reports, exactly. Each asks a harness about the login it already
 * holds: `claude auth status` and `cursor-agent status` print it, and the Codex
 * app-server answers `account/read` over its own protocol.
 */
const SELF_REPORTS = [
  ["claude", "auth", "status"],
  ["codex", "app-server", "--listen", "stdio://"],
  ["codex", "login", "status"],
  ["cursor-agent", "status", "--format", "json"],
]

const sources = DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
    .map((file) => path.join(dir, file)),
)

/**
 * The file with its comments removed. A guard that matched prose would pass or
 * fail on how a module describes itself rather than on what it does. The
 * leading character is required so a `//` inside a URL (`stdio://`) survives.
 */
function code(file: string) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[\s;{}()])\/\/[^\n]*/gm, "$1")
}

function named(file: string) {
  return path.basename(file)
}

describe("harness login access guard", () => {
  test("exactly one module reaches a command line", () => {
    const spawners = sources.filter((file) => /\b(execFileSync|execSync|execFile|spawnSync|spawn)\(/.test(code(file)))

    expect(spawners.map(named)).toEqual(["machine-login.ts"])
  })

  test("the commands that module runs are the harnesses' own self-reports", () => {
    const text = code(sources.find((file) => named(file) === "machine-login.ts") ?? "")
    const invocations = [...text.replace(/\s+/g, " ").matchAll(/(?:run|spawn)\( ?"([^"]+)", ?(\[[^\]]*\])/g)]
      .map((match) => [match[1], ...JSON.parse(match[2]) as string[]])

    expect(invocations.toSorted((a, b) => a.join(" ").localeCompare(b.join(" ")))).toEqual(SELF_REPORTS)
  })

  test("no credentials module opens the store a harness keeps its login in", () => {
    for (const file of sources) {
      expect(code(file), named(file)).not.toContain("generic-password")
      expect(code(file), named(file)).not.toContain(".credentials.json")
    }
  })

  test("the one module that names a harness's token file only writes back to it", () => {
    const naming = sources.filter((file) => code(file).includes("auth.json"))

    // Codex rotates the refresh token on renewal, so a row imported before
    // Claxedo stopped importing logins would leave the user's own CLI holding a
    // superseded pair. Nothing here reads that file to make a credential.
    expect(naming.map(named)).toEqual(["codex-auth-file.ts"])
    expect(code(naming[0])).toContain("shouldMirrorCodexTokens")
  })
})
