import { afterEach, describe, expect, test, vi } from "vitest"
import { DaytonaNotFoundError } from "@daytona/sdk"
import type { Daytona } from "@daytona/sdk"
import {
  defaultSandboxImage,
  defaultSnapshotName,
  ensureSnapshot,
  SNAPSHOT_NAME,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotVersion,
} from "./image"
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

describe("snapshot build progress reporting", () => {
  // A snapshot build takes minutes. Before the sink existed these messages went
  // to a no-op logger, so `onLogs` — the only view into whether a build is
  // progressing or wedged — was discarded.
  function daytona(input: {
    get?: () => Promise<unknown>
    create?: (params: unknown, options: { onLogs?: (chunk: string) => void }) => Promise<unknown>
  }) {
    return {
      snapshot: {
        get: input.get ?? vi.fn(async () => ({ state: "ready" })),
        create: input.create ?? vi.fn(async () => {}),
        activate: vi.fn(async () => {}),
      },
    } as unknown as Daytona
  }

  test("the build stream and its progress messages reach the injected sink", async () => {
    const log = vi.fn()
    const sdk = daytona({
      get: vi.fn(async () => {
        throw new DaytonaNotFoundError("missing")
      }),
      create: vi.fn(async (_params, options) => {
        options.onLogs?.("step 1/3 pulling base image")
        options.onLogs?.("step 3/3 done")
      }),
    })

    expect(await ensureSnapshot(sdk, { log })).toBe(SNAPSHOT_NAME)

    expect(log).toHaveBeenCalledWith(
      "Creating sandbox snapshot (this may take a few minutes)...",
      { name: SNAPSHOT_NAME },
    )
    expect(log).toHaveBeenCalledWith("[snapshot]", { text: "step 1/3 pulling base image" })
    expect(log).toHaveBeenCalledWith("[snapshot]", { text: "step 3/3 done" })
  })

  test("reactivating an inactive snapshot is reported", async () => {
    const log = vi.fn()
    const states = ["inactive", "ready"]
    const sdk = daytona({ get: vi.fn(async () => ({ state: states.shift(), id: "snap_1" })) })

    expect(await ensureSnapshot(sdk, { log })).toBe(SNAPSHOT_NAME)
    expect(log).toHaveBeenCalledWith(
      "Snapshot is inactive, reactivating...",
      { name: SNAPSHOT_NAME, id: "snap_1" },
    )
  })

  test("the default sink is console-backed, so an unwired caller still sees the build", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const sdk = daytona({
        get: vi.fn(async () => {
          throw new DaytonaNotFoundError("missing")
        }),
      })
      await ensureSnapshot(sdk)
      expect(info).toHaveBeenCalledWith(
        "Creating sandbox snapshot (this may take a few minutes)...",
        { name: SNAPSHOT_NAME },
      )
    } finally {
      info.mockRestore()
    }
  })
})
