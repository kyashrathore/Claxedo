import { describe, expect, test } from "bun:test"
import { centralSessionRef, localSessionRef, sessionRefForWorkspaceSession } from "../shell/identity/session-ref"
import { resolveRuntimeTarget } from "./workspace-runtime-request"

describe("resolveRuntimeTarget", () => {
  test("keeps central session refs on the central control plane", async () => {
    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      sessionRef: centralSessionRef({ sessionId: "ses_central" }),
    })).resolves.toBeUndefined()
  })

  test("prefers explicit session ref backing over directory sniffing", async () => {
    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      directory: "ws_wrong",
      sessionRef: sessionRefForWorkspaceSession({
        sessionId: "ses_workspace",
        workspace: {
          workspaceId: "ws_right",
          kind: "cloud",
        },
      }),
    })).resolves.toEqual({ kind: "cloud", workspaceId: "ws_right" })
  })

  test("routes local personal loopback filesystem directories to the local runtime", async () => {
    await expect(resolveRuntimeTarget({
      serverUrl: "http://127.0.0.1:3001",
      directory: "/repo/main",
    })).resolves.toEqual({ kind: "local" })
  })

  test("does not treat filesystem directories on hosted control as local runtime", async () => {
    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      directory: "/repo/main",
    })).resolves.toBeUndefined()
  })

  test("uses explicit workspace runtime inputs before resolving aliases", async () => {
    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      directory: "/repo/main",
      workspace: { kind: "user-hosted", workspaceId: "ws_user" },
    })).resolves.toEqual({ kind: "user-hosted", workspaceId: "ws_user" })

    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      workspaceId: "ws_cloud",
    })).resolves.toEqual({ kind: "cloud", workspaceId: "ws_cloud" })
  })

  test("resolves directory aliases before falling back to workspace refs", async () => {
    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      directory: "workspace:ws_alias",
      resolveWorkspaceRuntime: async () => ({ kind: "user-hosted", workspaceId: "ws_resolved" }),
    })).resolves.toEqual({ kind: "user-hosted", workspaceId: "ws_resolved" })

    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      directory: "workspace:ws_alias",
    })).resolves.toEqual({ kind: "cloud", workspaceId: "ws_alias" })
  })

  test("keeps local session refs on the loopback runtime without inventing a workspace id", async () => {
    await expect(resolveRuntimeTarget({
      serverUrl: "http://127.0.0.1:3001",
      sessionRef: localSessionRef({ sessionId: "ses_local", cwd: "/repo/main" }),
    })).resolves.toEqual({ kind: "local" })
  })

  test("treats unresolved workspace session-resource refs as relay backed unless confirmed cloud", async () => {
    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      directory: "workspace:ws_unresolved",
      workspaceId: "ws_unresolved",
      sessionResource: true,
    })).resolves.toEqual({ kind: "user-hosted", workspaceId: "ws_unresolved" })

    await expect(resolveRuntimeTarget({
      serverUrl: "https://control.example.test",
      directory: "workspace:ws_cloud",
      workspaceId: "ws_cloud",
      workspaceKind: "cloud",
      sessionResource: true,
    })).resolves.toEqual({ kind: "cloud", workspaceId: "ws_cloud" })
  })
})
