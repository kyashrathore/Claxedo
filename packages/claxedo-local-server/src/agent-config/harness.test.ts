import { describe, expect, it } from "vitest"
import { harnessFromRequest, workspaceRuntimeHealthPath } from "./harness"

describe("harnessFromRequest", () => {
  it("decodes an operator ACP key from the legacy type field used by the picker", () => {
    expect(harnessFromRequest(undefined, { type: "acp:openclaw" })).toEqual({
      id: "openclaw",
      access: "acp",
    })
  })
})

describe("workspaceRuntimeHealthPath", () => {
  it("forwards the exact session identity to workspace-runtime health", () => {
    expect(workspaceRuntimeHealthPath("session with spaces")).toBe(
      "/api/wr/health?sessionId=session+with+spaces",
    )
  })

  it("keeps workspace aggregate health when no session is requested", () => {
    expect(workspaceRuntimeHealthPath()).toBe("/api/wr/health")
  })
})
