import { describe, expect, test } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
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
 * Every tree that has ever held credential code, walked whole. Naming
 * directories one level deep is how the guard came to read three of the ten
 * that existed — the invariant is about the harnesses' own stores, so the scan
 * follows the trees rather than a hand-kept list of folders, and a module that
 * moves between packages or down a level cannot escape it.
 *
 * `packages/cli` is here as a whole because the CLI is a credential-bearing
 * surface with no `credentials` directory of its own: `claxedo creds sync` read
 * `~/.codex/auth.json` and PUT it into a remote registry, and this is what stops
 * that coming back under another name.
 */
const PACKAGES = path.resolve(__dirname, "../../../..")
/**
 * The local server's usage tree is in here because its machine-wide plan probe
 * is the one module that reaches the harnesses' own stores from outside a
 * `credentials` directory: it hands `tokentracker-cli` the home directory, and
 * that library reads the Keychain and `~/.codex/auth.json` on this process's
 * behalf.
 */
const CREDENTIAL_ROOTS = [
  ...["claxedo-server", "claxedo-server-core", "claxedo-local-server"]
    .map((pkg) => path.join(PACKAGES, pkg, "src", "credentials")),
  path.join(PACKAGES, "claxedo-local-server", "src", "usage"),
]
const CLI_ROOT = path.join(PACKAGES, "cli", "src")
/** The library that reads the harnesses' stores for the plan probe. */
const STORE_READING_LIBRARY = "tokentracker-cli/src/lib/usage-limits"

/**
 * The self-reports, exactly. Each asks a harness about the login it already
 * holds: `claude auth status` and `cursor-agent status` print it, and the Codex
 * app-server answers `account/read` over its own protocol.
 */
/**
 * The quoted path segment, so `document.claudeAiOauth` — a field of a secret WE
 * hold — does not read as a path into the user's Claude Code directory.
 */
const CLAUDE_DIRECTORY_LITERAL = '".claude"'

const SELF_REPORTS = [
  ["claude", "auth", "status"],
  ["codex", "app-server", "--listen", "stdio://"],
  ["codex", "login", "status"],
  ["cursor-agent", "status", "--format", "json"],
]

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [full] : []
  })
}

const sources = CREDENTIAL_ROOTS.flatMap(walk)
const cliSources = walk(CLI_ROOT)

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
  return path.relative(PACKAGES, file)
}

describe("harness login access guard", () => {
  test("the scan reaches every credential tree, and reaches below their top level", () => {
    // A regex that matches nothing passes, so the guard's own reach — the thing
    // most likely to rot — is asserted rather than assumed.
    expect(sources.length).toBeGreaterThan(30)
    expect(cliSources.length).toBeGreaterThan(0)
    for (const root of [...CREDENTIAL_ROOTS, CLI_ROOT]) {
      const found = walk(root)
      expect(found.length, root).toBeGreaterThan(0)
      expect(found.some((file) => path.relative(root, file).includes(path.sep)), root).toBe(true)
    }
  })

  test("exactly one module can reach a command line", () => {
    // The import, not the call: `const exec = promisify(execFile)` spawns
    // through a name this scan has never heard of, and a module that holds a
    // spawner is already past the line whether or not it has called one yet.
    const spawners = sources.filter((file) =>
      /from "(node:)?child_process"/.test(code(file))
      || /\b(execFileSync|execSync|execFile|spawnSync|spawn)\(/.test(code(file)))

    expect(spawners.map((file) => path.basename(file))).toEqual(["machine-login.ts"])
  })

  test("the commands that module runs are the harnesses' own self-reports", async () => {
    // The value the module runs from, not a regex over its source: an argv
    // assembled from a variable reads as no invocation at all to a scan.
    const { MACHINE_LOGIN_COMMANDS } = await import("@claxedo/server-core/credentials/machine-login")

    expect(Object.values(MACHINE_LOGIN_COMMANDS).map((command) => [...command])
      .toSorted((a, b) => a.join(" ").localeCompare(b.join(" ")))).toEqual(SELF_REPORTS)
  })

  test("exactly one module hands the harnesses' stores to the plan-reading library", () => {
    const readers = sources.filter((file) => code(file).includes(STORE_READING_LIBRARY))

    expect(readers.map((file) => path.basename(file))).toEqual(["token-tracker-usage-limits.ts"])
  })

  test("no credentials module opens the store a harness keeps its login in", () => {
    for (const file of [...sources, ...cliSources]) {
      expect(code(file), named(file)).not.toContain("generic-password")
      expect(code(file), named(file)).not.toContain(".credentials.json")
      expect(code(file), named(file)).not.toContain(CLAUDE_DIRECTORY_LITERAL)
    }
  })

  test("the one module that names a harness's token file writes to it and hands back nothing it read", async () => {
    const naming = sources.filter((file) => code(file).includes("auth.json"))

    // Codex rotates the refresh token on renewal, so a row imported before
    // Claxedo stopped importing logins would leave the user's own CLI holding a
    // superseded pair.
    expect(naming.map((file) => path.basename(file))).toEqual(["codex-auth-file.ts"])

    const mirror = await import("@claxedo/server-core/credentials/operations/codex-auth-file")
    const home = mkdtempSync(path.join(tmpdir(), "codex-mirror-guard-"))
    try {
      mkdirSync(path.join(home, ".codex", "accounts"), { recursive: true })
      const onDisk = JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "ON-DISK-ACCESS", refresh_token: "ON-DISK-REFRESH", account_id: "acct-1" },
        last_refresh: "2026-04-01T00:00:00.000Z",
      })
      writeFileSync(path.join(home, ".codex", "auth.json"), onDisk)
      writeFileSync(path.join(home, ".codex", "accounts", "someone@example.com.auth.json"), onDisk)

      // Every export, handed a home that holds a real Codex login: none of them
      // gives the caller any of it back. That is what makes the file this module
      // names a destination rather than a source.
      const answers = [
        mirror.codexAuthFileCandidates(home),
        mirror.mirrorCodexTokens({ accountId: "acct-1", access: "OURS", refresh: "OURS-REFRESH" }, home),
        mirror.renewedCodexTokens(JSON.stringify({ access: "OURS", refresh: "OURS-REFRESH" }), "acct-1"),
        mirror.shouldMirrorCodexTokens({ provider_id: "codex-app-server", kind: "oauth_token", source: "local_only" }),
      ]
      expect(JSON.stringify(answers)).not.toContain("ON-DISK")
      // …and it did write, so the assertion above is not passing on inaction.
      expect(readFileSync(path.join(home, ".codex", "auth.json"), "utf8")).toContain("OURS-REFRESH")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("the CLI has no command that pushes a harness login anywhere", () => {
    for (const file of cliSources) {
      expect(code(file), named(file)).not.toContain(".codex")
      expect(code(file), named(file)).not.toContain("codex-app-server")
    }
  })
})
