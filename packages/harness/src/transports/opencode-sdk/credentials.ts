import { isProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../../contract"
import type { ProviderBindingOverlay } from "./provider-binding"
import { OpenCodeTransportError } from "./errors.js"

export function providerOverlays(credentials: ResolvedCredentials): Record<string, ProviderBindingOverlay> {
  return Object.fromEntries(Object.entries(credentials.providers).map(([id, row]) => [id,
    isProviderUnavailable(row) ? row : { baseURL: `${row.baseUrl}${row.apiPath ?? ""}`, apiKey: row.placeholder },
  ]))
}

export function assertProviderAvailable(credentials: ResolvedCredentials, providerID: string): void {
  const selected = credentials.providers[providerID]
  if (selected && isProviderUnavailable(selected)) {
    throw new OpenCodeTransportError("configuration", `OpenCode provider ${providerID} is unavailable: ${selected.reason}`)
  }
}
