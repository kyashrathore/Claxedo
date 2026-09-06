import type { AccountPort, HostedOperationName } from "@/platform/account/account-port"
import {
  agentPluginCatalogResult,
  agentPluginMutationResult,
  agentPluginSkillResult,
  type AgentPluginApi,
} from "@/features/agent-plugins/api"
import { recordOrEmpty } from "@/lib/record"
import { decodeHostedResult, type DecodedHostedResult } from "@/platform/account/hosted-operations"

/**
 * Hosted inputs cross Electron's IPC, which structured-clones them. Catalog
 * data arrives through the query cache as Solid store proxies, and a body
 * that carries one ("harnessIds" straight from the catalog) fails with "An
 * object could not be cloned". Bodies are JSON by contract, so a JSON round
 * trip is exactly the plain copy the channel needs.
 */
export function plainHostedInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return input === undefined ? input : recordOrEmpty(JSON.parse(JSON.stringify(input)))
}

async function run<N extends HostedOperationName>(
  account: AccountPort,
  operation: N,
  input?: Record<string, unknown>,
): Promise<DecodedHostedResult<N>> {
  // `AccountPort.run` answers `unknown`; the operation's own decoder in
  // `HOSTED_OPERATIONS` (`statusResult` for every Agent Plugins op) is what
  // turns it back into a status envelope, and names the operation when the
  // hosted side answers with something else. The name is a type parameter so
  // the envelope is READ OFF that decoder rather than declared here — a caller
  // naming an operation decoded some other way is a compile error, not a shape
  // that arrives wearing a status it never had.
  return decodeHostedResult(operation, await account.run(operation, plainHostedInput(input)))
}

/** Signed desktop Agent Plugins client over the credential-owning AccountPort. */
export function accountAgentPluginApi(account: AccountPort): AgentPluginApi {
  return {
    async catalog(options = {}) {
      const operation = options.projectId
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
      const operation = options.projectId ? "agentPlugins.skill.project" : "agentPlugins.skill"
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
