import { decodeJwt } from "jose"
import { isPluginId } from "@claxedo/plugin-api/id"
import { workspaceRuntimePluginToolsGrantEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { credentialFault } from "@claxedo/server-core/platform/auth/runtime-token-keys"
import { mintSandboxPass, verifySandboxPass } from "@claxedo/server-core/platform/auth/sandbox-pass"
import type { SandboxPassRegister } from "@claxedo/server-core/platform/auth/sandbox-pass-register"
import type { CloudRootGrantContribution, CloudRootIdentity } from "@claxedo/server-core/plugins/server-plugin"
import { APP_PLUGIN_TOOLS_GRANT_GROUP } from "../agent-plugins/app-plugin-tool-consent"

export const PLUGIN_TOOLS_GRANT_AUDIENCE = "plugin-tools"
export const PLUGIN_TOOLS_GRANT_WITHDRAWAL = "app_plugin_disabled"
const PLUGIN_TOOLS_OPERATIONS = ["call"] as const
const PLUGINS_CLAIM = "plugins"

/** A cloud root's app plugin tools grant: the root it was minted for and the plugins whose tools it may call. */
export type PluginToolsGrantScope = CloudRootIdentity & Readonly<{ plugins: readonly string[] }>

export type PluginToolsGrantKeys = Readonly<{
  signingEnv: Record<string, string | undefined>
  passes: SandboxPassRegister
  now?: () => number
}>

/** The deployment lacks what minting or verifying needs, which is a fault rather than a bad credential. */
export class PluginToolsGrantConfigurationError extends Error {
  readonly code = "plugin_tools_grant_misconfigured"
}

const grantFault = credentialFault("Plugin tools grant", PluginToolsGrantConfigurationError)

export async function mintPluginToolsGrant(keys: PluginToolsGrantKeys, scope: PluginToolsGrantScope) {
  const { plugins, ...root } = scope
  return await mintSandboxPass(
    {
      audience: PLUGIN_TOOLS_GRANT_AUDIENCE,
      scope: root,
      operations: PLUGIN_TOOLS_OPERATIONS,
      extra: { [PLUGINS_CLAIM]: plugins.join(",") },
      register: keys.passes,
      ...(keys.now ? { now: keys.now } : {}),
    },
    keys.signingEnv,
    grantFault,
  )
}

/** Whether a bearer names this audience, read without verifying: which verifier to run, not whether to trust it. */
export function isPluginToolsGrantToken(token: string): boolean {
  try {
    return decodeJwt(token).aud === PLUGIN_TOOLS_GRANT_AUDIENCE
  } catch {
    return false
  }
}

/** The grant's scope once it verifies and its register has not revoked it; anything else throws. */
export async function verifyPluginToolsGrant(keys: PluginToolsGrantKeys, token: string): Promise<PluginToolsGrantScope> {
  const pass = await verifySandboxPass(token, keys.signingEnv, {
    audience: PLUGIN_TOOLS_GRANT_AUDIENCE,
    fault: grantFault,
    revoked: keys.passes.revoked,
    ...(keys.now ? { now: keys.now } : {}),
  })
  const claim = pass.extra[PLUGINS_CLAIM]
  const plugins = typeof claim === "string" ? claim.split(",").filter(isPluginId) : []
  const { userId, orgId, projectId, workspaceId } = pass.scope
  if (!projectId || plugins.length === 0 || pass.operations.join(",") !== PLUGIN_TOOLS_OPERATIONS.join(",")) {
    throw new Error("Plugin tools grant scope is invalid")
  }
  return { userId, orgId, projectId, workspaceId, plugins }
}

/**
 * The grant a cloud root launches with while its project has at least one app
 * plugin's tools on, naming those plugins; `toolPlugins` is the reading the
 * listing and every tool call make again for the root.
 */
export function pluginToolsRootGrant(
  keys: PluginToolsGrantKeys,
  toolPlugins: (root: CloudRootIdentity) => Promise<readonly string[]>,
): CloudRootGrantContribution {
  return {
    group: APP_PLUGIN_TOOLS_GRANT_GROUP,
    audience: PLUGIN_TOOLS_GRANT_AUDIENCE,
    withdrawalReason: PLUGIN_TOOLS_GRANT_WITHDRAWAL,
    mint: async (root) => {
      const plugins = await toolPlugins(root)
      if (plugins.length === 0) return {}
      return workspaceRuntimePluginToolsGrantEnv({ token: (await mintPluginToolsGrant(keys, { ...root, plugins })).token })
    },
  }
}
