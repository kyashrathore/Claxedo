import { errorMessage } from "@claxedo/helpers"
import { noProviderBinding } from "./provider-binding"
import { isProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { DraftLaunch, MachineLoginPolicy } from "../../contract"
import { definitionCredential, engineProviderBinding, engineProviderBindingKey } from "./credentials"
import type { OpenCodeRuntime } from "./runtime"
import type { ProviderDefinition } from "./provider-definition"

export function engineProviderDefinitions(input: Pick<DraftLaunch, "providerDefinitions" | "credentials" | "owner" | "locality">,
  login: MachineLoginPolicy): ProviderDefinition[] {
  return (input.providerDefinitions ?? []).map((definition) => ({
    id: definition.id, name: definition.name, npm: definition.npm, baseURL: definition.baseURL,
    headers: definition.headers, models: definition.models, env: [],
    enabled: !isProviderUnavailable(definitionCredential(input, definition, login) ?? {}),
  }))
}

export function engineProviderConfigurationKey(input: DraftLaunch, login: MachineLoginPolicy): string {
  return JSON.stringify([engineProviderBindingKey(input, login), input.providerDefinitions ?? []])
}

export async function applyEngineProviders(runtime: OpenCodeRuntime, input: DraftLaunch, login: MachineLoginPolicy, previous?: DraftLaunch): Promise<void> {
  try {
    await runtime.defineProviders(engineProviderDefinitions(input, login))
    await runtime.bindProviders(engineProviderBinding(input, login))
  } catch (cause) {
    const failures: unknown[] = []
    try { await runtime.defineProviders(previous ? engineProviderDefinitions(previous, login) : []) } catch (error) { failures.push(error) }
    try { await runtime.bindProviders(previous ? engineProviderBinding(previous, login) : noProviderBinding) } catch (error) { failures.push(error) }
    if (failures.length) throw new Error(`OpenCode provider configuration rollback failed: ${failures.map((error) => errorMessage(error)).join("; ")}`, { cause })
    throw cause
  }
}
