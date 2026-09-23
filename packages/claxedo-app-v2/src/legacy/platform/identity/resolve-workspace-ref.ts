import type { SandboxRef, SessionRef } from "./session-ref"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"

export type WorkspaceBacking =
  | { kind: "none"; dependency?: string }
  | { kind: "self"; cwd: string }
  | { kind: RelayHostKind; workspaceId: string; hostId?: string }

export function resolveWorkspaceRef(ref: SessionRef): WorkspaceBacking {
  if (!ref.toolSandbox) return { kind: "none" }
  return sandboxBacking(ref.toolSandbox)
}

function sandboxBacking(sandbox: SandboxRef): WorkspaceBacking {
  if (sandbox.kind === "local") return { kind: "self", cwd: sandbox.cwd }
  return {
    kind: sandbox.hosting,
    workspaceId: sandbox.workspaceId,
    ...(sandbox.hostId ? { hostId: sandbox.hostId } : {}),
  }
}
