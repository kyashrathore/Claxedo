import { describe, expect, test } from "bun:test"
import path from "node:path"
import { liveSourceTextGrepOffenders, sourceTextGrepOffenders } from "./source-text-assertions"
import baseline from "./source-text-assertions-baseline.json"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("source-text assertion guard", () => {
  test("flags Bun.file(...).text() + toContain source-grep tests", () => {
    expect(
      sourceTextGrepOffenders([
        { path: "app/foo.test.ts", text: `const src = await Bun.file(url).text()\nexpect(src).toContain("bar")` },
        {
          path: "app/only-bun-file.test.ts",
          text: `const src = await Bun.file(url).text()\nexpect(src).toMatch(/bar/)`,
        },
        { path: "app/only-to-contain.test.ts", text: `expect(result).toContain("bar")` },
      ]),
    ).toEqual(["app/foo.test.ts"])
  })

  test("does not add new source-text-grep tests beyond the current shrink-only baseline", () => {
    const baselineSet = new Set(baseline)
    const offenders = liveSourceTextGrepOffenders(appRoot)
      .filter((file) => !baselineSet.has(file))
      .map(
        (file) =>
          `${file}: asserts on raw source text (Bun.file(...).text() + toContain) -- assert real behavior instead, or add a named rule to src/architecture/scanners.ts`,
      )

    expect(offenders).toEqual([])
  })

  test("keeps the source-text-grep baseline pruned as files migrate to behavioral assertions", () => {
    const live = new Set(liveSourceTextGrepOffenders(appRoot))
    const offenders = baseline
      .filter((file) => !live.has(file))
      .map(
        (file) =>
          `${file}: no longer uses the source-text-grep anti-pattern -- remove it from source-text-assertions-baseline.json`,
      )

    expect(offenders).toEqual([])
  })
})
