import { plainHostedInput } from "./agent-plugin-account-api"
import type { AccountPort, HostedOperationName } from "@/platform/account/account-port"
import type { AgentPluginStatusResult } from "@/features/agent-plugins/api"
import { decodeHostedResult, type DecodedHostedResult } from "@/platform/account/hosted-operations"
import {
  directorySourceFailure,
  parseDirectorySourceList,
  parseDirectorySourceResponse,
  type DirectoryApi,
  type DirectorySourceRegistration,
  type MachineInstalled,
} from "@/features/agent-plugins/directory/data"

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

function ok(result: AgentPluginStatusResult) {
  return result.status >= 200 && result.status < 300
}

/**
 * Signed desktop Directory client over the credential-owning AccountPort.
 *
 * `machineInstalled` is a LOCAL-rail read (`~/.claude`, `~/.cursor`,
 * `$CODEX_HOME`) that only the machine's own sidecar can answer — there is no
 * hosted operation for it, so it is injected rather than resolved here.
 */
export function accountDirectoryApi(
  account: AccountPort,
  machineInstalled: () => Promise<MachineInstalled>,
): DirectoryApi {
  return {
    sources: {
      async list() {
        const result = await run(account, "agentPlugins.sources.list")
        if (!ok(result)) throw directorySourceFailure(result.status, result.body, "Sources request failed")
        return parseDirectorySourceList(result.body)
      },
      async add(registration: DirectorySourceRegistration) {
        const result = await run(account, "agentPlugins.sources.add", registration)
        // A 422/409 diagnostic response is expected, not exceptional — a
        // repository that serves no valid plugin is the add form's most common
        // outcome, so it is decoded into `DirectorySourceError.diagnostics`
        // here rather than surfaced as an opaque thrown status.
        if (!ok(result)) throw directorySourceFailure(result.status, result.body, "Could not add source")
        return parseDirectorySourceResponse(result.body)
      },
      async remove(id: string) {
        const result = await run(account, "agentPlugins.sources.remove", { id })
        if (!ok(result) && result.status !== 404) throw directorySourceFailure(result.status, result.body, "Could not remove source")
      },
    },
    machineInstalled,
  }
}
