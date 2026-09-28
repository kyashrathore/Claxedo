import { isProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { StartInput } from "../../contract"
import type { ProviderBinding } from "./provider-binding"
import { TransportError } from "../../contract/errors.js"
import { providerPlaceholder } from "../../contract"

type BindingInput = Pick<StartInput, "owner" | "locality" | "credentials">

function unboundProviders(input: Pick<StartInput, "credentials">): ProviderBinding["unbound"] {
  return input.credentials.machineLoginAllowed ? "engine" : "disabled"
}

export function engineProviderBinding(input: BindingInput): ProviderBinding {
  return {
    overlays: Object.fromEntries(Object.entries(input.credentials.providers).map(([id, row]) => [id, providerPlaceholder(row)])),
    unbound: unboundProviders(input),
  }
}

export function engineProviderBindingKey(input: BindingInput): string {
  const binding = engineProviderBinding(input)
  return JSON.stringify([binding.unbound, Object.entries(binding.overlays).sort(([left], [right]) => left.localeCompare(right))])
}

export function assertProviderAvailable(input: BindingInput, providerID: string): void {
  const selected = input.credentials.providers[providerID]
  if (selected && isProviderUnavailable(selected)) {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} is unavailable: ${selected.reason}`)
  }
  if (!selected && unboundProviders(input) === "disabled") {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} has no selected account for this owner`)
  }
}
