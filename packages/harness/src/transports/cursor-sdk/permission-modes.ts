import type { AgentPermissionMode, AgentPermissionModeState, SessionConfig } from "@claxedo/agent-runtime-contract"
import { TransportError } from "../../contract/errors"
import type { HostLocalOptions } from "./protocol"

export const CURSOR_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  { id: "review", name: "Review each call", description: "Run tool calls inside Cursor's sandbox and review them", level: "ask" },
  { id: "auto-review", name: "Auto-review", description: "Let Cursor's classifier approve tool calls inside the sandbox", level: "auto" },
  { id: "unsandboxed", name: "Unsandboxed", description: "Run tool calls directly, with no sandbox", level: "full" },
]

const protocolPermissionMap: Readonly<Record<string, HostLocalOptions>> = {
  review: { sandboxOptions: { enabled: true } },
  "auto-review": { sandboxOptions: { enabled: true }, autoReview: true },
  unsandboxed: { sandboxOptions: { enabled: false } },
}

export function cursorPermissionModeId(config: Pick<SessionConfig, "permissionMode">): string | undefined {
  const modeId = config.permissionMode
  if (modeId !== undefined && !CURSOR_PERMISSION_MODES.some((mode) => mode.id === modeId)) {
    throw new TransportError("cursor", "configuration", `Unknown Cursor permission mode ${modeId}`)
  }
  return modeId
}

export function permissionLocalOptions(config: Pick<SessionConfig, "permissionMode">): HostLocalOptions {
  const modeId = cursorPermissionModeId(config)
  return modeId === undefined ? {} : { ...protocolPermissionMap[modeId] }
}

export function cursorPermissionModeState(config: Pick<SessionConfig, "permissionMode">): AgentPermissionModeState {
  const currentModeId = cursorPermissionModeId(config)
  return { modes: [...CURSOR_PERMISSION_MODES], ...(currentModeId === undefined ? {} : { currentModeId }), appliesFrom: "next-turn" }
}
