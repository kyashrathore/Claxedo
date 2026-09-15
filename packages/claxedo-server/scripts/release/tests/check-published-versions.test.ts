import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { directoryChangedSince, publishedVersionDrift, versionSetCommit } from "../check-published-versions"

function run(cmd: string, args: string[], cwd?: string) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function git(root: string, ...args: string[]) {
  return run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], root)
}

/** A real repo: one package, version set in the first commit, source changed in the second. */
function repoWithDrift() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-version-drift-"))
  const dir = path.join(root, "packages/thing")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@claxedo/thing", version: "1.2.3" }, null, 2))
  git(root, "init", "-q")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "set 1.2.3")
  const setCommit = git(root, "rev-parse", "HEAD")
  fs.writeFileSync(path.join(dir, "index.ts"), "export const changed = true\n")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "change without bump")
  return { root, setCommit }
}

const thing = [{ name: "@claxedo/thing", dir: "packages/thing" }]

describe("check-published-versions", () => {
  test("finds the commit that set the current version and sees the change after it", () => {
    const { root, setCommit } = repoWithDrift()
    expect(versionSetCommit(root, "packages/thing", "1.2.3", run)).toBe(setCommit)
    expect(directoryChangedSince(root, "packages/thing", setCommit, run)).toBe(true)
  })

  test("a changed directory under a version that is already on npm is a violation", () => {
    const { root, setCommit } = repoWithDrift()
    const drift = publishedVersionDrift(root, thing, (cmd, args, cwd) => {
      if (cmd === "npm") return "1.2.3"
      return run(cmd, args, cwd)
    })
    expect(drift).toEqual([
      `@claxedo/thing@1.2.3 is already on npm but packages/thing changed after ${setCommit.slice(0, 10)} set that version`,
    ])
  })

  test("a published version whose tarball equals the tree's is not drift; a differing one still is", () => {
    const { root, setCommit } = repoWithDrift()
    const npmSaysPublished = (cmd: string, args: string[], cwd?: string) => {
      if (cmd === "npm") return "1.2.3"
      return run(cmd, args, cwd)
    }
    expect(publishedVersionDrift(root, thing, npmSaysPublished, () => true)).toEqual([])
    expect(publishedVersionDrift(root, thing, npmSaysPublished, () => false)).toEqual([
      `@claxedo/thing@1.2.3 is already on npm but packages/thing changed after ${setCommit.slice(0, 10)} set that version`,
    ])
  })

  test("an unpublished version may keep changing", () => {
    const { root } = repoWithDrift()
    expect(publishedVersionDrift(root, thing, (cmd, args, cwd) => {
      if (cmd === "npm") throw new Error("E404")
      return run(cmd, args, cwd)
    })).toEqual([])
  })

  test("a bump after the change clears the violation without consulting npm", () => {
    const { root } = repoWithDrift()
    const manifest = path.join(root, "packages/thing/package.json")
    fs.writeFileSync(manifest, JSON.stringify({ name: "@claxedo/thing", version: "1.3.0" }, null, 2))
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "bump")
    expect(publishedVersionDrift(root, thing, (cmd, args, cwd) => {
      if (cmd === "npm") throw new Error("npm must not be consulted for an unchanged directory")
      return run(cmd, args, cwd)
    })).toEqual([])
  })

  test("an uncommitted bump covers every change in the directory and consults nothing", () => {
    const { root } = repoWithDrift()
    fs.writeFileSync(path.join(root, "packages/thing/package.json"), JSON.stringify({ name: "@claxedo/thing", version: "1.3.0" }, null, 2))
    expect(publishedVersionDrift(root, thing, (cmd, args, cwd) => {
      if (cmd === "npm") throw new Error("npm must not be consulted for an uncommitted bump")
      return run(cmd, args, cwd)
    })).toEqual([])
  })

  test("uncommitted edits count as changes", () => {
    const { root } = repoWithDrift()
    git(root, "reset", "-q", "--hard", "HEAD~1")
    fs.writeFileSync(path.join(root, "packages/thing/index.ts"), "export const dirty = true\n")
    const drift = publishedVersionDrift(root, thing, (cmd, args, cwd) => {
      if (cmd === "npm") return "1.2.3"
      return run(cmd, args, cwd)
    })
    expect(drift).toHaveLength(1)
  })
})
