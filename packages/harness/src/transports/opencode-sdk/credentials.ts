import { isProviderUnavailable, type ProviderProjection } from "@claxedo/agent-runtime-contract"
import type { CustomProviderDefinition, MachineLoginPolicy, StartInput } from "../../contract"
import type { ProviderBinding } from "./provider-binding"
import { TransportError } from "../../contract/errors.js"
import { ownerMayUseMachineLogin, providerPlaceholder } from "../../contract"

type BindingInput = Pick<StartInput, "owner" | "locality" | "credentials" | "providerDefinitions">

function unboundProviders(input: Pick<StartInput, "owner">, login: MachineLoginPolicy): ProviderBinding["unbound"] {
  return ownerMayUseMachineLogin(input.owner, login) ? "engine" : "disabled"
}

const MACHINE_ENV_REFUSED = { unavailable: true, reason: "credential_unavailable" } as const

export function definitionCredential(input: BindingInput, definition: CustomProviderDefinition, login: MachineLoginPolicy): ProviderProjection | undefined {
  if (definition.credentialSource === "machine-env" && !ownerMayUseMachineLogin(input.owner, login)) return MACHINE_ENV_REFUSED
  return input.credentials.providers[definition.credentialProviderId]
}

export function engineProviderBinding(input: BindingInput, login: MachineLoginPolicy): ProviderBinding {
  return {
    overlays: {
      ...Object.fromEntries(Object.entries(input.credentials.providers).map(([id, row]) => [id, providerPlaceholder(row)])),
      ...Object.fromEntries((input.providerDefinitions ?? []).flatMap((definition) => {
        const row = definitionCredential(input, definition, login)
        return row ? [[definition.id, providerPlaceholder(row)]] : []
      })),
    },
    unbound: unboundProviders(input, login),
  }
}

export function engineProviderBindingKey(input: BindingInput, login: MachineLoginPolicy): string {
  const binding = engineProviderBinding(input, login)
  return JSON.stringify([binding.unbound, Object.entries(binding.overlays).sort(([left], [right]) => left.localeCompare(right))])
}

export function assertProviderAvailable(input: BindingInput, providerID: string, login: MachineLoginPolicy): void {
  const definition = input.providerDefinitions?.find((candidate) => candidate.id === providerID)
  const selected = definition ? definitionCredential(input, definition, login) : input.credentials.providers[providerID]
  if (selected === MACHINE_ENV_REFUSED) {
    throw new TransportError("opencode", "credential_unavailable",
      `OpenCode provider ${providerID} reads its key from the machine environment, which only the machine owner's sessions may use`)
  }
  if (selected && isProviderUnavailable(selected)) {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} is unavailable: ${selected.reason}`)
  }
  if (!selected && unboundProviders(input, login) === "disabled") {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} has no selected account for this owner`)
  }
}
