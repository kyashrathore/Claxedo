import { describe, expect, test } from "bun:test"
import {
  localSessionRef,
  localSessionRefForDirectory,
  retargetSessionRef,
  sessionRefForWorkspaceSession,
  type SessionRef,
} from "./session-ref"

describe("SessionRef cwd invariants", () => {
  test("localSessionRef accepts filesystem directories", () => {
    expect(localSessionRef({ sessionId: "ses_posix", cwd: "/repo/main" })).toMatchObject({
      cwd: "/repo/main",
      toolSandbox: { kind: "local", cwd: "/repo/main" },
    })
    expect(localSessionRef({ sessionId: "ses_windows", cwd: "C:\\Users\\me\\repo" })).toMatchObject({
      cwd: "C:\\Users\\me\\repo",
      toolSandbox: { kind: "local", cwd: "C:\\Users\\me\\repo" },
    })
  })

  test("localSessionRef rejects opaque or missing directories", () => {
    for (const cwd of ["relative/path", "ws_1", "workspace:ws_1", "", undefined]) {
      expect(localSessionRef({ sessionId: "ses_local", cwd })).toBeUndefined()
    }
  })

  test("localSessionRefForDirectory does not invent local backing for opaque directories", () => {
    for (const directory of ["relative/path", "ws_1", "workspace:ws_1", "", undefined]) {
      expect(localSessionRefForDirectory({ sessionId: "ses_local", directory })).toBeUndefined()
    }
  })

  test("sessionRefForWorkspaceSession keeps explicit workspace backing for opaque directories", () => {
    expect(sessionRefForWorkspaceSession({
      sessionId: "ses_workspace",
      directory: "workspace:ws_1",
      workspace: { workspaceId: "ws_1", kind: "cloud" },
    })).toEqual({
      sessionId: "ses_workspace",
      host: "workspace",
      workspaceId: "ws_1",
      toolSandbox: { kind: "workspace", workspaceId: "ws_1", hosting: "cloud" },
    })
  })

  test("retargetSessionRef preserves valid local backing and rejects invalid local backing", () => {
    expect(retargetSessionRef({
      sessionId: "ses_next",
      source: localSessionRef({ sessionId: "ses_current", cwd: "/repo/main" }),
    })).toEqual(localSessionRef({ sessionId: "ses_next", cwd: "/repo/main" }))

    expect(retargetSessionRef({
      sessionId: "ses_next",
      source: {
        sessionId: "ses_current",
        host: "workspace",
        cwd: "relative/path",
        toolSandbox: { kind: "local", cwd: "relative/path" },
      } satisfies SessionRef,
    })).toBeUndefined()
  })
})
