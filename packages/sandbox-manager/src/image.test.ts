import { afterEach, describe, expect, test } from "vitest"
import { defaultSandboxImage, defaultSnapshotName, SNAPSHOT_SCHEMA_VERSION, snapshotVersion } from "./image"
import { workspaceRuntimeVersion } from "./runtime-version"

describe("sandbox image contract", () => {
  const originalBuildId = process.env.CLAXEDO_SANDBOX_BUILD_ID
  afterEach(() => {
    if (originalBuildId === undefined) delete process.env.CLAXEDO_SANDBOX_BUILD_ID
    else process.env.CLAXEDO_SANDBOX_BUILD_ID = originalBuildId
  })

  test("default sandbox image is pinned to the workspace-runtime package version", () => {
    delete process.env.CLAXEDO_SANDBOX_BUILD_ID
    expect(defaultSandboxImage()).toBe(
      `ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-${snapshotVersion(workspaceRuntimeVersion())}-v${SNAPSHOT_SCHEMA_VERSION}`,
    )
  })

  test("default snapshot name follows the workspace-runtime package version", () => {
    delete process.env.CLAXEDO_SANDBOX_BUILD_ID
    expect(defaultSnapshotName()).toBe(
      `claxedo-workspace-runtime-${workspaceRuntimeVersion().replaceAll(".", "-")}-v${SNAPSHOT_SCHEMA_VERSION}`,
    )
  })

  test("snapshot version is safe for driver snapshot names", () => {
    expect(snapshotVersion("0.4.9+build.1")).toBe("0-4-9-build-1")
  })

  test("build-id is inserted after the version and before the -v<schema> suffix", () => {
    delete process.env.CLAXEDO_SANDBOX_BUILD_ID
    const v = snapshotVersion(workspaceRuntimeVersion())
    expect(defaultSandboxImage(workspaceRuntimeVersion(), "abc1230000")).toBe(
      `ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-${v}-abc1230000-v${SNAPSHOT_SCHEMA_VERSION}`,
    )
    expect(defaultSnapshotName(workspaceRuntimeVersion(), "abc1230000")).toBe(
      `claxedo-workspace-runtime-${v}-abc1230000-v${SNAPSHOT_SCHEMA_VERSION}`,
    )
  })

  test("CLAXEDO_SANDBOX_BUILD_ID env supplies the build-id when no arg is passed", () => {
    process.env.CLAXEDO_SANDBOX_BUILD_ID = "deadbeef01"
    const v = snapshotVersion(workspaceRuntimeVersion())
    expect(defaultSandboxImage()).toBe(
      `ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-${v}-deadbeef01-v${SNAPSHOT_SCHEMA_VERSION}`,
    )
    expect(defaultSnapshotName()).toBe(
      `claxedo-workspace-runtime-${v}-deadbeef01-v${SNAPSHOT_SCHEMA_VERSION}`,
    )
  })

  test("explicit build-id arg wins over the env", () => {
    process.env.CLAXEDO_SANDBOX_BUILD_ID = "fromenv001"
    expect(defaultSandboxImage(workspaceRuntimeVersion(), "fromarg001")).toContain("-fromarg001-v")
  })

  test("blank env build-id is ignored (names stay unchanged)", () => {
    process.env.CLAXEDO_SANDBOX_BUILD_ID = "   "
    const v = snapshotVersion(workspaceRuntimeVersion())
    expect(defaultSandboxImage()).toBe(
      `ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-${v}-v${SNAPSHOT_SCHEMA_VERSION}`,
    )
  })
})
