import { CURSOR_PERMISSION_MODES, type AgentPermissionModeState, type SessionConfig } from "@claxedo/agent-runtime-contract"
import { TransportError } from "../../contract/errors"
import type { HostLocalOptions } from "./protocol"

export const protocolPermissionMap: Readonly<Record<string, HostLocalOptions>> = {
  review: { sandboxOptions: { enabled: true } },
  "auto-review": { sandboxOptions: { enabled: true }, autoReview: true },
  unsandboxed: { sandboxOptions: { enabled: false } },
}

export function cursorPermissionModeId(config: Pick<SessionConfig, "permissionMode">): string {
  const modeId = config.permissionMode ?? CURSOR_PERMISSION_MODES.defaultModeId
  if (!CURSOR_PERMISSION_MODES.modes.some((mode) => mode.id === modeId)) {
    throw new TransportError("cursor", "configuration", `Unknown Cursor permission mode ${modeId}`)
  }
  return modeId
}

export function permissionLocalOptions(config: Pick<SessionConfig, "permissionMode">): HostLocalOptions {
  return { ...protocolPermissionMap[cursorPermissionModeId(config)] }
}

export function cursorPermissionModeState(config: Pick<SessionConfig, "permissionMode">): AgentPermissionModeState {
  return { modes: [...CURSOR_PERMISSION_MODES.modes], currentModeId: cursorPermissionModeId(config), appliesFrom: CURSOR_PERMISSION_MODES.appliesFrom }
}
