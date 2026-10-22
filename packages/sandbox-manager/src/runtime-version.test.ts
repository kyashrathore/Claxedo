import { afterEach, describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { MINIMUM_SERVED_WORKSPACE_RUNTIME_VERSION, SERVED_WORKSPACE_RUNTIME_FLOOR, workspaceRuntimeVersion } from "./runtime-version"

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

const versionParts = (version: string) => version.split(".").map(Number)

test("the oldest runtime the control plane serves is never newer than the runtime this tree builds", () => {
  const built = (JSON.parse(readFileSync(new URL("../../workspace-runtime/package.json", import.meta.url), "utf8")) as { version: string }).version
  const [floor, current] = [versionParts(MINIMUM_SERVED_WORKSPACE_RUNTIME_VERSION), versionParts(built)]
  expect(floor.every(Number.isSafeInteger) && floor.length === 3).toBe(true)
  const newer = floor.findIndex((part, index) => part !== current[index])
  expect(newer === -1 || (floor[newer] ?? 0) < (current[newer] ?? 0), `${MINIMUM_SERVED_WORKSPACE_RUNTIME_VERSION} is above ${built}`).toBe(true)
})

test("the floor names the cloud image published at its version, so the skew suite runs the runtime it vouches for", () => {
  const tag = SERVED_WORKSPACE_RUNTIME_FLOOR.image.split(":").at(-1) ?? ""
  expect(SERVED_WORKSPACE_RUNTIME_FLOOR.image.startsWith("ghcr.io/kyashrathore/claxedo-sandbox:")).toBe(true)
  expect(tag.startsWith(`workspace-runtime-${SERVED_WORKSPACE_RUNTIME_FLOOR.version.replaceAll(".", "-")}-`)).toBe(true)
  expect(tag.endsWith("-agent-plugins-v8")).toBe(true)
})
