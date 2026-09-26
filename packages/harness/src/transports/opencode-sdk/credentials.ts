import { isProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { MachineLoginPolicy, StartInput } from "../../contract"
import type { ProviderBinding } from "./provider-binding"
import { TransportError } from "../../contract/errors.js"
import { ownerMayUseMachineLogin, providerPlaceholder } from "../../contract"

type BindingInput = Pick<StartInput, "owner" | "locality" | "credentials">

function unboundProviders(input: Pick<StartInput, "owner">, login: MachineLoginPolicy): ProviderBinding["unbound"] {
  return ownerMayUseMachineLogin(input.owner, login) ? "engine" : "disabled"
}

export function engineProviderBinding(input: BindingInput, login: MachineLoginPolicy): ProviderBinding {
  return {
    overlays: Object.fromEntries(Object.entries(input.credentials.providers).map(([id, row]) => [id, providerPlaceholder(row)])),
    unbound: unboundProviders(input, login),
  }
}

export function engineProviderBindingKey(input: BindingInput, login: MachineLoginPolicy): string {
  const binding = engineProviderBinding(input, login)
  return JSON.stringify([binding.unbound, Object.entries(binding.overlays).sort(([left], [right]) => left.localeCompare(right))])
}

export function assertProviderAvailable(input: BindingInput, providerID: string, login: MachineLoginPolicy): void {
  const selected = input.credentials.providers[providerID]
  if (selected && isProviderUnavailable(selected)) {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} is unavailable: ${selected.reason}`)
  }
  if (!selected && unboundProviders(input, login) === "disabled") {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} has no selected account for this owner`)
  }
}
