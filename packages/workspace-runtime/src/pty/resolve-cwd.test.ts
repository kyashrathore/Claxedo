import { describe, expect, test } from "bun:test"
import { resolveCwd } from "./resolve-cwd"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "resolve-cwd-test-"))
}

describe("resolveCwd", () => {
  test("returns workspace path when no override given", () => {
    const tmp = mktmp()
    try {
      expect(resolveCwd(undefined, tmp)).toBe(tmp)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("returns homedir when no override and no workspace", () => {
    expect(resolveCwd(undefined, undefined)).toBe(os.homedir())
  })

  test("returns absolute override path when it exists", () => {
    const tmp = mktmp()
    try {
      expect(resolveCwd(tmp, undefined)).toBe(tmp)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("falls back to workspace when absolute override does not exist", () => {
    const tmp = mktmp()
    try {
      expect(resolveCwd("/nonexistent/path/xyz", tmp)).toBe(tmp)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("falls back to homedir when both absolute override and workspace do not exist", () => {
    expect(resolveCwd("/nonexistent/a", "/nonexistent/b")).toBe(os.homedir())
  })

  test("resolves relative path against workspace", () => {
    const tmp = mktmp()
    const sub = path.join(tmp, "subdir")
    fs.mkdirSync(sub)
    try {
      expect(resolveCwd("subdir", tmp)).toBe(sub)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("falls back to workspace when relative path does not resolve", () => {
    const tmp = mktmp()
    try {
      expect(resolveCwd("nonexistent", tmp)).toBe(tmp)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // -- Windows-specific path handling --

  test("recognizes Windows drive-letter absolute paths", () => {
    // The regex /^[a-zA-Z]:\\/ in resolveCwd detects Windows paths
    // On non-Windows this path won't exist, so it falls back
    if (process.platform === "win32") {
      const tmp = mktmp()
      try {
        // On Windows, the temp dir uses a drive letter
        expect(resolveCwd(tmp, undefined)).toBe(tmp)
        // Forward-slash variant should also work as absolute
        const forward = tmp.replaceAll("\\", "/")
        // This won't match the regex (needs backslash), so it's treated as relative
        // unless the path happens to start with / which is also absolute
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    } else {
      // On non-Windows, C:\ path is not absolute (starts with /), falls to relative
      const tmp = mktmp()
      try {
        const result = resolveCwd("C:\\fake\\path", tmp)
        // C:\fake\path treated as relative → resolved against tmp → doesn't exist → falls back to tmp
        expect(result).toBe(tmp)
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    }
  })

  test("Windows: drive-letter path that does not exist falls back to workspace", () => {
    if (process.platform !== "win32") return
    const tmp = mktmp()
    try {
      expect(resolveCwd("Z:\\nonexistent\\path", tmp)).toBe(tmp)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
