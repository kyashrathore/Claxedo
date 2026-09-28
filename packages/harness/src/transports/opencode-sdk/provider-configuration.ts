import { errorMessage } from "@claxedo/helpers"
import { noProviderBinding } from "./provider-binding"
import { isProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { DraftLaunch } from "../../contract"
import { definitionCredential, engineProviderBinding, engineProviderBindingKey } from "./credentials"
import type { OpenCodeRuntime } from "./runtime"
import type { ProviderDefinition } from "./provider-definition"

export function engineProviderDefinitions(input: Pick<DraftLaunch, "providerDefinitions" | "credentials">): ProviderDefinition[] {
  return (input.providerDefinitions ?? []).map((definition) => ({
    id: definition.id, name: definition.name, npm: definition.npm, baseURL: definition.baseURL,
    headers: definition.headers, models: definition.models, env: [],
    enabled: !isProviderUnavailable(definitionCredential(input, definition) ?? {}),
  }))
}

export function engineProviderConfigurationKey(input: DraftLaunch): string {
  return JSON.stringify([engineProviderBindingKey(input), input.providerDefinitions ?? []])
}

export async function applyEngineProviders(runtime: OpenCodeRuntime, input: DraftLaunch, previous?: DraftLaunch): Promise<void> {
  try {
    await runtime.defineProviders(engineProviderDefinitions(input))
    await runtime.bindProviders(engineProviderBinding(input))
  } catch (cause) {
    const failures: unknown[] = []
    try { await runtime.defineProviders(previous ? engineProviderDefinitions(previous) : []) } catch (error) { failures.push(error) }
    try { await runtime.bindProviders(previous ? engineProviderBinding(previous) : noProviderBinding) } catch (error) { failures.push(error) }
    if (failures.length) throw new Error(`OpenCode provider configuration rollback failed: ${failures.map((error) => errorMessage(error)).join("; ")}`, { cause })
    throw cause
  }
}
