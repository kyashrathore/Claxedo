import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { lineCounts } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")
const maxLines = 800
const allowlist = JSON.parse(readFileSync(path.join(import.meta.dir, "size-allowlist.json"), "utf8")) as Record<
  string,
  number
>

describe("architecture size budget", () => {
  test("keeps production files under 800 lines unless already allowlisted", () => {
    const allowlisted = new Set(Object.keys(allowlist))
    const offenders = lineCounts(appRoot)
      .filter((entry) => entry.lines > maxLines)
      .filter((entry) => !allowlisted.has(entry.file))
      .map((entry) => `${entry.file} is ${entry.lines} lines > ${maxLines} -- split it; adding to size-allowlist.json is not allowed`)

    expect(offenders).toEqual([])
  })

  test("keeps allowlisted files from growing", () => {
    const live = new Map(lineCounts(appRoot).map((entry) => [entry.file, entry.lines]))
    const offenders = Object.entries(allowlist).flatMap(([file, ceiling]) => {
      const lines = live.get(file)
      if (lines === undefined) return [`${file} is no longer present -- remove it from size-allowlist.json`]
      if (lines <= maxLines) return [`${file} is now ${lines} lines <= ${maxLines} -- remove it from size-allowlist.json`]
      if (lines > ceiling) return [`${file} grew to ${lines} lines > allowlist ceiling ${ceiling} -- split it`]
      return []
    })

    expect(offenders).toEqual([])
  })
})
