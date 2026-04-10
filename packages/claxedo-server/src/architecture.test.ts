import { beforeEach, describe, expect, test } from "vitest"
import { configureHarnessMode, getHarnessMode, getSessionWriteMode, getWorkspaceProfile } from "./architecture"

describe("harness architecture", () => {
  beforeEach(() => {
    configureHarnessMode("workspace")
  })

  test("defaults to workspace/full replicated mode", () => {
    expect(getHarnessMode()).toBe("workspace")
    expect(getWorkspaceProfile()).toBe("full")
    expect(getSessionWriteMode()).toBe("workspace_replicated")
  })

  test("switches to central/minimal canonical mode", () => {
    expect(configureHarnessMode("central")).toBe("central")
    expect(getHarnessMode()).toBe("central")
    expect(getWorkspaceProfile()).toBe("minimal")
    expect(getSessionWriteMode()).toBe("central_canonical")
  })
})
