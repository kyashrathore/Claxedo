import type { HarnessServices, HarnessTransport } from "../../contract"
import { TransportError } from "../../contract/errors"
import type { CustomHarnessProvider, HarnessConnectionDescriptor } from "./types"

export type ConnectionTransportInput = {
  descriptor: HarnessConnectionDescriptor
  expectedRevision: number
  directory: string
  secrets: Readonly<Record<string, string>>
}

function createConnection<TConfig>(services: HarnessServices, provider: CustomHarnessProvider<TConfig>, input: ConnectionTransportInput): HarnessTransport {
  const config = provider.validateConfig(input.descriptor.config)
  const descriptor = { ...input.descriptor, config }
  const resolved = provider.resolve({ descriptor, directory: input.directory, secrets: input.secrets })
  return provider.createTransport({ descriptor, expectedRevision: input.expectedRevision, resolved, services })
}

export function connectionTransport(
  services: HarnessServices,
  providers: readonly CustomHarnessProvider<unknown>[],
  input: ConnectionTransportInput,
): HarnessTransport {
  const provider = providers.find((candidate) => candidate.providerKey === input.descriptor.providerKey)
  if (!provider) throw new TransportError("provider", "connection_unavailable", `Unknown harness provider: ${input.descriptor.providerKey}`)
  return createConnection(services, provider, input)
}
