import type { ConnectionID, WorkGraphContext } from "../contracts"

export type ConnectionCapability = "docs" | "work-source" | "channel" | "code-host"

/** Secret-bearing authorization exists only for the lifetime of a live use callback. */
export type LiveConnectionAuthorization = Readonly<{
  token: string
  tokenType: "bearer" | "basic"
  fields?: Readonly<Record<string, string>>
}>

export type ConnectionCapabilityHandle = Readonly<{
  id: ConnectionID
  integrationId: string
  capability: ConnectionCapability
  scope: "team" | "personal"
  accountLabel?: string
  withAuthorization<Result>(use: (authorization: LiveConnectionAuthorization) => Promise<Result>): Promise<Result>
  reportAuthFailure(reason: string): Promise<void>
}>

export type ResolveConnectionCapabilitiesInput = Readonly<{
  connectionIds: readonly ConnectionID[]
  capability: ConnectionCapability
}>

export type ConnectionsPort = Readonly<{
  resolveCapabilities(
    context: WorkGraphContext,
    input: ResolveConnectionCapabilitiesInput,
  ): Promise<readonly ConnectionCapabilityHandle[]>
}>
