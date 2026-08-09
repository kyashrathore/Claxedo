import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadServerEnvForDevelopment, parseEnvFile, resolveDesktopServerDataDir } from "./server-env"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repo root with the server package's env files written into it. */
function repoWith(files: { env?: string; local?: string }) {
  const root = mkdtempSync(join(tmpdir(), "server-env-"))
  roots.push(root)
  const dir = join(root, "packages", "claxedo-server")
  mkdirSync(dir, { recursive: true })
  if (files.env !== undefined) writeFileSync(join(dir, ".env"), files.env)
  if (files.local !== undefined) writeFileSync(join(dir, ".env.local"), files.local)
  return root
}

describe("loading the server's env for development", () => {
  test("the keys that were silently missing now arrive", () => {
    // The reported failure: GITHUB_* absent until hand-exported, so the GitHub
    // sign-in looked broken rather than unconfigured.
    const env: NodeJS.ProcessEnv = {}
    const repoRoot = repoWith({
      env: "GITHUB_CLIENT_ID=abc\nGITHUB_CLIENT_SECRET=shh\nDAYTONA_API_KEY=dtn_1\n",
    })

    expect(loadServerEnvForDevelopment({ repoRoot, env })).toBe(3)
    expect(env.GITHUB_CLIENT_ID).toBe("abc")
    expect(env.DAYTONA_API_KEY).toBe("dtn_1")
  })

  test("an explicit export from the caller is never clobbered", () => {
    // `FOO=bar bun dev` is an intention, and the launch script sets the
    // throwaway profile's directories before this runs.
    const env: NodeJS.ProcessEnv = { DAYTONA_API_KEY: "from-the-shell" }
    const repoRoot = repoWith({ env: "DAYTONA_API_KEY=from-the-file\n" })

    loadServerEnvForDevelopment({ repoRoot, env })

    expect(env.DAYTONA_API_KEY).toBe("from-the-shell")
  })

  test(".env.local wins over .env, but neither wins over the caller", () => {
    const env: NodeJS.ProcessEnv = { PINNED: "shell" }
    const repoRoot = repoWith({
      env: "SHARED=from-env\nPINNED=from-env\nONLY_ENV=a\n",
      local: "SHARED=from-local\nPINNED=from-local\nONLY_LOCAL=b\n",
    })

    loadServerEnvForDevelopment({ repoRoot, env })

    expect(env.SHARED).toBe("from-local")
    expect(env.PINNED).toBe("shell")
    expect(env.ONLY_ENV).toBe("a")
    expect(env.ONLY_LOCAL).toBe("b")
  })

  test("a repo with no env files loads nothing and says nothing", () => {
    const messages: string[] = []
    const repoRoot = repoWith({})

    expect(loadServerEnvForDevelopment({ repoRoot, env: {}, log: (m) => messages.push(m) })).toBe(0)
    expect(messages).toEqual([])
  })

  test("two loads do not leak precedence into each other", () => {
    const repoRoot = repoWith({ env: "KEY=first\n" })
    const first: NodeJS.ProcessEnv = {}
    loadServerEnvForDevelopment({ repoRoot, env: first })

    const second: NodeJS.ProcessEnv = { KEY: "already" }
    loadServerEnvForDevelopment({ repoRoot, env: second })

    expect(second.KEY).toBe("already")
  })
})

describe("desktop server data directory", () => {
  test("isolates development and beta from the production profile", () => {
    expect(resolveDesktopServerDataDir({ channel: "dev", home: "/Users/test" })).toBe(
      join("/Users/test", ".claxedo-dev"),
    )
    expect(resolveDesktopServerDataDir({ channel: "beta", home: "/Users/test" })).toBe(
      join("/Users/test", ".claxedo-beta"),
    )
    expect(resolveDesktopServerDataDir({ channel: "prod", home: "/Users/test" })).toBe(join("/Users/test", ".claxedo"))
  })

  test("preserves an explicitly configured data directory", () => {
    expect(
      resolveDesktopServerDataDir({
        channel: "dev",
        home: "/Users/test",
        configured: "/tmp/claxedo-custom",
      }),
    ).toBe("/tmp/claxedo-custom")
  })

  test("treats a blank configured directory as unset", () => {
    expect(resolveDesktopServerDataDir({ channel: "dev", home: "/Users/test", configured: "" })).toBe(
      join("/Users/test", ".claxedo-dev"),
    )
    expect(resolveDesktopServerDataDir({ channel: "dev", home: "/Users/test", configured: "   " })).toBe(
      join("/Users/test", ".claxedo-dev"),
    )
  })
})

describe("parsing", () => {
  test("keeps values verbatim, including internal spaces and '='", () => {
    expect(parseEnvFile("A=a b c\nB=k=v=w\n")).toEqual([
      ["A", "a b c"],
      ["B", "k=v=w"],
    ])
  })

  test("strips one matched layer of quotes, and only a matched one", () => {
    expect(parseEnvFile(`A="quoted"\nB='single'\nC="unbalanced\n`)).toEqual([
      ["A", "quoted"],
      ["B", "single"],
      ["C", `"unbalanced`],
    ])
  })

  test("skips blanks, comments, and lines with no assignment", () => {
    expect(parseEnvFile("\n# a comment\nnot an assignment\nREAL=yes\n")).toEqual([["REAL", "yes"]])
  })

  test("tolerates `export KEY=` and space around the separator", () => {
    expect(parseEnvFile("export A=1\nB = 2\n")).toEqual([
      ["A", "1"],
      ["B", "2"],
    ])
  })

  test("rejects keys that are not shell-safe rather than exporting them", () => {
    expect(parseEnvFile("BAD-KEY=1\n9LEADING=2\nGOOD_KEY=3\n")).toEqual([["GOOD_KEY", "3"]])
  })

  test("an empty value is a value, not an omission", () => {
    expect(parseEnvFile("EMPTY=\n")).toEqual([["EMPTY", ""]])
  })
})
