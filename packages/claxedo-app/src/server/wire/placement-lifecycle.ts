import type { CloudLifecycle } from "../types"

export function cloudLifecycleOf(row: Record<string, unknown>): CloudLifecycle {
  switch (row.status) {
    case "ready":
      return "live"
    case "provisioning":
      return "starting"
    case "failed":
      return "failed"
    case "stopped":
      return "asleep"
    default:
      return row.reachable === true ? "live" : "asleep"
  }
}
