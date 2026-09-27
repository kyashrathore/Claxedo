import type { PermissionModeDelivery } from "./modes"

export function permissionModeDeliverable(kind: PermissionModeDelivery["kind"]) {
  return kind === "harness-permission-mode"
}
