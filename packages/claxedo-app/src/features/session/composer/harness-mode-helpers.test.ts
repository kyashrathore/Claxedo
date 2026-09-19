import { describe, expect, test } from "bun:test"
import type { HarnessSubmitController } from "@/features/session/harness/controller"
import { nativeHarness } from "@/platform/identity/harness-selection"
import { createComposerHarnessMode } from "./harness-mode-helpers"

function controller(): HarnessSubmitController {
  return {
    harness: () => nativeHarness("codex"),
    isHarnessMode: () => true,
    readiness: () => "ready",
    readyForSubmit: () => true,
    modelKeyForSubmit: () => ({ providerID: "codex", modelID: "gpt-5.5" }),
    claimSession: async () => undefined,
    setHarness: async () => undefined,
    promote: () => undefined,
  }
}

describe("composer harness mode", () => {
  test("uses server-hydrated harness identity while an existing SessionRef is still sparse", () => {
    const helpers = createComposerHarnessMode({
      composerMode: () => ({
        kind: "session",
        ref: {
          sessionId: "ses_cloud",
          host: "workspace",
          workspaceId: "ws_cloud",
          toolSandbox: { kind: "workspace", workspaceId: "ws_cloud", hosting: "provisioner" },
        },
      }),
      harnessController: controller(),
      harnessSelectionController: undefined,
    })

    expect(helpers.isHarnessMode("session:ses_cloud")).toBe(true)
    expect(helpers.currentHarnessType("session:ses_cloud")).toEqual(nativeHarness("codex"))
  })
})
