import { describe, expect, test } from "bun:test"
import { centralRealToolSandboxAttachTicket, resolveWorkspaceRef } from "./resolve-workspace-ref"
import {
  centralSessionRef,
  hasBacking,
  HARNESS_IDS,
  localSessionRef,
  retargetSessionRef,
  sameSessionRef,
  sessionKey,
  sessionHarness,
  sessionRefForWorkspaceSession,
  workspaceKey,
  type SessionRef,
} from "./session-ref"
import { isHarnessSelection } from "./harness-selection"

describe("harness-id vocabulary (single source of truth)", () => {
  test("HARNESS_IDS enumerates only supported native harnesses", () => {
    expect([...HARNESS_IDS]).toEqual(["claude", "codex", "cursor", "pi", "opencode"])
  })

  test("structured selection accepts closed native ids and opaque connections", () => {
    for (const harnessId of HARNESS_IDS) expect(isHarnessSelection({ kind: "native", harnessId })).toBe(true)
    expect(isHarnessSelection({ kind: "connection", connectionId: "team-opencode" })).toBe(true)
    expect(isHarnessSelection("opencode")).toBe(false)
    expect(isHarnessSelection({ kind: "native", harnessId: "legacy-engine" })).toBe(false)
  })
})

describe("SessionRef", () => {
  test("native and connection harnesses with the same ID remain distinct", () => {
    const native = centralSessionRef({ sessionId: "ses_1", harness: { kind: "native", harnessId: "codex" } })
    const connection = centralSessionRef({ sessionId: "ses_1", harness: { kind: "connection", connectionId: "codex" } })
    const copiedConnection = centralSessionRef({
      sessionId: "ses_1",
      harness: { connectionId: "codex", kind: "connection" },
    })

    expect(sameSessionRef(native, connection)).toBe(false)
    expect(sameSessionRef(connection, copiedConnection)).toBe(true)
    expect(sessionHarness(connection!)).toEqual({ kind: "connection", connectionId: "codex" })
  })

  test("sameSessionRef includes authoritative harness identity", () => {
    const base = centralSessionRef({ sessionId: "ses_1" })
    const pi = centralSessionRef({ sessionId: "ses_1", harness: { kind: "native", harnessId: "pi" } })

    expect(sameSessionRef(base, pi)).toBe(false)
    expect(sameSessionRef(pi, { ...pi })).toBe(true)
  })

  test("loopback-local central sessions need no directory or workspace id", () => {
    const ref: SessionRef = {
      sessionId: "central-loop-1",
      host: "central",
      toolSandbox: { kind: "virtual" },
    }

    expect(sessionKey(ref)).toBe("central-loop-1")
    expect(workspaceKey(ref)).toBeUndefined()
    expect(hasBacking(ref)).toBe(false)
    expect(resolveWorkspaceRef(ref)).toEqual({
      kind: "none",
      dependency: centralRealToolSandboxAttachTicket,
    })
  })

  test("signed web central sessions may carry workspace authz scope without real backing", () => {
    const ref: SessionRef = {
      sessionId: "signed-central",
      host: "central",
      workspaceId: "ws_authz",
      toolSandbox: { kind: "virtual" },
    }

    expect(workspaceKey(ref)).toBe("ws_authz")
    expect(hasBacking(ref)).toBe(false)
    expect(resolveWorkspaceRef(ref)).toEqual({
      kind: "none",
      dependency: centralRealToolSandboxAttachTicket,
    })
  })

  test("session identity is opaque and never depends on string shape", () => {
    const ref: SessionRef = {
      sessionId: "voice-agent/session with punctuation",
      host: "workspace",
      toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud" },
    }

    expect(sessionKey(ref)).toBe("voice-agent/session with punctuation")
    expect(workspaceKey(ref)).toBe("ws_real")
    expect(hasBacking(ref)).toBe(true)
    expect(resolveWorkspaceRef(ref)).toEqual({ kind: "cloud", workspaceId: "ws_real" })
  })

  test("workspace refs use explicit workspace backing instead of directory shape", () => {
    const ref = sessionRefForWorkspaceSession({
      sessionId: "ses_workspace",
      directory: "opaque-directory",
      workspace: { workspaceId: "ws_real", kind: "cloud", hostId: "host_1" },
    })

    expect(ref).toEqual({
      sessionId: "ses_workspace",
      host: "workspace",
      workspaceId: "ws_real",
      toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud", hostId: "host_1" },
    })
    expect(ref && resolveWorkspaceRef(ref)).toEqual({ kind: "cloud", workspaceId: "ws_real", hostId: "host_1" })
  })

  test("local refs represent filesystem directories as local backing", () => {
    const ref = localSessionRef({
      sessionId: "ses_local",
      cwd: "/repo/main",
    })

    expect(ref).toEqual({
      sessionId: "ses_local",
      host: "workspace",
      cwd: "/repo/main",
      toolSandbox: { kind: "local", cwd: "/repo/main" },
    })
    expect(ref && resolveWorkspaceRef(ref)).toEqual({ kind: "local", cwd: "/repo/main" })
  })

  test("workspace refs avoid inventing backing for unknown directory-like scopes", () => {
    expect(
      sessionRefForWorkspaceSession({
        sessionId: "ses_unknown",
        directory: "workspace:ws_missing_inventory",
      }),
    ).toBeUndefined()
  })

  test("workspace refs do not invent central virtual sessions when there is no backing", () => {
    expect(sessionRefForWorkspaceSession({ sessionId: "ses_central" })).toBeUndefined()
  })

  test("central refs are explicit virtual sessions", () => {
    const ref = centralSessionRef({ sessionId: "ses_central" })

    expect(ref).toEqual({
      sessionId: "ses_central",
      host: "central",
      toolSandbox: { kind: "virtual" },
    })
    expect(ref && resolveWorkspaceRef(ref)).toEqual({
      kind: "none",
      dependency: centralRealToolSandboxAttachTicket,
    })
  })

  test("session harness stays unresolved when no authority supplied one", () => {
    const ref = centralSessionRef({ sessionId: "ses_central" })

    expect(ref).toEqual({
      sessionId: "ses_central",
      host: "central",
      toolSandbox: { kind: "virtual" },
    })
    expect(ref && sessionHarness(ref)).toBeUndefined()
  })

  test("constructors preserve explicit harness identity", () => {
    expect(
      centralSessionRef({
        sessionId: "ses_central",
        harness: { id: "acp:claude", binary: "/tmp/claude-agent-acp" },
      }),
    ).toMatchObject({
      harness: { id: "acp:claude", binary: "/tmp/claude-agent-acp" },
    })
    expect(
      sessionRefForWorkspaceSession({
        sessionId: "ses_workspace",
        directory: "opaque-directory",
        workspace: { workspaceId: "ws_real", kind: "cloud" },
        harness: { id: "acp:codex" },
      }),
    ).toMatchObject({
      harness: { id: "acp:codex" },
    })
    expect(
      localSessionRef({
        sessionId: "ses_local",
        cwd: "/repo/main",
        harness: { kind: "native", harnessId: "pi" },
      }),
    ).toMatchObject({
      harness: { kind: "native", harnessId: "pi" },
    })
  })

  test("retargeting preserves workspace backing for adjacent session opens", () => {
    expect(
      retargetSessionRef({
        sessionId: "ses_next",
        source: {
          sessionId: "ses_current",
          host: "workspace",
          workspaceId: "ws_real",
          toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud", hostId: "host_1" },
        },
      }),
    ).toEqual({
      sessionId: "ses_next",
      host: "workspace",
      workspaceId: "ws_real",
      toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud", hostId: "host_1" },
    })
  })

  test("retargeting preserves source harness identity", () => {
    expect(
      retargetSessionRef({
        sessionId: "ses_next",
        source: {
          sessionId: "ses_current",
          host: "workspace",
          workspaceId: "ws_real",
          toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud" },
          harness: { id: "acp:cursor", binary: "/tmp/cursor-agent" },
        },
      }),
    ).toMatchObject({
      sessionId: "ses_next",
      harness: { id: "acp:cursor", binary: "/tmp/cursor-agent" },
    })
  })

  test("retargeting preserves local backing for adjacent session opens", () => {
    expect(
      retargetSessionRef({
        sessionId: "ses_next",
        source: {
          sessionId: "ses_current",
          host: "workspace",
          cwd: "/repo/main",
          toolSandbox: { kind: "local", cwd: "/repo/main" },
        },
      }),
    ).toEqual({
      sessionId: "ses_next",
      host: "workspace",
      cwd: "/repo/main",
      toolSandbox: { kind: "local", cwd: "/repo/main" },
    })
  })

  test("retargeting does not derive backing when no source ref exists", () => {
    expect(
      retargetSessionRef({
        sessionId: "ses_next",
      }),
    ).toBeUndefined()
  })
})
