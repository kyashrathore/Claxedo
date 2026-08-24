import type { SandboxRef, SessionRef } from "./session-ref"

export const centralRealToolSandboxAttachTicket = "backend: central real tool sandbox attach/swap"

export type WorkspaceBacking =
  | { kind: "none"; dependency?: string }
  | { kind: "local"; cwd: string }
  | { kind: "cloud" | "user-hosted"; workspaceId: string; hostId?: string }

export function resolveWorkspaceRef(ref: SessionRef): WorkspaceBacking {
  if (!ref.toolSandbox || ref.toolSandbox.kind === "virtual") {
    return ref.host === "central" ? { kind: "none", dependency: centralRealToolSandboxAttachTicket } : { kind: "none" }
  }
  return sandboxBacking(ref.toolSandbox)
}

function sandboxBacking(sandbox: SandboxRef): WorkspaceBacking {
  if (sandbox.kind === "local") return { kind: "local", cwd: sandbox.cwd }
  if (sandbox.kind === "virtual") return { kind: "none" }
  return {
    kind: sandbox.hosting,
    workspaceId: sandbox.workspaceId,
    ...(sandbox.hostId ? { hostId: sandbox.hostId } : {}),
  }
}
