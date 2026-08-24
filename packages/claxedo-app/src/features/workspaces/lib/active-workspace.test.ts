import { describe, expect, test } from "bun:test"
import { resolveActiveDirectory } from "./active-workspace"

describe("resolveActiveDirectory", () => {
  test("uses the route workspace over a stale focused surface", () => {
    expect(
      resolveActiveDirectory({
        routeDir: "workspace:ws_local_image_codex",
        surfaceDir: "workspace:ws_mpc6zdii",
      }),
    ).toBe("workspace:ws_local_image_codex")
  })

  test("falls back to the focused surface when there is no workspace route", () => {
    expect(resolveActiveDirectory({ surfaceDir: "workspace:ws_mpc6zdii" })).toBe("workspace:ws_mpc6zdii")
  })

  test("uses the route workspace when no surface is focused", () => {
    expect(resolveActiveDirectory({ routeDir: "workspace:ws_local_image_codex" })).toBe(
      "workspace:ws_local_image_codex",
    )
  })

  test("returns undefined when neither source names a workspace", () => {
    expect(resolveActiveDirectory({})).toBeUndefined()
  })
})
