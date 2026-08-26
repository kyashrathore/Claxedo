import { describe, expect, test } from "bun:test"
import { patchFiles } from "./apply-patch-file"
import { clearDiffCache, inspectDiffCache, text } from "./session-diff"

describe("apply patch file", () => {
  test("parses patch metadata from the server", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.fileDiff.name).toBe("a.ts")
    expect(file?.view.fileDiff.isPartial).toBe(false)
    expect(text(file!.view, "deletions")).toBe("one\ntwo\n")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("keeps legacy before and after payloads working", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        before: "one\n",
        after: "two\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })
  test("defers patch parsing until disclosure and releases the resolved view on close", () => {
    clearDiffCache()
    const file = patchFiles([
      {
        filePath: "/tmp/lazy.ts",
        relativePath: "lazy.ts",
        type: "update",
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]!

    expect(inspectDiffCache().entries).toBe(0)
    const opened = file.resolve()
    expect(inspectDiffCache().entries).toBe(1)
    expect(file.resolve()).toBe(opened)
    file.release()
    expect(file.resolve()).not.toBe(opened)
  })

})
