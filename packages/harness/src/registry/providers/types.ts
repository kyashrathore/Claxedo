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
  resolve(input: { descriptor: HarnessConnectionDescriptor<TConfig>; directory: string; secrets: Readonly<Record<string, string>> }): { config: TResolved }
  createTransport(input: { descriptor: HarnessConnectionDescriptor<TConfig>; resolved: { config: TResolved }; services: HarnessServices }): HarnessTransport
}

export function transportNotBuilt(providerKey: string): never {
  throw new TransportError("provider", "transport_not_built", `${providerKey} transport is not built yet`)
}
