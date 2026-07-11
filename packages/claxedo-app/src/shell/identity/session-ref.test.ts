import { describe, expect, test } from "bun:test"
import { centralRealToolSandboxAttachTicket, resolveWorkspaceRef } from "./resolve-workspace-ref"
import {
  centralSessionRef,
  hasBacking,
  HARNESS_IDS,
  isHarnessId,
  localSessionRef,
  retargetSessionRef,
  sessionKey,
  sessionHarness,
  sessionRefForWorkspaceSession,
  workspaceKey,
  type HarnessId,
  type SessionRef,
} from "./session-ref"

describe("harness-id vocabulary (single source of truth)", () => {
  test("HARNESS_IDS enumerates all eight canonical harness kinds", () => {
    expect([...HARNESS_IDS]).toEqual([
      "claude-acp",
      "codex-acp",
      "cursor-acp",
      "claude-sdk",
      "codex-app-server",
      "cursor-sdk",
      "opencode",
      "pi",
    ])
  })

  test("isHarnessId accepts every canonical kind, including pi and cursor-sdk", () => {
    for (const id of HARNESS_IDS) expect(isHarnessId(id)).toBe(true)
    expect(isHarnessId("pi")).toBe(true)
    expect(isHarnessId("cursor-sdk")).toBe(true)
  })

  test("isHarnessId rejects unknown, renamed, and non-string values", () => {
    expect(isHarnessId("not-a-harness")).toBe(false)
    expect(isHarnessId("claude")).toBe(false)
    expect(isHarnessId("")).toBe(false)
    expect(isHarnessId(undefined)).toBe(false)
    expect(isHarnessId(42)).toBe(false)
  })

  test("isHarnessId narrows an unknown string to HarnessId", () => {
    const raw: unknown = "pi"
    if (isHarnessId(raw)) {
      const id: HarnessId = raw
      expect(id).toBe("pi")
    } else {
      throw new Error("expected 'pi' to be a valid HarnessId")
    }
  })
})

describe("SessionRef", () => {
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
    expect(sessionRefForWorkspaceSession({
      sessionId: "ses_unknown",
      directory: "workspace:ws_missing_inventory",
    })).toBeUndefined()
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

  test("session harness defaults to opencode without materializing on refs", () => {
    const ref = centralSessionRef({ sessionId: "ses_central" })

    expect(ref).toEqual({
      sessionId: "ses_central",
      host: "central",
      toolSandbox: { kind: "virtual" },
    })
    expect(ref && sessionHarness(ref)).toEqual({ id: "opencode" })
  })

  test("constructors preserve explicit harness identity", () => {
    expect(centralSessionRef({
      sessionId: "ses_central",
      harness: { id: "claude-acp", binary: "/tmp/claude-agent-acp" },
    })).toMatchObject({
      harness: { id: "claude-acp", binary: "/tmp/claude-agent-acp" },
    })
    expect(sessionRefForWorkspaceSession({
      sessionId: "ses_workspace",
      directory: "opaque-directory",
      workspace: { workspaceId: "ws_real", kind: "cloud" },
      harness: { id: "codex-acp" },
    })).toMatchObject({
      harness: { id: "codex-acp" },
    })
    expect(localSessionRef({
      sessionId: "ses_local",
      cwd: "/repo/main",
      harness: { id: "pi" },
    })).toMatchObject({
      harness: { id: "pi" },
    })
  })

  test("retargeting preserves workspace backing for adjacent session opens", () => {
    expect(retargetSessionRef({
      sessionId: "ses_next",
      source: {
        sessionId: "ses_current",
        host: "workspace",
        workspaceId: "ws_real",
        toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud", hostId: "host_1" },
      },
    })).toEqual({
      sessionId: "ses_next",
      host: "workspace",
      workspaceId: "ws_real",
      toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud", hostId: "host_1" },
    })
  })

  test("retargeting preserves source harness identity", () => {
    expect(retargetSessionRef({
      sessionId: "ses_next",
      source: {
        sessionId: "ses_current",
        host: "workspace",
        workspaceId: "ws_real",
        toolSandbox: { kind: "workspace", workspaceId: "ws_real", hosting: "cloud" },
        harness: { id: "cursor-acp", binary: "/tmp/cursor-agent" },
      },
    })).toMatchObject({
      sessionId: "ses_next",
      harness: { id: "cursor-acp", binary: "/tmp/cursor-agent" },
    })
  })

  test("retargeting preserves local backing for adjacent session opens", () => {
    expect(retargetSessionRef({
      sessionId: "ses_next",
      source: {
        sessionId: "ses_current",
        host: "workspace",
        cwd: "/repo/main",
        toolSandbox: { kind: "local", cwd: "/repo/main" },
      },
    })).toEqual({
      sessionId: "ses_next",
      host: "workspace",
      cwd: "/repo/main",
      toolSandbox: { kind: "local", cwd: "/repo/main" },
    })
  })

  test("retargeting does not derive backing when no source ref exists", () => {
    expect(retargetSessionRef({
      sessionId: "ses_next",
    })).toBeUndefined()
  })
})
