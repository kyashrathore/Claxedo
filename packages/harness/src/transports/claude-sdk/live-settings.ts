import type { EffortLevel, Query } from "@anthropic-ai/claude-agent-sdk"
import { claudeModeId, requireClaudeMode } from "./permissions"

export type ClaudeLiveSettings = { model: string; effort?: EffortLevel; permissionMode?: string }

export async function applyClaudePermissionMode(stream: Query, current: Pick<ClaudeLiveSettings, "permissionMode"> | undefined, modeId: string): Promise<void> {
  const mode = requireClaudeMode(modeId)
  if (current && claudeModeId(current.permissionMode) === mode) return
  await stream.setPermissionMode(mode)
  if (current) current.permissionMode = mode
}

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
  await applyClaudePermissionMode(stream, current, claudeModeId(next.permissionMode))
}
