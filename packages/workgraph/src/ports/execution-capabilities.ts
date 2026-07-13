import type {
  ExecutionCapabilities,
  ExecutionCapabilityName,
  ExecutionCapabilityUnavailableReason,
  WorkGraphContext,
} from "../contracts"

export type ExecutionCapabilitiesReadInput = Readonly<Record<string, never>>

export type ExecutionCapabilitiesPort = Readonly<{
  read(context: WorkGraphContext, input: ExecutionCapabilitiesReadInput): Promise<ExecutionCapabilities>
  probe?(context: WorkGraphContext, input: ExecutionCapabilitiesReadInput): Promise<ExecutionCapabilities>
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
