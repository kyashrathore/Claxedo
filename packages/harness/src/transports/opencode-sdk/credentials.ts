import { isProviderUnavailable, type ProviderProjection } from "@claxedo/agent-runtime-contract"
import type { CustomProviderDefinition, StartInput } from "../../contract"
import type { ProviderBinding } from "./provider-binding"
import { TransportError } from "../../contract/errors.js"
import { providerPlaceholder, selectedProviderProjection } from "../../contract"

type BindingInput = Pick<StartInput, "credentials" | "providerDefinitions">

function unboundProviders(input: Pick<StartInput, "credentials">): ProviderBinding["unbound"] {
  return input.credentials.machineLoginAllowed ? "engine" : "disabled"
}

const MACHINE_ENV_REFUSED = { unavailable: true, reason: "credential_unavailable" } as const

export function definitionCredential(input: BindingInput, definition: CustomProviderDefinition): ProviderProjection | undefined {
  if (definition.credentialSource === "machine-env" && !input.credentials.machineLoginAllowed) return MACHINE_ENV_REFUSED
  return selectedProviderProjection(input.credentials, [definition.credentialProviderId])
}

export function engineProviderBinding(input: BindingInput): ProviderBinding {
  return {
    overlays: {
      ...Object.fromEntries(Object.entries(input.credentials.providers).map(([id, row]) => [id, providerPlaceholder(row)])),
      ...Object.fromEntries((input.providerDefinitions ?? []).flatMap((definition) => {
        const row = definitionCredential(input, definition)
        return row ? [[definition.id, providerPlaceholder(row)]] : []
      })),
    },
    unbound: unboundProviders(input),
  }
}

export function engineProviderBindingKey(input: BindingInput): string {
  const binding = engineProviderBinding(input)
  return JSON.stringify([binding.unbound, Object.entries(binding.overlays).sort(([left], [right]) => left.localeCompare(right))])
}

export function assertProviderAvailable(input: BindingInput, providerID: string): void {
  const definition = input.providerDefinitions?.find((candidate) => candidate.id === providerID)
  const selected = definition ? definitionCredential(input, definition) : input.credentials.providers[providerID]
  if (selected === MACHINE_ENV_REFUSED) {
    throw new TransportError("opencode", "credential_unavailable",
      `OpenCode provider ${providerID} reads its key from the machine environment, which only the machine owner's sessions may use`)
  }
  if (selected && isProviderUnavailable(selected)) {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} is unavailable: ${selected.reason}`)
  }
  if (!selected && unboundProviders(input) === "disabled") {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} has no selected account for this owner`)
  }
}
