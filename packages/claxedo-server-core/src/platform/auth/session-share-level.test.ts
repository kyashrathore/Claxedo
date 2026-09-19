import { describe, expect, test } from "vitest"
import {
  DEFAULT_SESSION_SHARE_LEVEL,
  isSessionShareLevel,
  requestedSessionShareLevel,
  SESSION_SHARE_LEVELS,
  storedSessionShareLevel,
} from "./session-share-level"

describe("the level a share carries", () => {
  test("a request that names no level asks for the narrower one", () => {
    expect(requestedSessionShareLevel(undefined)).toBe("follow")
    expect(requestedSessionShareLevel(null)).toBe("follow")
    expect(DEFAULT_SESSION_SHARE_LEVEL).toBe("follow")
  })

  test("a request naming either level is answered with it", () => {
    for (const level of SESSION_SHARE_LEVELS) expect(requestedSessionShareLevel(level)).toBe(level)
  })

  test("a request naming anything else is refused rather than narrowed", () => {
    for (const value of ["broadcast", "SEND", "", 1, true, {}, []]) {
      expect(() => requestedSessionShareLevel(value)).toThrow("session_share_level_invalid")
    }
  })

  test("a stored value the store cannot vouch for reads as follow", () => {
    expect(storedSessionShareLevel("send")).toBe("send")
    expect(storedSessionShareLevel("follow")).toBe("follow")
    // The column was added with a default, so a row written before it has none.
    expect(storedSessionShareLevel(null)).toBe("follow")
    expect(storedSessionShareLevel("broadcast")).toBe("follow")
  })

  test("the guard admits exactly the two levels", () => {
    expect(SESSION_SHARE_LEVELS.every(isSessionShareLevel)).toBe(true)
    expect(isSessionShareLevel("broadcast")).toBe(false)
  })
})
