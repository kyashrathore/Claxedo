import type {
  ExecutionCapabilities,
  ExecutionCapabilityName,
  ExecutionCapabilityUnavailableReason,
  WorkGraphContext,
} from "../contracts"

/**
 * Optional discovery selector. `directory` scopes repository (base-revision)
 * enumeration to one project the runtime already knows about; when absent, the
 * port enumerates its boot repository exactly as before. Adapters that cannot
 * honor a directory (e.g. hosted workspaces) ignore it.
 */
export type ExecutionCapabilitiesReadInput = Readonly<{ directory?: string }>

export type ExecutionCapabilitiesPort = Readonly<{
  read(context: WorkGraphContext, input: ExecutionCapabilitiesReadInput): Promise<ExecutionCapabilities>
  refresh?(context: WorkGraphContext, input: ExecutionCapabilitiesReadInput): Promise<ExecutionCapabilities>
}>

export class ExecutionCapabilitiesUnavailableError extends Error {
  readonly code = "execution_capabilities_unavailable"

  constructor(
    readonly capability: ExecutionCapabilityName,
    readonly reason: ExecutionCapabilityUnavailableReason,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = "ExecutionCapabilitiesUnavailableError"
  }
}
