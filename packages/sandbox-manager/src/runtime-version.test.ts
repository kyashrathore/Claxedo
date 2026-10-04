import { afterEach, describe, expect, test } from "vitest"
import { workspaceRuntimeVersion } from "./runtime-version"

describe("workspaceRuntimeVersion", () => {
  const original = process.env.WORKSPACE_RUNTIME_VERSION
  afterEach(() => {
    if (original === undefined) delete process.env.WORKSPACE_RUNTIME_VERSION
    else process.env.WORKSPACE_RUNTIME_VERSION = original
  })

  test("resolves at every call, so a later env change is not shadowed by an earlier read", () => {
    // Memoizing the first result would pin the version for the life of the
    // process: any composition that sets the env after something else already
    // read it would get the stale value, and the failure is silent — a stale
    // version resolves to a real image tag, just the wrong one.
    delete process.env.WORKSPACE_RUNTIME_VERSION
    const baked = workspaceRuntimeVersion()

    process.env.WORKSPACE_RUNTIME_VERSION = "9.9.9-override"
    expect(workspaceRuntimeVersion()).toBe("9.9.9-override")

    delete process.env.WORKSPACE_RUNTIME_VERSION
    expect(workspaceRuntimeVersion()).toBe(baked)
  })

  test("falls back to the version baked into the published images", () => {
    delete process.env.WORKSPACE_RUNTIME_VERSION
    expect(workspaceRuntimeVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("a blank env value falls back rather than producing an empty version", () => {
    delete process.env.WORKSPACE_RUNTIME_VERSION
    const baked = workspaceRuntimeVersion()
    process.env.WORKSPACE_RUNTIME_VERSION = ""
    expect(workspaceRuntimeVersion()).toBe(baked)
  })
})
