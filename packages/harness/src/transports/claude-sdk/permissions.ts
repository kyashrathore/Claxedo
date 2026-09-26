import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"
import type { AgentPermissionMode, SessionConfig } from "@claxedo/agent-runtime-contract"
import { claudePermissionSettings } from "../../profiles/claude-code"
import { TransportError } from "../../contract/errors"
import { replayClaudePermissionUpdates, claudeGrantUpdates, persistedClaudeRules } from "./grants"

export const sdkModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const satisfies readonly PermissionMode[]
export const modeParity: Exclude<PermissionMode, typeof sdkModes[number]> extends never ? true : never = true

export const modes: AgentPermissionMode[] = [
  { id: "default", name: "Default", level: "ask" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "auto", name: "Auto", level: "auto" },
  { id: "plan", name: "Plan" },
  { id: "dontAsk", name: "Don't ask" },
  { id: "bypassPermissions", name: "Bypass permissions", level: "full" },
]

export function requireClaudeMode(modeId: string): typeof sdkModes[number] {
  const selected = sdkModes.find((value) => value === modeId)
  if (!selected) throw new TransportError("claude", "configuration", `Unknown Claude permission mode ${modeId}`)
  return selected
}

export function permissionOptions(config: SessionConfig, grantKeys: readonly string[] = []) {
  const modeId = config.permissionMode ?? "default"
  const selected = requireClaudeMode(modeId)
  const rules = replayClaudePermissionUpdates(persistedClaudeRules(config.permissionState), claudeGrantUpdates(grantKeys))
  return { permissionMode: selected, allowDangerouslySkipPermissions: modeId === "bypassPermissions" ? true as const : undefined,
    additionalDirectories: rules.additionalDirectories,
    settings: claudePermissionSettings(rules.allow, rules.ask, rules.deny) }
}
