import { HARNESS_TABLE, PI_PROVIDER_LABELS } from "@claxedo/agent-runtime-contract"

const VENDOR_NAMES: ReadonlyMap<string, string> = new Map([
  ...Object.entries(PI_PROVIDER_LABELS),
  [HARNESS_TABLE.cursor.vendorProvider, HARNESS_TABLE.cursor.vendor],
])

export function vendorName(providerId: string): string {
  return VENDOR_NAMES.get(providerId) ?? providerId
}
