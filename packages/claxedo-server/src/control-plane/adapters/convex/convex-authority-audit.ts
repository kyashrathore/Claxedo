import type { SignedControlPlaneAuth } from "../../auth"
import { convexApi } from "./convex-authority-api"
import { requireExecutor } from "./convex-authority-executor"
import type { ConvexAuthorityInput } from "./convex-authority-types"

export function auditAuthority(input: ConvexAuthorityInput) {
  return {
    async auditDeny(auth: SignedControlPlaneAuth | undefined, args: {
      action: string
      reason: string
      workspaceId?: string
      metadata?: Record<string, unknown>
    }) {
      await requireExecutor(input, auth).mutation(convexApi.auditEvents.record, {
        action: args.action,
        result: "deny",
        reason: args.reason,
        ...(args.workspaceId ? { workspace_id: args.workspaceId } : {}),
        ...(args.metadata ? { metadata: args.metadata } : {}),
      })
    },
    async auditAllow(auth: SignedControlPlaneAuth, args: {
      action: string
      workspaceId?: string
      metadata?: Record<string, unknown>
    }) {
      await requireExecutor(input, auth).mutation(convexApi.auditEvents.record, {
        action: args.action,
        result: "allow",
        ...(args.workspaceId ? { workspace_id: args.workspaceId } : {}),
        ...(args.metadata ? { metadata: args.metadata } : {}),
      })
    },
  }
}
