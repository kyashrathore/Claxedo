import { sessionKey, workspaceKey, type SessionRef } from "@/platform/identity/session-ref"
import { brand, type Brand } from "@/platform/identity/brand"

export type SessionScopedQueryKey = Brand<readonly ["shell", "session", string, ...ReadonlyArray<unknown>], "session">
export type WorkspaceScopedQueryKey = Brand<readonly ["shell", "workspace", string, ...ReadonlyArray<unknown>], "workspace">

export const shellDataKeys = {
  sessionId: (sessionId: string, ...parts: ReadonlyArray<unknown>): SessionScopedQueryKey => {
    const key: readonly ["shell", "session", string, ...ReadonlyArray<unknown>] = ["shell", "session", sessionId, ...parts]
    return brand(key)
  },
  session: (ref: SessionRef, ...parts: ReadonlyArray<unknown>) =>
    shellDataKeys.sessionId(sessionKey(ref), ...parts),
  workspace: (workspaceId: string, ...parts: ReadonlyArray<unknown>): WorkspaceScopedQueryKey => {
    const key: readonly ["shell", "workspace", string, ...ReadonlyArray<unknown>] = ["shell", "workspace", workspaceId, ...parts]
    return brand(key)
  },
  workspaceForSession(ref: SessionRef, ...parts: ReadonlyArray<unknown>) {
    const key = workspaceKey(ref)
    if (!key) throw new Error("workspace-scoped query requires workspaceId")
    return shellDataKeys.workspace(key, ...parts)
  },
}
