import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import type { HarnessServices } from "../../contract/services"
import type { HarnessTransport } from "../../contract/transport"
import { TransportError } from "../../contract/errors"

export type HarnessConnectionDescriptor<TConfig = unknown> = {
  connectionId: string
  providerKey: string
  configRevision: number
  enabled: boolean
  config: TConfig
  secretRefs?: Readonly<Record<string, string>>
}

export type ConnectionProviderProjection = Omit<HarnessConnectionRef, "connectionId" | "enabled">

export type CustomHarnessProvider<TConfig, TResolved = TConfig> = {
  providerKey: string
  validateConfig(input: unknown): TConfig
  immutableIdentity(config: TConfig): string
  project(config: TConfig): ConnectionProviderProjection
  resolve(input: { descriptor: HarnessConnectionDescriptor<TConfig>; directory: string; secrets: Readonly<Record<string, string>> }): ResolvedConnection<TResolved>
  createTransport(input: { descriptor: HarnessConnectionDescriptor<TConfig>; expectedRevision: number; resolved: ResolvedConnection<TResolved>; services: HarnessServices }): HarnessTransport
}

export type ConstructTransport<TConfig> = (config: TConfig, services: HarnessServices) => HarnessTransport

export type ConnectionConfigHooks<TConfig> = Pick<CustomHarnessProvider<TConfig>, "providerKey" | "validateConfig" | "project">
  & Partial<Pick<CustomHarnessProvider<TConfig>, "immutableIdentity">>

export type ResolvedConnection<TConfig> = { connectionId: string; configRevision: number; config: TConfig }

export function assertCurrentConnection<TConfig, TResolved>(input: {
  descriptor: HarnessConnectionDescriptor<TConfig>
  expectedRevision: number
  resolved: ResolvedConnection<TResolved>
}, providerKey: string): void {
  const { descriptor, expectedRevision, resolved } = input
  if (descriptor.providerKey !== providerKey || !descriptor.enabled || descriptor.configRevision !== expectedRevision ||
    resolved.connectionId !== descriptor.connectionId || resolved.configRevision !== expectedRevision) {
    throw new TransportError("provider", "connection_unavailable", `${providerKey} connection is disabled or stale`)
  }
}
