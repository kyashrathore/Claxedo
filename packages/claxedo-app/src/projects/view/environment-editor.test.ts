import { expect, test } from "bun:test"
import { environmentChanges, environmentRows, markStored } from "./environment-editor"

test("a save that failed part-way sends only what is left once the saved changes are recorded", () => {
  const rows = [...environmentRows(["KEEP", "DROP"]).filter((row) => row.name !== "DROP" && row.name !== ""), { id: 10, name: "FIRST", value: "1", stored: false }, { id: 11, name: "SECOND", value: "2", stored: false }]
  expect(environmentChanges(["KEEP", "DROP"], rows)).toEqual({ remove: ["DROP"], set: [["FIRST", "1"], ["SECOND", "2"]] })
  const afterFirst = markStored(rows, "FIRST")
  expect(environmentChanges(["KEEP", "FIRST"], afterFirst)).toEqual({ remove: [], set: [["SECOND", "2"]] })
})
