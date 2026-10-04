import type { EffortLevel, Query } from "@anthropic-ai/claude-agent-sdk"
import { claudeModeId, requireClaudeMode } from "./permissions"

export type ClaudeLiveSettings = { model: string; effort?: EffortLevel; permissionMode?: string }

export async function applyClaudePermissionMode(stream: Query, current: Pick<ClaudeLiveSettings, "permissionMode"> | undefined, modeId: string): Promise<void> {
  const mode = requireClaudeMode(modeId)
  if (current && claudeModeId(current.permissionMode) === mode) return
  await stream.setPermissionMode(mode)
  if (current) current.permissionMode = mode
}

export async function applyClaudeModelSettings(stream: Query, current: ClaudeLiveSettings, next: Pick<ClaudeLiveSettings, "model" | "effort">): Promise<void> {
  const changedModel = current.model !== next.model
  if (changedModel || current.effort !== next.effort) {
    await stream.applyFlagSettings({ ...(changedModel ? { model: next.model } : {}), effortLevel: next.effort ?? null })
    current.model = next.model
    current.effort = next.effort
  }
}

export async function applyClaudeLiveSettings(stream: Query, current: ClaudeLiveSettings, next: ClaudeLiveSettings): Promise<void> {
  await applyClaudeModelSettings(stream, current, next)
  await applyClaudePermissionMode(stream, current, claudeModeId(next.permissionMode))
}
