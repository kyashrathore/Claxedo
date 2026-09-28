import type { AcpScript } from "./script"

export function deliveredUsage(usage: AcpScript["usage"]) {
  return process.env.H13_DROP_ACP_USAGE === "1" ? undefined : usage
}
