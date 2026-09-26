import type { PermissionModeDelivery } from "./modes"

export type SessionPermissionWriter = {
  setPermissionMode?: (input: {
    sessionId: string
    modeId: string
  }) => Promise<{ currentModeId?: string }>
}

export type PermissionModeApplied =
  | {
      kind: "applied"
      appliesFrom: "next-turn" | "next-session"
      kept?: string
    }
  | { kind: "not-wired"; delivery: PermissionModeDelivery["kind"] }

export function permissionModeDeliverable(kind: PermissionModeDelivery["kind"]) {
  return kind === "harness-permission-mode"
}

export async function applyPermissionMode(input: {
  delivery: PermissionModeDelivery
  sessionId: string
  client: SessionPermissionWriter
}): Promise<PermissionModeApplied> {
  const { delivery } = input

  if (!permissionModeDeliverable(delivery.kind) || !input.client.setPermissionMode) {
    return { kind: "not-wired", delivery: delivery.kind }
  }
  const state = await input.client.setPermissionMode({
    sessionId: input.sessionId,
    modeId: delivery.modeId,
  })
  return { kind: "applied", appliesFrom: delivery.appliesFrom, kept: state.currentModeId }
}
