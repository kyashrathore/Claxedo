import { describe, expect, test } from "bun:test"
import { normalize, resolveFileDiff, text } from "./session-diff"

describe("session diff", () => {
  test("renders whole-file unified patches as complete diffs", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.fileDiff.name).toBe("a.ts")
    expect(view.fileDiff.isPartial).toBe(false)
    expect(text(view, "deletions")).toBe("one\ntwo\n")
    expect(text(view, "additions")).toBe("one\nthree\n")
  })

  test("keeps missing final newlines from unified patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(text(view, "deletions")).toBe("one\ntwo")
    expect(text(view, "additions")).toBe("one\nthree")
  })

  test("renders whole-file VCS patches as complete diffs", () => {
    const fileDiff = resolveFileDiff({
      file: "a.ts",
      patch:
        "diff --git a/a.ts b/a.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n one\n-old\n+new\n",
    })

    expect(fileDiff.isPartial).toBe(false)
    expect(fileDiff.additionLines).toEqual(["one\n", "new\n"])
  })

  test("keeps ordinary leading tool patches partial", () => {
    const fileDiff = resolveFileDiff({
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\n+++ a.ts\n@@ -1,5 +1,5 @@\n-old\n+new\n two\n three\n four\n five\n",
    })

    expect(fileDiff.isPartial).toBe(true)
    expect(fileDiff.additionLines).toEqual(["new\n", "two\n", "three\n", "four\n", "five\n"])
  })

  test("keeps separated patch hunks partial without complete file contents", () => {
    const fileDiff = resolveFileDiff({
      file: "project.ts",
      patch:
        'Index: project.ts\n===================================================================\n--- project.ts\t\n+++ project.ts\t\n@@ -1,3 +1,2 @@\n import { and } from "drizzle-orm"\n-import { sql } from "drizzle-orm"\n import { ProjectTable } from "./project.sql"\n@@ -346,3 +345,3 @@\n import { Database } from "@/storage/db"\n-import { ProjectTable } from "./project.sql"\n+import { ProjectTable } from "../project/project.sql"\n import { SessionTable } from "../session/session.sql"\n',
    })

    expect(fileDiff.isPartial).toBe(true)
    expect(fileDiff.hunks).toHaveLength(2)
    expect(fileDiff.hunks[1]?.collapsedBefore).toBeGreaterThan(0)
  })

  test("renders headerless persisted patches", () => {
    const view = normalize({
      file: "a.ts",
      patch: "@@ -1 +1 @@\n-old\n+new\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    })

    expect(view.fileDiff.name).toBe("a.ts")
    expect(view.fileDiff.isPartial).toBe(true)
    expect(text(view, "deletions")).toBe("old\n")
    expect(text(view, "additions")).toBe("new\n")
  })

  test("does not share headerless patch metadata between files", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new\n"

    expect(resolveFileDiff({ file: "a.ts", patch }).name).toBe("a.ts")
    expect(resolveFileDiff({ file: "b.ts", patch }).name).toBe("b.ts")
  })

  test("keeps capped header-only patches partial", () => {
    const fileDiff = resolveFileDiff({
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n",
    })

    expect(fileDiff.name).toBe("a.ts")
    expect(fileDiff.isPartial).toBe(true)
    expect(fileDiff.hunks).toEqual([])
  })

  test("keeps full legacy content as a complete diff", () => {
    const diff = {
      file: "a.ts",
      before: "one\n",
      after: "two\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.fileDiff.isPartial).toBe(false)
    expect(text(view, "deletions")).toBe("one\n")
    expect(text(view, "additions")).toBe("two\n")
  })

  test("ignores malformed persisted patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "diff --git a/a.ts b/a.ts\nindex ff4ceb2..65a1de0 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n keep\n+add\n same\r",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(text(view, "deletions")).toBe("")
    expect(text(view, "additions")).toBe("")
  })

  describe("cacheKey", () => {
    // The key the highlight worker pool caches AST results under. It must
    // identify the diff's CONTENT: sharing a key across a change would serve a
    // stale highlight for lines that no longer exist.
    const patch = (body: string) =>
      `Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n${body}`

    test("stamps every resolved diff", () => {
      expect(resolveFileDiff({ file: "a.ts", patch: patch("@@ -1 +1 @@\n-old\n+new\n") }).cacheKey).toBeString()
      expect(resolveFileDiff({ file: "a.ts", before: "one\n", after: "two\n" }).cacheKey).toBeString()
    })

    test("reuses one key for identical content", () => {
      const body = "@@ -1 +1 @@\n-old\n+stable\n"
      const first = resolveFileDiff({ file: "stable.ts", patch: patch(body) })
      const second = resolveFileDiff({ file: "stable.ts", patch: patch(body) })

      expect(second).toBe(first)
      expect(second.cacheKey).toBe(first.cacheKey!)
    })

    test("mints a new key when the same file's content changes", () => {
      const first = resolveFileDiff({ file: "changed.ts", patch: patch("@@ -1 +1 @@\n-old\n+first\n") })
      const second = resolveFileDiff({ file: "changed.ts", patch: patch("@@ -1 +1 @@\n-old\n+second\n") })

      expect(second.cacheKey).not.toBe(first.cacheKey!)
      expect(first.additionLines).toEqual(["first\n"])
      expect(second.additionLines).toEqual(["second\n"])
    })

    test("mints a new key when the same content moves to another file", () => {
      const body = "@@ -1 +1 @@\n-old\n+moved\n"
      const first = resolveFileDiff({ file: "one.ts", patch: patch(body) })
      const second = resolveFileDiff({ file: "two.ts", patch: patch(body) })

      expect(second.cacheKey).not.toBe(first.cacheKey!)
    })

    test("mints a new key when legacy content changes on either side", () => {
      const base = resolveFileDiff({ file: "legacy.ts", before: "one\n", after: "two\n" })
      const changedAfter = resolveFileDiff({ file: "legacy.ts", before: "one\n", after: "three\n" })
      const changedBefore = resolveFileDiff({ file: "legacy.ts", before: "zero\n", after: "two\n" })

      expect(changedAfter.cacheKey).not.toBe(base.cacheKey!)
      expect(changedBefore.cacheKey).not.toBe(base.cacheKey!)
      expect(changedBefore.cacheKey).not.toBe(changedAfter.cacheKey!)
    })

    test("keeps sides distinct when a boundary moves between them", () => {
      // `before + after` concatenated would make these two indistinguishable.
      const first = resolveFileDiff({ file: "split.ts", before: "ab", after: "c" })
      const second = resolveFileDiff({ file: "split.ts", before: "a", after: "bc" })

      expect(second.cacheKey).not.toBe(first.cacheKey!)
    })

    test("does not reuse a key across a patch-shaped and content-shaped source", () => {
      const fromPatch = resolveFileDiff({ file: "shape.ts", patch: patch("@@ -1 +1 @@\n-one\n+two\n") })
      const fromContent = resolveFileDiff({ file: "shape.ts", before: "one\n", after: "two\n" })

      expect(fromContent.cacheKey).not.toBe(fromPatch.cacheKey!)
    })
  })
})
