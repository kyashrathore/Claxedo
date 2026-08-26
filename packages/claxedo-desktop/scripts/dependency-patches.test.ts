import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { runGitApply } from "../../../script/apply-dependency-patches"

const root = path.resolve(import.meta.dirname, "../../..")
const temporary: string[] = []
const patch = `diff --git a/value.txt b/value.txt
index 5626abf..f719efd 100644
--- a/value.txt
+++ b/value.txt
@@ -1 +1 @@
-before
+after
`

function fixture(parent: string) {
  const directory = mkdtempSync(path.join(parent, "dependency-patch-"))
  temporary.push(directory)
  const patchFile = path.join(directory, "change.patch")
  writeFileSync(path.join(directory, "value.txt"), "before\n")
  writeFileSync(patchFile, patch)
  return { directory, patchFile }
}

async function provePackageRelativeApplication(directory: string, patchFile: string) {
  expect((await runGitApply(directory, patchFile, ["--check"])).exitCode).toBe(0)
  expect((await runGitApply(directory, patchFile, [])).exitCode).toBe(0)
  expect(readFileSync(path.join(directory, "value.txt"), "utf8")).toBe("after\n")
  expect((await runGitApply(directory, patchFile, ["--reverse", "--check"])).exitCode).toBe(0)
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("dependency patch application", () => {
  test("targets package bytes instead of silently anchoring at the enclosing worktree", async () => {
    const { directory, patchFile } = fixture(root)
    await provePackageRelativeApplication(directory, patchFile)
  })

  test("does not consult an incomplete synthetic Git object database", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "dependency-patch-synthetic-repo-"))
    temporary.push(parent)
    mkdirSync(path.join(parent, ".git", "objects"), { recursive: true })
    writeFileSync(path.join(parent, ".git", "HEAD"), "ref: refs/heads/main\n")
    const { directory, patchFile } = fixture(parent)
    await provePackageRelativeApplication(directory, patchFile)
  })
})
