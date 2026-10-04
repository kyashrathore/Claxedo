import { describe, expect, test } from "vitest"
import { repoTargetFromText } from "./repo-target"

describe("repoTargetFromText", () => {
  test("parses repo owner/name references from channel text", () => {
    expect(repoTargetFromText("please run repo:acme/tools")).toEqual({
      owner: "acme",
      name: "tools",
    })
  })

  test("ignores text without an explicit repo target", () => {
    expect(repoTargetFromText("please inspect acme/tools")).toBeUndefined()
  })
})
