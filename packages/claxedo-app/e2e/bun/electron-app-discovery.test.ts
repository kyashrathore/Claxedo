import { describe, expect, test } from "bun:test"
import { isPackagedApplicationEntry } from "../helpers/electron-app"

describe("packaged desktop binary discovery", () => {
  test("selects the Linux application without mistaking Electron helpers for it", () => {
    expect(["chrome-sandbox", "chrome_crashpad_handler", "claxedo", "resources"]
      .filter((entry) => isPackagedApplicationEntry("linux", entry, entry !== "resources"))).toEqual(["claxedo"])
  })

  test("keeps Windows unpacked executables discoverable", () => {
    expect(isPackagedApplicationEntry("win32", "Claxedo.exe", true)).toBe(true)
    expect(isPackagedApplicationEntry("win32", "resources.pak", true)).toBe(false)
  })
})
