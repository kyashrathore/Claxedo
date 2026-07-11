import { describe, expect, test } from "bun:test"

import {
  canStartSubmit,
  composerHarness,
  composerHarnessId,
  harnessBridge,
  isComposerHarnessMode,
  type ComposerMode,
} from "./mode"

describe("composer mode", () => {
  test("draft harness mode is the harness bridge", () => {
    const mode: ComposerMode = {
      kind: "draft",
      target: {
        worktree: "main",
        workspaceKind: "local",
        signedControlPlane: false,
        harness: { id: "claude-acp", binary: "claude" },
      },
    }

    expect(harnessBridge(mode)).toBe(true)
  })

  test("opencode draft and existing sessions are not harness bridges", () => {
    expect(harnessBridge({
      kind: "draft",
      target: {
        worktree: "main",
        workspaceKind: "local",
        signedControlPlane: false,
      },
    })).toBe(false)
    expect(harnessBridge({
      kind: "session",
      ref: {
        sessionId: "ses_1",
        host: "central",
      },
    })).toBe(false)
  })

  test("resolves harness identity from draft targets and session refs", () => {
    expect(composerHarnessId({
      kind: "draft",
      target: {
        worktree: "main",
        workspaceKind: "local",
        signedControlPlane: false,
        harness: { id: "codex-acp" },
      },
    })).toBe("codex-acp")

    expect(composerHarness({
      kind: "session",
      ref: {
        sessionId: "ses_1",
        host: "central",
        harness: { id: "claude-acp", binary: "claude" },
      },
    })).toEqual({ id: "claude-acp", binary: "claude" })

    expect(isComposerHarnessMode({
      kind: "draft",
      target: undefined,
    })).toBe(false)
  })

  test("non-capture modes allow image or comment-only submit starts", () => {
    const mode: ComposerMode = {
      kind: "draft",
      target: {
        worktree: "main",
        workspaceKind: "local",
        signedControlPlane: false,
      },
    }

    expect(canStartSubmit(mode, { bodyMd: "", imageCount: 1 })).toBe(true)
    expect(canStartSubmit(mode, { bodyMd: "", commentCount: 1 })).toBe(true)
    expect(canStartSubmit(mode, { bodyMd: "" })).toBe(false)
  })
})
