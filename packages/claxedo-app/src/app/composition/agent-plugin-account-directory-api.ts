import { plainHostedInput } from "./agent-plugin-account-api"
import type { AccountPort, HostedOperationName } from "@/platform/account/account-port"
import type { AgentPluginStatusResult } from "@/features/agent-plugins/api"
import {
  DirectorySourceError,
  type DirectoryApi,
  type DirectorySource,
  type DirectorySourceDiagnostic,
  type DirectorySourceRegistration,
  type MachineInstalled,
} from "@/features/agent-plugins/directory/data"

async function run(
  account: AccountPort,
  operation: HostedOperationName,
  input?: Record<string, unknown>,
): Promise<AgentPluginStatusResult> {
  return await account.run<AgentPluginStatusResult>(operation, plainHostedInput(input))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sourceKind(value: unknown): value is DirectorySource["kind"] {
  return value === "claxedo" || value === "personal" || value === "organization"
}

function directorySource(value: unknown): DirectorySource | undefined {
  if (!record(value)
    || typeof value.id !== "string"
    || !sourceKind(value.kind)
    || typeof value.label !== "string"
    || typeof value.repository !== "string"
    || typeof value.ref !== "string"
    || typeof value.canRemove !== "boolean") return undefined
  const authority = value.authority === "user" || value.authority === "organization" ? value.authority : undefined
  return {
    id: value.id,
    kind: value.kind,
    label: value.label,
    repository: value.repository,
    ref: value.ref,
    ...(authority ? { authority } : {}),
    canRemove: value.canRemove,
  }
}

function diagnostics(value: unknown): DirectorySourceDiagnostic[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => record(item)
    && typeof item.sourceId === "string"
    && typeof item.relativePath === "string"
    && typeof item.code === "string"
    && typeof item.message === "string"
    ? [{ sourceId: item.sourceId, relativePath: item.relativePath, code: item.code, message: item.message }]
    : [])
}

function ok(result: AgentPluginStatusResult) {
  return result.status >= 200 && result.status < 300
}

/**
 * A non-2xx status result becomes a thrown `DirectorySourceError`, never a
 * status object handed back to the caller — `DirectoryApi` is the same
 * contract the fetch-backed `directoryApi()` in `features/agent-plugins/
 * directory/data.ts` implements, and that contract throws so the add form can
 * catch one error type and read its `diagnostics`.
 */
function failure(result: AgentPluginStatusResult, fallback: string): DirectorySourceError {
  const body = result.body
  const error = record(body) && record(body.error) ? body.error : undefined
  const code = typeof error?.code === "string" ? error.code : `http_${result.status}`
  const message = typeof error?.message === "string" ? error.message : `${fallback} (${result.status})`
  return new DirectorySourceError(code, message, diagnostics(error?.["diagnostics"]))
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
        if (!ok(result)) throw failure(result, "Sources request failed")
        const body = result.body
        const rows = record(body) && Array.isArray(body.sources) ? body.sources : []
        return {
          sources: rows.flatMap((row) => {
            const source = directorySource(row)
            return source ? [source] : []
          }),
        }
      },
      async add(registration: DirectorySourceRegistration) {
        const result = await run(account, "agentPlugins.sources.add", registration)
        // A 422/409 diagnostic response is expected, not exceptional — a
        // repository that serves no valid plugin is the add form's most common
        // outcome, so it is decoded into `DirectorySourceError.diagnostics`
        // here rather than surfaced as an opaque thrown status.
        if (!ok(result)) throw failure(result, "Could not add source")
        const body = result.body
        const source = record(body) ? directorySource(body.source) : undefined
        if (!source) {
          throw new DirectorySourceError("invalid_response", "The source response did not match its API contract")
        }
        return { source }
      },
      async remove(id: string) {
        const result = await run(account, "agentPlugins.sources.remove", { id })
        if (!ok(result) && result.status !== 404) throw failure(result, "Could not remove source")
      },
    },
    machineInstalled,
  }
}
