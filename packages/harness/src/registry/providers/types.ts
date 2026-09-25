import type { HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import type { HarnessServices } from "../../contract/services"
import type { HarnessTransport } from "../../contract/transport"

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
  resolve(input: { descriptor: HarnessConnectionDescriptor<TConfig>; directory: string; secrets: Readonly<Record<string, string>> }): { config: TResolved }
  createTransport(input: { descriptor: HarnessConnectionDescriptor<TConfig>; resolved: { config: TResolved }; services: HarnessServices }): HarnessTransport
}

export class HarnessProviderError extends Error {
  readonly retryable = false
  constructor(readonly code: "invalid_config" | "connection_unavailable" | "transport_not_built", message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "HarnessProviderError"
  }
}

export function transportNotBuilt(providerKey: string): never {
  throw new HarnessProviderError("transport_not_built", `${providerKey} transport is not built yet`)
}
