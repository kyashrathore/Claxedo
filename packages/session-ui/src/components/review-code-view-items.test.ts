import { describe, expect, test } from "bun:test"
import { createReviewCodeViewItems } from "./review-code-view-items"
import { resolveFileDiff } from "./session-diff"
import type { CodeViewItem } from "@pierre/diffs"

function diffItem(item: CodeViewItem<undefined>) {
  if (item.type !== "diff") throw new Error("Expected a loaded diff")
  return item
}

const corpus = () => Array.from({ length: 500 }, (_, index) => ({
  file: `file-${index}.ts`, before: `old ${index}\n`, after: `new ${index}\n`,
}))

describe("CodeView document content identity", () => {
  test("caller-guarded content stays custom through expansion until explicitly released", () => {
    const reconcile = createReviewCodeViewItems()
    const guarded = new Set(["large.ts"])
    const diffs = [{ file: "large.ts", before: "old\n", after: "new\n" }]
    const closed = reconcile({ diffs, open: new Set(), customFiles: guarded })[0]
    expect(closed.type).toBe("custom")
    expect("fileDiff" in closed).toBe(false)
    const expanded = reconcile({ diffs, open: guarded, customFiles: guarded })[0]
    expect(expanded.type).toBe("custom")
    expect(expanded.collapsed).toBe(false)
    const forced = diffItem(reconcile({ diffs, open: guarded, customFiles: new Set() })[0])
    expect(forced.id).toBe(expanded.id)
    expect(forced.fileDiff.additionLines).toEqual(["new\n"])
    expect(reconcile({ diffs, open: guarded, customFiles: new Set() })[0]).toBe(forced)
  })

  test("expand all and reverse traversal retain parsed data beyond the shared LRU", () => {
    const diffs = corpus()
    const reconcile = createReviewCodeViewItems()
    const closed = reconcile({ diffs, open: new Set() })
    const expanded = reconcile({ diffs, open: new Set(diffs.map((diff) => diff.file)) })
    for (let index = 0; index < diffs.length; index++) {
      expect(diffItem(expanded[index]).fileDiff).toBe(diffItem(closed[index]).fileDiff)
      expect(expanded[index].collapsed).toBe(false)
      expect(expanded[index].version).toBe(closed[index].version! + 1)
    }
    const reversed = reconcile({ diffs: [...diffs].reverse(), open: new Set() })
    expect(diffItem(reversed.at(-1)!).fileDiff).toBe(diffItem(closed[0]).fileDiff)
  })

  test("one file content update leaves every other controlled item unchanged", () => {
    const diffs = corpus()
    const reconcile = createReviewCodeViewItems()
    const first = reconcile({ diffs, open: new Set() })
    diffs[20].after = "changed again\n"
    const next = reconcile({ diffs, open: new Set() })
    expect(diffItem(next[20]).fileDiff).not.toBe(diffItem(first[20]).fileDiff)
    expect(diffItem(next[20]).fileDiff.additionLines).toEqual(["changed again\n"])
    for (let index = 0; index < diffs.length; index++) {
      if (index !== 20) expect(next[index]).toBe(first[index])
    }
  })

  test("removed corpus entries are released", () => {
    const diffs = corpus()
    const reconcile = createReviewCodeViewItems()
    const first = reconcile({ diffs, open: new Set() })
    reconcile({ diffs: [], open: new Set() })
    // The shared LRU no longer holds the first file either.
    const reparsed = resolveFileDiff(diffs[0])
    expect(reparsed).not.toBe(diffItem(first[0]).fileDiff)
    expect(diffItem(reconcile({ diffs: [diffs[0]], open: new Set() })[0]).fileDiff).toBe(reparsed)
  })

  test("patch identity ignores redundant before/after content", () => {
    const reconcile = createReviewCodeViewItems()
    const diff = { file: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", before: "a\n", after: "b\n" }
    const first = reconcile({ diffs: [diff], open: new Set() })[0]
    diff.after = "irrelevant\n"
    expect(reconcile({ diffs: [diff], open: new Set() })[0]).toBe(first)
    diff.patch = "@@ -1 +1 @@\n-a\n+c\n"
    expect(diffItem(reconcile({ diffs: [diff], open: new Set() })[0]).fileDiff).not.toBe(diffItem(first).fileDiff)
  })

  test("unfetched files are custom items and become real diffs under the same identity", () => {
    const reconcile = createReviewCodeViewItems()
    const pending = reconcile({ diffs: [{ file: "pending.ts" }], open: new Set() })[0]
    expect(pending.type).toBe("custom")
    expect("fileDiff" in pending).toBe(false)
    const expanded = reconcile({ diffs: [{ file: "pending.ts" }], open: new Set(["pending.ts"]) })[0]
    expect(expanded.type).toBe("custom")
    expect(expanded.collapsed).toBe(false)
    const loaded = diffItem(reconcile({ diffs: [{ file: "pending.ts", before: "", after: "added\n" }], open: new Set(["pending.ts"]) })[0])
    expect(loaded.id).toBe(pending.id)
    expect(loaded.version).toBe(expanded.version! + 1)
    expect(loaded.fileDiff.additionLines).toEqual(["added\n"])
  })
})
