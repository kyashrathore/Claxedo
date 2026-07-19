import { describe, expect, it } from "bun:test"
import { resolveWorkspaceFileFocus } from "./workspace-file-focus"

const DIR = "/Users/me/project"

describe("resolveWorkspaceFileFocus", () => {
  it("passes plain relative paths through", () => {
    expect(resolveWorkspaceFileFocus("src/foo.ts", DIR)).toEqual({
      path: "src/foo.ts",
      line: undefined,
      col: undefined,
    })
  })

  it("strips a ./ prefix", () => {
    expect(resolveWorkspaceFileFocus("./src/foo.ts", DIR)?.path).toBe("src/foo.ts")
  })

  it("parses :line and :line:col suffixes off the path", () => {
    expect(resolveWorkspaceFileFocus("src/foo.ts:42", DIR)).toEqual({
      path: "src/foo.ts",
      line: 42,
      col: undefined,
    })
    expect(resolveWorkspaceFileFocus("src/foo.ts:42:7", DIR)).toEqual({
      path: "src/foo.ts",
      line: 42,
      col: 7,
    })
  })

  it("relativizes absolute paths inside the workspace", () => {
    expect(resolveWorkspaceFileFocus(`${DIR}/src/foo.ts`, DIR)?.path).toBe("src/foo.ts")
    expect(resolveWorkspaceFileFocus(`${DIR}/src/foo.ts:10`, DIR)).toEqual({
      path: "src/foo.ts",
      line: 10,
      col: undefined,
    })
  })

  it("tolerates a trailing slash on the workspace dir", () => {
    expect(resolveWorkspaceFileFocus(`${DIR}/src/foo.ts`, `${DIR}/`)?.path).toBe("src/foo.ts")
  })

  it("rejects absolute paths outside the workspace", () => {
    expect(resolveWorkspaceFileFocus("/etc/passwd", DIR)).toBeUndefined()
    expect(resolveWorkspaceFileFocus("/Users/me/project-other/x.ts", DIR)).toBeUndefined()
  })

  it("rejects the workspace directory itself", () => {
    expect(resolveWorkspaceFileFocus(DIR, DIR)).toBeUndefined()
  })

  it("rejects tilde paths", () => {
    expect(resolveWorkspaceFileFocus("~/config.json", DIR)).toBeUndefined()
  })

  it("rejects traversal segments", () => {
    expect(resolveWorkspaceFileFocus("../../etc/passwd", DIR)).toBeUndefined()
    expect(resolveWorkspaceFileFocus("src/../../x.ts", DIR)).toBeUndefined()
  })

  it("rejects empty input", () => {
    expect(resolveWorkspaceFileFocus("", DIR)).toBeUndefined()
    expect(resolveWorkspaceFileFocus("   ", DIR)).toBeUndefined()
    expect(resolveWorkspaceFileFocus("./", DIR)).toBeUndefined()
  })
})
