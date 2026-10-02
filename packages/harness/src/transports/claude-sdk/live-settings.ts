import type { EffortLevel, Query } from "@anthropic-ai/claude-agent-sdk"
import { claudeModeId, requireClaudeMode } from "./permissions"

export type ClaudeLiveSettings = { model: string; effort?: EffortLevel; permissionMode?: string }

export async function applyClaudeLiveSettings(stream: Query, current: ClaudeLiveSettings, next: ClaudeLiveSettings): Promise<void> {
  const changedModel = current.model !== next.model
  if (changedModel) {
    await stream.setModel(next.model)
    current.model = next.model
  }
  if (current.effort !== next.effort || changedModel && next.effort !== undefined) {
    await stream.applyFlagSettings({ effortLevel: next.effort ?? null })
    current.effort = next.effort
  }
  if (claudeModeId(current.permissionMode) !== claudeModeId(next.permissionMode)) {
    await stream.setPermissionMode(requireClaudeMode(claudeModeId(next.permissionMode)))
    current.permissionMode = next.permissionMode
  }
}
