import { describe, expect, test } from "bun:test"
import { timelineFileCandidateIsOpenable } from "./timeline-file-paths"

const DIR = "/Users/me/project"

describe("timelineFileCandidateIsOpenable", () => {
  test("accepts an exact extensionless workspace file", async () => {
    expect(
      await timelineFileCandidateIsOpenable("packages/opencode/bin/opencode", DIR, async () => [
        "packages/opencode/bin/opencode",
      ]),
    ).toBe(true)
  })

  test("rejects directories and fuzzy-only file matches", async () => {
    expect(await timelineFileCandidateIsOpenable("packages/opencode", DIR, async () => [])).toBe(false)
    expect(
      await timelineFileCandidateIsOpenable("session/status", DIR, async () => ["src/session/status.ts"]),
    ).toBe(false)
  })

  test("rejects traversal before searching", async () => {
    let searches = 0
    expect(
      await timelineFileCandidateIsOpenable("../shared/util.ts", DIR, async () => {
        searches += 1
        return ["../shared/util.ts"]
      }),
    ).toBe(false)
    expect(searches).toBe(0)
  })
})
