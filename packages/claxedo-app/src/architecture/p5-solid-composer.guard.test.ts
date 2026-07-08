import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { metrics, walkProdSources } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

function scanSessionClient(metric: "effectStateWrites" | "propsDestructuring" | "suppressionFlags") {
  return metrics
    .find((item) => item.name === metric)!
    .scan(walkProdSources(appRoot).filter((file) => file.path.startsWith("session-client/")))
}

describe("P5 Solid composer guard", () => {
  test("keeps session-client modules free of Solid write-effect debt", () => {
    expect(scanSessionClient("effectStateWrites")).toEqual([])
    expect(scanSessionClient("propsDestructuring")).toEqual([])
    expect(scanSessionClient("suppressionFlags")).toEqual([])
  })

  test("keeps deleted P5 compatibility shims from returning", () => {
    expect(existsSync(path.join(appRoot, "src/components/prompt-input/fallback-guard.ts"))).toBe(false)
    expect(existsSync(path.join(appRoot, "src/claxedo-ui/context/harness-config.ts"))).toBe(false)

    const text = walkProdSources(appRoot)
      .filter((file) => file.path.startsWith("session-client/") || file.path.startsWith("components/prompt-input"))
      .map((file) => file.text)
      .join("\n")

    expect(text).not.toMatch(/fastSwitchRestoreDeferred/)
    expect(text).not.toMatch(/composerModeFromLegacyProps|legacySessionId|LegacyComposerModeProps/)
    expect(text).not.toMatch(/dock-capture|captureSubmit|captureSlashCommands/)
    expect(text).not.toMatch(/fallbackGuardScopeKey|shouldApplyModelFallback|shouldApplyAgentFallback|createFallbackGuardState/)
  })
})
