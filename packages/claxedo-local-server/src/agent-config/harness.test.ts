import { describe, expect, it } from "vitest"
import {
  type HarnessConfigOption,
  harnessFromRequest,
  isRuntimeHarnessConfigOptions,
  liveHarnessOptionsResponse,
  workspaceRuntimeHealthPath,
} from "./harness"

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

describe("liveHarnessOptionsResponse", () => {
  it("carries the harness's resolved model when the runtime named one", () => {
    const option = { id: "model", currentValue: "openclaw-pro", options: [] } as unknown as HarnessConfigOption
    expect(liveHarnessOptionsResponse({ options: [option], resolvedModel: { id: "openclaw-pro", name: "Openclaw Pro" } }))
      .toEqual({ options: [option], source: "harness", stale: false, resolvedModel: { id: "openclaw-pro", name: "Openclaw Pro" } })
    expect(liveHarnessOptionsResponse({ options: [option] })).toEqual({ options: [option], source: "harness", stale: false })
  })

  it("recognises only the runtime's object answer", () => {
    expect(isRuntimeHarnessConfigOptions({ options: [] })).toBe(true)
    expect(isRuntimeHarnessConfigOptions({ options: [], resolvedModel: { id: "m", name: "M" } })).toBe(true)
    expect(isRuntimeHarnessConfigOptions([])).toBe(false)
    expect(isRuntimeHarnessConfigOptions({ options: [], resolvedModel: { id: "m" } })).toBe(false)
    expect(isRuntimeHarnessConfigOptions({ error: { code: "x" } })).toBe(false)
  })
})
