import type { MachineId, SessionRow } from "@/server"

export type ActivityPlacement = { readonly icon: "cloud" | "monitor" | "server" | "circle-alert"; readonly name: string }

export function activityPlacement(row: SessionRow, thisMachine: MachineId | undefined, unavailable: string): ActivityPlacement {
  const detail = row.placement
  if (!detail) return { icon: "circle-alert", name: unavailable }
  if (detail.kind === "cloud") return { icon: "cloud", name: detail.cloudName ?? unavailable }
  const local = detail.kind === "local" || (detail.machineId !== undefined && detail.machineId === thisMachine)
  return { icon: local ? "monitor" : "server", name: detail.machineName ?? unavailable }
}
