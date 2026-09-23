import { describe, expect, test } from "bun:test"
import { draftProjectName } from "./draft"

describe("draftProjectName", () => {
  test("a folder is named by its basename, trailing separators dropped", () => {
    expect(draftProjectName({ kind: "directory", folder: "/home/me/widgets/" })).toBe("widgets")
    expect(draftProjectName({ kind: "directory", folder: "C:\\code\\widgets" })).toBe("widgets")
  })

  test("a repository URL is named by its last path segment without .git", () => {
    expect(draftProjectName({ kind: "repository", repoUrl: "https://github.com/acme/widgets.git" })).toBe("widgets")
    expect(draftProjectName({ kind: "repository", repoUrl: "https://gitlab.com/group/sub/tool" })).toBe("tool")
  })

  test("a connected repository is named by the part of its full name after the owner", () => {
    expect(draftProjectName({ kind: "repository", connectionId: "conn_1", repo: { fullName: "acme/widgets" } })).toBe("widgets")
  })
})
