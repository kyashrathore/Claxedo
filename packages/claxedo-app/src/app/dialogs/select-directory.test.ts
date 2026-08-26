import { describe, expect, test } from "bun:test"

import {
  claxedoBootstrapUrl,
  workspaceRuntimeFilePath,
  workspaceRuntimeFindFilePath,
} from "@/platform/runtime/agent/dialog-select-directory-routes"

describe("dialog select directory route helpers", () => {
  test("builds bootstrap and workspace runtime paths locally", () => {
    expect(String(claxedoBootstrapUrl({ serverUrl: "https://control.example.test/" }))).toBe(
      "https://control.example.test/api/claxedo/bootstrap",
    )
    expect(
      workspaceRuntimeFilePath({
        resource: "file",
        scope: "/Users/me/project",
        path: "",
      }),
    ).toBe("/file?directory=%2FUsers%2Fme%2Fproject&path=")
    expect(
      workspaceRuntimeFindFilePath({
        scope: "/Users/me/project",
        query: "src",
        type: "directory",
        limit: 50,
      }),
    ).toBe("/find/file?directory=%2FUsers%2Fme%2Fproject&query=src&type=directory&limit=50")
  })
})
