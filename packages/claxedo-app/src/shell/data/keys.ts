import { sessionKey, workspaceKey, type SessionRef } from "../identity/session-ref"

type Brand<T, Name extends string> = T & { readonly __scope: Name }

export type SessionScopedQueryKey = Brand<readonly ["shell", "session", string, ...ReadonlyArray<unknown>], "session">
export type WorkspaceScopedQueryKey = Brand<readonly ["shell", "workspace", string, ...ReadonlyArray<unknown>], "workspace">

export const shellDataKeys = {
  sessionId: (sessionId: string, ...parts: ReadonlyArray<unknown>) =>
    // as-any: brands the constructed query-key tuple after the literal prefix is fixed.
    ["shell", "session", sessionId, ...parts] as unknown as SessionScopedQueryKey,
  session: (ref: SessionRef, ...parts: ReadonlyArray<unknown>) =>
    shellDataKeys.sessionId(sessionKey(ref), ...parts),
  workspace: (workspaceId: string, ...parts: ReadonlyArray<unknown>) =>
    // as-any: brands the constructed query-key tuple after the literal prefix is fixed.
    ["shell", "workspace", workspaceId, ...parts] as unknown as WorkspaceScopedQueryKey,
  workspaceForSession(ref: SessionRef, ...parts: ReadonlyArray<unknown>) {
    const key = workspaceKey(ref)
    if (!key) throw new Error("workspace-scoped query requires workspaceId")
    return shellDataKeys.workspace(key, ...parts)
  },
}
