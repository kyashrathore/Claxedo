import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveRichContentRendererPath, richContentRendererBinaryName } from "./rich-content-renderer-path"

describe("rich-content renderer path", () => {
  test("resolves the target-specific development artifact", () => {
    expect(
      resolveRichContentRendererPath({
        packaged: false,
        resourcesPath: "/resources",
        appPath: "/app",
        platform: "darwin",
        arch: "arm64",
        exists: () => true,
      }),
    ).toBe(join("/app", "resources", "rich-content", "darwin-arm64", "claxedo-rich-content-renderer"))
  })

  test("resolves the flattened packaged artifact", () => {
    expect(
      resolveRichContentRendererPath({
        packaged: true,
        resourcesPath: "/bundle/Resources",
        appPath: "/bundle/Resources/app.asar",
        platform: "win32",
        arch: "x64",
        exists: () => true,
      }),
    ).toBe(join("/bundle/Resources", "rich-content", "claxedo-rich-content-renderer.exe"))
  })

  test("prefers an explicit override and returns undefined when no artifact exists", () => {
    expect(
      resolveRichContentRendererPath({
        packaged: true,
        resourcesPath: "/resources",
        appPath: "/app",
        override: "/custom/renderer",
        exists: (path) => path === "/custom/renderer",
      }),
    ).toBe("/custom/renderer")
    expect(
      resolveRichContentRendererPath({
        packaged: true,
        resourcesPath: "/resources",
        appPath: "/app",
        exists: () => false,
      }),
    ).toBeUndefined()
  })

  test("uses an executable suffix only on Windows", () => {
    expect(richContentRendererBinaryName("linux")).toBe("claxedo-rich-content-renderer")
    expect(richContentRendererBinaryName("win32")).toBe("claxedo-rich-content-renderer.exe")
  })
})
