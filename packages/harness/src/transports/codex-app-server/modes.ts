import { CODEX_PERMISSION_MODES, type AgentPermissionModeState } from "@claxedo/agent-runtime-contract"
import type { v2 } from "./translate"
import { CodexTransportError } from "./errors"

export type CodexPermissionSettings = { approvalPolicy: v2.AskForApproval; sandbox: v2.SandboxMode }

const DEFAULT_CODEX_MODE = CODEX_PERMISSION_MODES.defaultModeId

export const protocolModeMap: Readonly<Record<string, CodexPermissionSettings>> = {
  "read-only": { approvalPolicy: "never", sandbox: "read-only" },
  "workspace-write": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  untrusted: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
}

export function codexModeInEffect(modeId: string | undefined): string {
  return modeId !== undefined && modeId in protocolModeMap ? modeId : DEFAULT_CODEX_MODE
}

export function codexPermissionSettings(modeId: string | undefined): CodexPermissionSettings {
  return protocolModeMap[codexModeInEffect(modeId)]!
}

export function codexModeState(modeId: string | undefined): AgentPermissionModeState {
  return { modes: [...CODEX_PERMISSION_MODES.modes], currentModeId: codexModeInEffect(modeId), appliesFrom: CODEX_PERMISSION_MODES.appliesFrom }
}

export function requireCodexMode(modeId: string): string {
  if (!(modeId in protocolModeMap)) throw new CodexTransportError("configuration", `Unknown Codex permission mode ${modeId}`)
  return modeId
}

export function codexTurnSandboxPolicy(sandbox: v2.SandboxMode, directory: string): v2.SandboxPolicy {
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false }
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" }
  return { type: "workspaceWrite", writableRoots: [directory], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}
