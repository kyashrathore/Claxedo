import { describe, expect, test } from "bun:test"

import {
  composerHarness,
  composerHarnessId,
  isComposerHarnessMode,
} from "./mode"

describe("composer mode", () => {
  test("resolves harness identity from draft targets and session refs", () => {
    expect(composerHarnessId({
      kind: "draft",
      target: {
        worktree: "main",
        hostKind: "self",
        signedControlPlane: false,
        harness: { kind: "connection", connectionId: "acp:codex" },
      },
    })).toEqual({ kind: "connection", connectionId: "acp:codex" })

    expect(composerHarness({
      kind: "session",
      ref: {
        sessionId: "ses_1",
        host: "workspace",
        harness: { kind: "connection", connectionId: "acp:claude", binary: "claude" },
      },
    })).toEqual({ kind: "connection", connectionId: "acp:claude", binary: "claude" })

    expect(isComposerHarnessMode({
      kind: "draft",
      target: undefined,
    })).toBe(false)
  })

})
