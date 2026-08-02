import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureWorkGraphRepository } from "./workgraph-repository"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "workgraph-repo-"))
  roots.push(root)
  return root
}

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()

/** The two calls `readRepository` makes on every New Stream dialog. */
function readRepository(directory: string) {
  return {
    head: git(directory, "rev-parse", "--verify", "HEAD^{commit}"),
    refs: git(directory, "for-each-ref", "--format=%(refname:short)", "refs/heads"),
  }
}

describe("the WorkGraph repository desktop boots with", () => {
  test("a fresh profile's directory can answer the New Stream dialog", () => {
    // The reported failure: a bare directory made `rev-parse HEAD` fail with
    // "not a git repository" the first time the dialog opened.
    const directory = join(scratch(), "workgraph")

    ensureWorkGraphRepository(directory)

    expect(() => readRepository(directory)).not.toThrow()
    expect(readRepository(directory).head).toMatch(/^[0-9a-f]{40}$/)
  })

  test("an initialised but commitless repository is still finished off", () => {
    // `git init` alone is not enough — HEAD^{commit} has nothing to resolve.
    const directory = join(scratch(), "workgraph")
    execFileSync("git", ["init", "-q", directory])
    expect(() => readRepository(directory)).toThrow()

    ensureWorkGraphRepository(directory)

    expect(() => readRepository(directory)).not.toThrow()
  })

  test("committing needs no git identity configured on the machine", () => {
    // A machine with no user.email cannot commit at all, and this bookkeeping
    // repository must not depend on the user having set one up.
    const directory = join(scratch(), "workgraph")

    ensureWorkGraphRepository(directory)

    expect(git(directory, "config", "user.email")).toBe("desktop@claxedo.local")
  })

  test("running it again changes nothing", () => {
    const directory = join(scratch(), "workgraph")
    ensureWorkGraphRepository(directory)
    const first = readRepository(directory)

    ensureWorkGraphRepository(directory)
    ensureWorkGraphRepository(directory)

    expect(readRepository(directory)).toEqual(first)
  })

  test("an existing repository keeps its history and its identity", () => {
    const directory = join(scratch(), "workgraph")
    execFileSync("git", ["init", "-q", directory])
    git(directory, "config", "user.email", "someone@example.com")
    git(directory, "config", "user.name", "Someone")
    writeFileSync(join(directory, "note.md"), "kept")
    git(directory, "add", "note.md")
    git(directory, "commit", "-qm", "existing work")
    const before = git(directory, "rev-parse", "HEAD")

    ensureWorkGraphRepository(directory)

    expect(git(directory, "rev-parse", "HEAD")).toBe(before)
    expect(git(directory, "config", "user.email")).toBe("someone@example.com")
  })

  test("a directory nested inside another repository gets its own", () => {
    // `rev-parse --git-dir` succeeds from any subdirectory by walking upward,
    // so probing with it would leave this uninitialised — and WorkGraph's
    // commits would land in the enclosing repository instead.
    const outer = scratch()
    execFileSync("git", ["init", "-q", outer])
    git(outer, "config", "user.email", "someone@example.com")
    git(outer, "config", "user.name", "Someone")
    git(outer, "commit", "-q", "--allow-empty", "-m", "outer")
    const outerHead = git(outer, "rev-parse", "HEAD")
    const directory = join(outer, "userData", "workgraph")

    ensureWorkGraphRepository(directory)

    expect(git(directory, "rev-parse", "--show-toplevel")).not.toBe(outer)
    expect(git(outer, "rev-parse", "HEAD")).toBe(outerHead)
  })

  test("a git that cannot run surfaces as a throw the caller can warn on", () => {
    const directory = join(scratch(), "workgraph")

    expect(() =>
      ensureWorkGraphRepository(directory, () => {
        throw new Error("git not found")
      })
    ).toThrow()
  })
})
