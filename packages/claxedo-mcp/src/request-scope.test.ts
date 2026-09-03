import { describe, expect, it } from "vitest"
import { claxedoRequestScope } from "./request-scope"

describe("Claxedo request scope", () => {
  it("keeps personal owner-scoped requests free of workspace selectors", () => {
    expect(claxedoRequestScope("https://claxedo.test", "/api/control/sessions", { type: "owner" })).toEqual({
      url: "https://claxedo.test/api/control/sessions",
      headers: {},
    })
  })

  it("preserves directory and workspace routing for workspace-bound runtime tools", () => {
    expect(claxedoRequestScope("https://claxedo.test", "/api/wr/process?state=running", {
      type: "workspace",
      directory: "workspace:workspace-1",
      workspaceId: "workspace-1",
    })).toEqual({
      url: "https://claxedo.test/api/wr/process?state=running&directory=workspace%3Aworkspace-1&workspaceId=workspace-1",
      headers: {
        "x-opencode-directory": "workspace:workspace-1",
        "x-workspace-id": "workspace-1",
      },
    })
  })
})
