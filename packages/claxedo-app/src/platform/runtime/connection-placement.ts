import type { RelayRole } from "@/platform/runtime/placement"

export type ConnectionPlacementState =
  | { state: "role-pending"; workspaceId: string }
  | { state: "role-known"; workspaceId: string; role: RelayRole }
  | { state: "reconnecting"; workspaceId: string; role?: RelayRole }
  | { state: "disconnected"; workspaceId: string; role?: RelayRole }

export type ConnectionPlacementEvent =
  | { type: "role"; role: RelayRole }
  | { type: "lost" }
  | { type: "retry" }
  | { type: "connected"; role?: RelayRole }

export function transitionConnectionPlacement(
  current: ConnectionPlacementState,
  event: ConnectionPlacementEvent,
): ConnectionPlacementState | undefined {
  if (current.state === "role-pending" && event.type === "role") {
    return { state: "role-known", workspaceId: current.workspaceId, role: event.role }
  }
  if (current.state === "role-known" && event.type === "role") {
    return { state: "role-known", workspaceId: current.workspaceId, role: event.role }
  }
  if ((current.state === "role-known" || current.state === "role-pending") && event.type === "lost") {
    return {
      state: "reconnecting",
      workspaceId: current.workspaceId,
      ...(current.state === "role-known" ? { role: current.role } : {}),
    }
  }
  if (current.state === "reconnecting" && event.type === "connected") {
    const role = event.role ?? current.role
    return role
      ? { state: "role-known", workspaceId: current.workspaceId, role }
      : { state: "role-pending", workspaceId: current.workspaceId }
  }
  if (current.state === "reconnecting" && event.type === "lost") {
    return { state: "disconnected", workspaceId: current.workspaceId, ...(current.role ? { role: current.role } : {}) }
  }
  if (current.state === "disconnected" && event.type === "retry") {
    return { state: "reconnecting", workspaceId: current.workspaceId, ...(current.role ? { role: current.role } : {}) }
  }
  return undefined
}
