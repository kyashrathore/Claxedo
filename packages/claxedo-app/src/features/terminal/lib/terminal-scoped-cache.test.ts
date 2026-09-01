import { describe, expect, test } from "bun:test"
import { terminalScopedPlacement } from "./terminal-scoped-cache"

describe("terminalScopedPlacement", () => {
  test("routes a resolved non-local workspace through the relay", () => {
    expect(terminalScopedPlacement("https://claxedo.example.test", { kind: "cloud", workspaceId: "ws_1" })).toEqual({
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
    })
  })

  test("falls back to the server's central transport when nothing resolves", () => {
    expect(terminalScopedPlacement("https://claxedo.example.test", null)).toEqual({
      hosting: "workspace",
      transport: "signed-web",
    })
  })

  // Regression: a signed user-hosted workspace addressed by its filesystem-path
  // directory has no `/api/workspace/resolve` entry on the hosted control
  // plane — the caller's liveness read (`workspace`) comes back empty for it —
  // so the signed inventory match passed as `signedWorkspace` must still win
  // the relay placement instead of falling through to the central transport.
  test("prefers the signed workspace inventory match when the liveness read is empty", () => {
    expect(
      terminalScopedPlacement(
        "https://claxedo.example.test",
        null,
        { kind: "user-hosted", workspaceId: "ws_uh1" },
      ),
    ).toEqual({
      workspaceId: "ws_uh1",
      hosting: "workspace",
      transport: "workspace-relay",
    })
  })

  // The signed inventory is the canonical placement authority (same precedent
  // as `createGlobalSdkFetch`'s `resolveSignedWorkspace`), so it wins even when
  // the liveness read also resolved a (different) workspace.
  test("prefers the signed workspace inventory match over a resolved liveness read", () => {
    expect(
      terminalScopedPlacement(
        "https://claxedo.example.test",
        { kind: "cloud", workspaceId: "ws_live" },
        { kind: "user-hosted", workspaceId: "ws_signed" },
      ),
    ).toEqual({
      workspaceId: "ws_signed",
      hosting: "workspace",
      transport: "workspace-relay",
    })
  })
})
