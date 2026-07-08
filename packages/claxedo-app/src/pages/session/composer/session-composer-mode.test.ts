import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { workspaceBackedSessionRef } from "@/shell/identity/session-ref"
import {
  createSessionComposerModes,
  newSessionComposerMode,
  sessionComposerMode,
} from "./session-composer-mode"

describe("session composer mode", () => {
  test("builds an isolated draft composer mode without the app shell", () => {
    expect(newSessionComposerMode({
      directory: "/repo",
      draftId: "pane_1",
      signedControlPlane: true,
      workspaceId: "ws_1",
      workspaceKind: "user-hosted",
      worktree: "feature",
    })).toEqual({
      kind: "draft",
      draftId: "pane_1",
      target: {
        directory: "/repo",
        worktree: "feature",
        workspaceKind: "user-hosted",
        signedControlPlane: true,
        workspaceId: "ws_1",
      },
    })
  })

  test("uses a routed session ref when the composer is attached to an existing session", () => {
    const ref = workspaceBackedSessionRef({
      sessionId: "ses_1",
      workspace: { workspaceId: "ws_1", kind: "cloud" },
    })!

    expect(sessionComposerMode({
      directory: "/repo",
      sessionId: "new",
      sessionRef: ref,
      draft: newSessionComposerMode({
        directory: "/repo",
        signedControlPlane: false,
        workspaceKind: "local",
        worktree: "main",
      }),
    })).toEqual({ kind: "session", ref })
  })

  test("falls back to the draft mode for new or missing sessions", () => {
    const draft = newSessionComposerMode({
      directory: "/repo",
      signedControlPlane: false,
      workspaceKind: "local",
      worktree: "main",
    })

    expect(sessionComposerMode({ directory: "/repo", sessionId: undefined, sessionRef: undefined, draft })).toBe(draft)
    expect(sessionComposerMode({ directory: "/repo", sessionId: "new", sessionRef: undefined, draft })).toBe(draft)
  })

  test("constructs local or central session mode without route params or providers", () => {
    const local = sessionComposerMode({
      directory: "/repo",
      sessionId: "ses_local",
      sessionRef: undefined,
      draft: newSessionComposerMode({
        directory: "/repo",
        signedControlPlane: false,
        workspaceKind: "local",
        worktree: "main",
      }),
    })

    expect(local).toEqual({
      kind: "session",
      ref: {
        sessionId: "ses_local",
        host: "workspace",
        cwd: "/repo",
        toolSandbox: { kind: "local", cwd: "/repo" },
      },
    })

    expect(sessionComposerMode({
      directory: "workspace:ws_1",
      sessionId: "ses_remote",
      sessionRef: undefined,
      workspaceId: "ws_1",
      draft: newSessionComposerMode({
        directory: "workspace:ws_1",
        signedControlPlane: true,
        workspaceId: "ws_1",
        workspaceKind: "cloud",
        worktree: "main",
      }),
    })).toEqual({
      kind: "session",
      ref: {
        sessionId: "ses_remote",
        host: "central",
        workspaceId: "ws_1",
        toolSandbox: { kind: "virtual" },
      },
    })
  })

  test("derives draft and current composer modes in isolation", () => {
    createRoot((dispose) => {
      const modes = createSessionComposerModes({
        directory: () => "/repo",
        draftId: () => "pane_1",
        sessionId: () => "new",
        sessionRef: () => undefined,
        signedControlPlane: () => false,
        workspaceId: () => undefined,
        workspaceKind: () => "local",
        worktree: () => "main",
      })

      expect(modes.draft()).toEqual({
        kind: "draft",
        draftId: "pane_1",
        target: {
          directory: "/repo",
          worktree: "main",
          workspaceKind: "local",
          signedControlPlane: false,
        },
      })
      expect(modes.current()).toBe(modes.draft())

      dispose()
    })
  })
})
