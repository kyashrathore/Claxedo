import { describe, expect, test } from "bun:test"
import { workspaceCaptureUrl } from "./workspace-capture-url.mjs"

describe("workspaceCaptureUrl", () => {
  test("builds capture URLs from opaque workspace IDs", () => {
    expect(workspaceCaptureUrl({ workspaceId: "ws_123", origin: "http://localhost:4445/" }))
      .toBe("http://localhost:4445/w/ws_123/session")
  })

  test("rejects raw and percent-encoded filesystem paths", () => {
    expect(() => workspaceCaptureUrl({
      override: "http://localhost:4445/w//private/tmp/workspace/session",
      origin: "http://localhost:4445",
    })).toThrow("opaque workspace ID")
    expect(() => workspaceCaptureUrl({
      override: "http://localhost:4445/w/%2Fprivate%2Ftmp%2Fworkspace/session",
      origin: "http://localhost:4445",
    })).toThrow("opaque workspace ID")
    expect(() => workspaceCaptureUrl({
      override: "http://localhost:4445/w/%252FUsers%252Fperson%252Fworkspace/session",
      origin: "http://localhost:4445",
    })).toThrow("opaque workspace ID")
  })

  test("requires an ID when no explicit URL is supplied", () => {
    expect(() => workspaceCaptureUrl({ origin: "http://localhost:4445" }))
      .toThrow("CLAXEDO_WORKSPACE_ID is required")
  })
})
