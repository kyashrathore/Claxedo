import { Log } from "../../../platform/runtime/lib/log"

const log = Log.create({ service: "network-daytona-allow-list" })

/**
 * Format CIDRs for Daytona SDK `networkAllowList` parameter.
 * Daytona currently accepts at most 10 entries.
 */
export function formatDaytonaAllowList(cidrs: string[]): string {
  if (cidrs.length > 10) {
    log.warn("Network allowlist exceeds Daytona limit of 10 entries, truncating", {
      total: cidrs.length,
    })
  }
  return cidrs.slice(0, 10).join(",")
}
