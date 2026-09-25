import { isProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../../contract"
import type { ProviderBindingOverlay } from "./provider-binding"
import { TransportError } from "../../contract/errors.js"
import { providerPlaceholder } from "../../contract"

export function providerOverlays(credentials: ResolvedCredentials): Record<string, ProviderBindingOverlay> {
  return Object.fromEntries(Object.entries(credentials.providers).map(([id, row]) => [id,
    providerPlaceholder(row),
  ]))
}

export function assertProviderAvailable(credentials: ResolvedCredentials, providerID: string): void {
  const selected = credentials.providers[providerID]
  if (selected && isProviderUnavailable(selected)) {
    throw new TransportError("opencode", "configuration", `OpenCode provider ${providerID} is unavailable: ${selected.reason}`)
  }
}
