import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"
import type { AgentPermissionMode, SessionConfig } from "@claxedo/agent-runtime-contract"
import { ClaudeTransportError } from "./errors"

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

export const denyFloor = ["Bash(rm -rf /*)", "Bash(rm -rf ~*)", "Bash(git push --force*)", "Bash(curl *| sh)",
  "Bash(curl *| bash)", "Bash(wget *| sh)", "Bash(chmod -R 777*)"]
const protocolPermissionMap = { allow: "allow", ask: "ask", deny: "deny", additionalDirectories: "additionalDirectories" } as const

export function permissionOptions(config: SessionConfig) {
  const modeId = config.permissionMode ?? "default"
  const selected = sdkModes.find((value) => value === modeId)
  if (!selected) throw new ClaudeTransportError("configuration", `Unknown Claude permission mode ${modeId}`)
  const rows = config.permissionState ?? {}
  const values = (key: "allow" | "deny" | "ask" | "additionalDirectories") => {
    const row = rows[key]
    if (row === undefined) return []
    if (!Array.isArray(row) || row.some((value) => typeof value !== "string")) throw new ClaudeTransportError("configuration", `Invalid Claude ${key} permission state`)
    return row.filter((value: unknown): value is string => typeof value === "string")
  }
  return { permissionMode: selected, allowDangerouslySkipPermissions: modeId === "bypassPermissions" ? true as const : undefined,
    additionalDirectories: values(protocolPermissionMap.additionalDirectories), settings: { permissions: {
      allow: values(protocolPermissionMap.allow), ask: values(protocolPermissionMap.ask), deny: [...values(protocolPermissionMap.deny), ...denyFloor],
    } } }
}
