import type { AccountPort, HostedOperationName } from "@/platform/account/account-port"
import {
  agentPluginCatalogResult,
  agentPluginMutationResult,
  agentPluginSkillResult,
  type AgentPluginApi,
  type AgentPluginStatusResult,
} from "@/features/agent-plugins/api"

/**
 * Hosted inputs cross Electron's IPC, which structured-clones them. Catalog
 * data arrives through the query cache as Solid store proxies, and a body
 * that carries one ("harnessIds" straight from the catalog) fails with "An
 * object could not be cloned". Bodies are JSON by contract, so a JSON round
 * trip is exactly the plain copy the channel needs.
 */
export function plainHostedInput<T extends Record<string, unknown> | undefined>(input: T): T {
  return input === undefined ? input : (JSON.parse(JSON.stringify(input)) as T)
}

async function run(
  account: AccountPort,
  operation: HostedOperationName,
  input?: Record<string, unknown>,
): Promise<AgentPluginStatusResult> {
  return await account.run<AgentPluginStatusResult>(operation, plainHostedInput(input))
}

/** Signed desktop Agent Plugins client over the credential-owning AccountPort. */
export function accountAgentPluginApi(account: AccountPort): AgentPluginApi {
  return {
    async catalog(options = {}) {
      const operation: HostedOperationName = options.projectId
        ? options.refresh
          ? "agentPlugins.catalog.project.refresh"
          : "agentPlugins.catalog.project"
        : options.refresh
          ? "agentPlugins.catalog.refresh"
          : "agentPlugins.catalog"
      return agentPluginCatalogResult(await run(
        account,
        operation,
        options.projectId ? { projectId: options.projectId } : undefined,
      ))
    },
    async skill(options) {
      const operation: HostedOperationName = options.projectId ? "agentPlugins.skill.project" : "agentPlugins.skill"
      return agentPluginSkillResult(await run(account, operation, {
        pluginInstanceId: options.pluginInstanceId,
        skill: options.skill,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      }))
    },
    async activation(input) {
      return agentPluginMutationResult(await run(account, "agentPlugins.activation", input))
    },
    async organizationDefault(input) {
      return agentPluginMutationResult(await run(account, "agentPlugins.organizationDefault", input))
    },
    async update(input) {
      return agentPluginMutationResult(await run(account, "agentPlugins.update", input))
    },
  }
}
