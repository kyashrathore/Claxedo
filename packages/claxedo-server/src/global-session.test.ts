import { describe, expect, test } from "vitest"
import path from "path"
import { globalRoot, isGlobalDirectory } from "./global-session"

describe("global session paths", () => {
  test("matches only directories inside the global session root", () => {
    expect(isGlobalDirectory(path.join(globalRoot(), "session-1"))).toBe(true)
    expect(isGlobalDirectory(globalRoot())).toBe(true)
    expect(isGlobalDirectory(path.join(globalRoot(), "..", "not-global"))).toBe(false)
    expect(isGlobalDirectory(undefined)).toBe(false)
  })
})
