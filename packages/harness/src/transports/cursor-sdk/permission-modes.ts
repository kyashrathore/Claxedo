import type { AgentPermissionMode, AgentPermissionModeState, SessionConfig } from "@claxedo/agent-runtime-contract"
import { TransportError } from "../../contract/errors"
import type { HostLocalOptions } from "./protocol"

export const CURSOR_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  { id: "review", name: "Review each call", description: "Run tool calls inside Cursor's sandbox and review them", level: "ask" },
  { id: "auto-review", name: "Auto-review", description: "Let Cursor's classifier approve tool calls inside the sandbox", level: "auto" },
  { id: "unsandboxed", name: "Unsandboxed", description: "Run tool calls directly, with no sandbox", level: "full" },
]

export const DEFAULT_CURSOR_PERMISSION_MODE = "auto-review"

const protocolPermissionMap: Readonly<Record<string, HostLocalOptions>> = {
  review: { sandboxOptions: { enabled: true } },
  "auto-review": { sandboxOptions: { enabled: true }, autoReview: true },
  unsandboxed: { sandboxOptions: { enabled: false } },
}

export function cursorPermissionModeId(config: Pick<SessionConfig, "permissionMode">): string {
  const modeId = config.permissionMode ?? DEFAULT_CURSOR_PERMISSION_MODE
  if (!CURSOR_PERMISSION_MODES.some((mode) => mode.id === modeId)) {
    throw new TransportError("cursor", "configuration", `Unknown Cursor permission mode ${modeId}`)
  }
  return modeId
}

export function permissionLocalOptions(config: Pick<SessionConfig, "permissionMode">): HostLocalOptions {
  return { ...protocolPermissionMap[cursorPermissionModeId(config)] }
}

export function cursorPermissionModeState(config: Pick<SessionConfig, "permissionMode">): AgentPermissionModeState {
  return { modes: [...CURSOR_PERMISSION_MODES], currentModeId: cursorPermissionModeId(config), appliesFrom: "next-turn" }
}
