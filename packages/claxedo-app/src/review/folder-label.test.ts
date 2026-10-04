/// <reference types="bun" />
import { expect, test } from "bun:test"
import { folderLabel } from "./folder-label"

test("a nested folder splits into the part that may be cut and the last segment that is shown whole or not at all", () => {
  expect(folderLabel("packages/claxedo-app/src/review/view")).toEqual({
    cut: "packages/claxedo-app/src/review/",
    whole: "view",
  })
})

test("a folder of one segment is only the part shown whole", () => {
  expect(folderLabel("docs")).toEqual({ cut: "", whole: "docs" })
})

test("a file at the root has no folder label", () => {
  expect(folderLabel("")).toBeUndefined()
})
