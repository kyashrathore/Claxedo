import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveMermaidRendererPath, mermaidRendererBinaryName } from "./mermaid-renderer-path"

describe("Mermaid renderer path", () => {
  test("resolves the target-specific development artifact", () => {
    expect(
      resolveMermaidRendererPath({
        packaged: false,
        resourcesPath: "/resources",
        appPath: "/app",
        platform: "darwin",
        arch: "arm64",
        exists: () => true,
      }),
    ).toBe(join("/app", "resources", "mermaid", "darwin-arm64", "claxedo-mermaid-renderer"))
  })

  test("resolves the flattened packaged artifact", () => {
    expect(
      resolveMermaidRendererPath({
        packaged: true,
        resourcesPath: "/bundle/Resources",
        appPath: "/bundle/Resources/app.asar",
        platform: "win32",
        arch: "x64",
        exists: () => true,
      }),
    ).toBe(join("/bundle/Resources", "mermaid", "claxedo-mermaid-renderer.exe"))
  })

  test("prefers an explicit override and returns undefined when no artifact exists", () => {
    expect(
      resolveMermaidRendererPath({
        packaged: true,
        resourcesPath: "/resources",
        appPath: "/app",
        override: "/custom/renderer",
        exists: (path) => path === "/custom/renderer",
      }),
    ).toBe("/custom/renderer")
    expect(
      resolveMermaidRendererPath({
        packaged: true,
        resourcesPath: "/resources",
        appPath: "/app",
        exists: () => false,
      }),
    ).toBeUndefined()
  })

  test("uses an executable suffix only on Windows", () => {
    expect(mermaidRendererBinaryName("linux")).toBe("claxedo-mermaid-renderer")
    expect(mermaidRendererBinaryName("win32")).toBe("claxedo-mermaid-renderer.exe")
  })
})
