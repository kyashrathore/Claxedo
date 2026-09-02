import { describe, expect, test } from "bun:test"

import {
  workspaceRuntimeFilePath,
  workspaceRuntimeFindFilePath,
} from "@/platform/runtime/agent/dialog-select-directory-routes"

describe("dialog select directory route helpers", () => {
  test("builds workspace runtime paths locally", () => {
    expect(workspaceRuntimeFilePath({
      resource: "file",
      scope: "/Users/me/project",
      path: "",
    })).toBe("/file?directory=%2FUsers%2Fme%2Fproject&path=")
    expect(workspaceRuntimeFindFilePath({
      scope: "/Users/me/project",
      query: "src",
      type: "directory",
      limit: 50,
    })).toBe("/find/file?directory=%2FUsers%2Fme%2Fproject&query=src&type=directory&limit=50")
  })
})
