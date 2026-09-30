import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk"
import { CLAUDE_PERMISSION_MODES, type AgentPermissionModeState, type SessionConfig } from "@claxedo/agent-runtime-contract"
import { claudePermissionSettings } from "../../profiles/claude-code"
import { TransportError } from "../../contract/errors"
import type { KeptPermissionMode } from "../../contract"
import { replayClaudePermissionUpdates, claudeGrantUpdates, persistedClaudeRules } from "./grants"

export const sdkModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const satisfies readonly PermissionMode[]
export const modeParity: Exclude<PermissionMode, typeof sdkModes[number]> extends never ? true : never = true

export function claudeModeId(selected: string | undefined): string {
  return selected ?? CLAUDE_PERMISSION_MODES.defaultModeId
}

export function claudeModeState(currentModeId: string): AgentPermissionModeState {
  return { modes: [...CLAUDE_PERMISSION_MODES.modes], currentModeId, appliesFrom: CLAUDE_PERMISSION_MODES.appliesFrom }
}

export function claudeModeKept(updates: readonly PermissionUpdate[] | undefined): KeptPermissionMode | undefined {
  const moved = updates?.findLast((update) => update.type === "setMode")
  return moved?.type === "setMode" ? claudeKeptMode(moved.mode) : undefined
}

export function claudeKeptMode(modeId: string): KeptPermissionMode {
  const mode = CLAUDE_PERMISSION_MODES.modes.find((candidate) => candidate.id === modeId)
  if (!mode) throw new TransportError("claude", "protocol", `Unknown Claude permission mode ${modeId}`)
  return { modeId: mode.id, label: mode.name }
}

export function requireClaudeMode(modeId: string): typeof sdkModes[number] {
  const selected = sdkModes.find((value) => value === modeId)
  if (!selected) throw new TransportError("claude", "configuration", `Unknown Claude permission mode ${modeId}`)
  return selected
}

export function permissionOptions(config: SessionConfig, grantKeys: readonly string[] = []) {
  const modeId = claudeModeId(config.permissionMode)
  const selected = requireClaudeMode(modeId)
  const rules = replayClaudePermissionUpdates(persistedClaudeRules(config.permissionState), claudeGrantUpdates(grantKeys))
  return { permissionMode: selected, allowDangerouslySkipPermissions: modeId === "bypassPermissions" ? true as const : undefined,
    additionalDirectories: rules.additionalDirectories,
    settings: claudePermissionSettings(rules.allow, rules.ask, rules.deny) }
}
