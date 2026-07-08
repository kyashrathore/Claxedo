import type { SignedControlPlaneAuth } from "../../auth"
import { convexApi } from "./convex-authority-api"
import { requireAllowed, requireExecutor, requireServiceToken } from "./convex-authority-executor"
import type { ConvexAuthorityInput } from "./convex-authority-types"

export function agentExtensionAuthority(input: ConvexAuthorityInput) {
  return {
    async listWorkspaceAgentExtensions(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      return requireExecutor(input, auth).query(convexApi.agentExtensions.list, {
        workspace_id: args.workspaceId,
      })
    },
    async listWorkspaceAgentExtensionsForRuntime(args: {
      workspaceId: string
    }) {
      return requireExecutor(input, undefined, { allowUnsigned: true }).query(convexApi.agentExtensions.listForRuntime, {
        workspace_id: args.workspaceId,
        service_token: requireServiceToken(input),
      })
    },
    async authorizeWorkspaceAgentExtensionsAdmin(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      await requireAllowed(await requireExecutor(input, auth).query(convexApi.agentExtensions.authorizeAdmin, {
        workspace_id: args.workspaceId,
      }))
    },
    async upsertWorkspaceAgentExtension(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      extensionId: string
      packageName: string
      desired: unknown
      lock: unknown
    }) {
      return requireExecutor(input, auth).mutation(convexApi.agentExtensions.upsert, {
        workspace_id: args.workspaceId,
        extension_id: args.extensionId,
        package_name: args.packageName,
        desired: args.desired,
        lock: args.lock,
      })
    },
    async setWorkspaceAgentExtensionEnabled(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      extensionId: string
      enabled: boolean
    }) {
      return requireExecutor(input, auth).mutation(convexApi.agentExtensions.setEnabled, {
        workspace_id: args.workspaceId,
        extension_id: args.extensionId,
        enabled: args.enabled,
      })
    },
    async deleteWorkspaceAgentExtension(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      extensionId: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.agentExtensions.delete, {
        workspace_id: args.workspaceId,
        extension_id: args.extensionId,
      })
    },
    async listAgentExtensionPolicyOverrides(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
    }) {
      return requireExecutor(input, auth).query(convexApi.agentExtensionPolicies.list, {
        workspace_id: args.workspaceId,
      })
    },
    async listAgentExtensionPolicyOverridesForRuntime(args: {
      workspaceId: string
    }) {
      return requireExecutor(input, undefined, { allowUnsigned: true }).query(convexApi.agentExtensionPolicies.listForRuntime, {
        workspace_id: args.workspaceId,
        service_token: requireServiceToken(input),
      })
    },
    async setAgentExtensionPolicyOverride(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      extensionId: string
      scope: "org" | "user" | "workspace"
      enabled: boolean
      reason?: string
    }) {
      return requireExecutor(input, auth).mutation(convexApi.agentExtensionPolicies.set, {
        workspace_id: args.workspaceId,
        extension_id: args.extensionId,
        scope: args.scope,
        enabled: args.enabled,
        ...(args.reason ? { reason: args.reason } : {}),
      })
    },
    async deleteAgentExtensionPolicyOverride(auth: SignedControlPlaneAuth, args: {
      workspaceId: string
      extensionId: string
      scope: "org" | "user" | "workspace"
    }) {
      return requireExecutor(input, auth).mutation(convexApi.agentExtensionPolicies.delete, {
        workspace_id: args.workspaceId,
        extension_id: args.extensionId,
        scope: args.scope,
      })
    },
  }
}
