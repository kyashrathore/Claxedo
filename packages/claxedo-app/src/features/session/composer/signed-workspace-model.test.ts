import { describe, expect, test } from "bun:test"
import {
  SIGNED_WORKSPACE_DEFAULT_MODEL_ID,
  SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER,
} from "./signed-workspace-model"
import { createSignedWorkspaceRuntimeFallback } from "./runtime-fallback"
import { firstConnectedModelInfo } from "./model-strategy"

describe("signed-workspace default model", () => {
  test("runtime fallback treats the signed workspace placeholder as no model", () => {
    const fallback = createSignedWorkspaceRuntimeFallback({
      serverUrl: () => "https://api.example.com",
      directory: () => "/repo/main",
      signedControlPlane: () => true,
      workspaceId: () => "ws_1",
      workspaceKind: () => "cloud",
    })

    expect(fallback.model()).toBeUndefined()
    expect(fallback.agent()).toEqual({ name: "build" })
  })

  test("runtime fallback stays silent when the workspace is not a signed runtime session", () => {
    const fallback = createSignedWorkspaceRuntimeFallback({
      serverUrl: () => "http://127.0.0.1:3001",
      directory: () => "/repo/main",
      // Not signed: local workspaces resolve their own model, never the placeholder.
      signedControlPlane: () => false,
      workspaceId: () => undefined,
      workspaceKind: () => undefined,
    })

    expect(fallback.model()).toBeUndefined()
    expect(fallback.agent()).toBeUndefined()
  })

  // Failure mode: the placeholder id the runtime fallback assigns MUST also be
  // the id model-strategy treats as a known-stale provider default. Otherwise a
  // signed-workspace user whose server default still points at the placeholder
  // would stay pinned to it even after real models load. Deriving the assertion
  // from the shared constant (not a literal "big-pickle") makes the two call
  // sites drift-proof: renaming the constant keeps this contract intact.
  test("the fallback model is always skipped as a stale default once real models exist", () => {
    const picked = firstConnectedModelInfo({
      connected: [
        {
          id: SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER,
          models: {
            "gpt-real": { id: "gpt-real", name: "Real Model" },
            [SIGNED_WORKSPACE_DEFAULT_MODEL_ID]: { id: SIGNED_WORKSPACE_DEFAULT_MODEL_ID, name: "placeholder" },
          },
        },
      ],
      // Server still names the placeholder as the provider default: it is
      // skipped as stale, so the first real model wins instead.
      defaults: { [SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER]: SIGNED_WORKSPACE_DEFAULT_MODEL_ID },
    })

    expect(picked?.id).not.toBe(SIGNED_WORKSPACE_DEFAULT_MODEL_ID)
    expect(picked?.id).toBe("gpt-real")
  })

  test("the placeholder is never usable when it is the only model the provider exposes", () => {
    const picked = firstConnectedModelInfo({
      connected: [
        {
          id: SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER,
          models: { [SIGNED_WORKSPACE_DEFAULT_MODEL_ID]: { id: SIGNED_WORKSPACE_DEFAULT_MODEL_ID, name: "placeholder" } },
        },
      ],
      defaults: { [SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER]: SIGNED_WORKSPACE_DEFAULT_MODEL_ID },
    })

    expect(picked).toBeUndefined()
  })
})
