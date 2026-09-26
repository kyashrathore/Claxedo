import type { AgentPermissionMode, AgentPermissionModeState } from "@claxedo/agent-runtime-contract"
import type { v2 } from "./translate"
import { CodexTransportError } from "./errors"

export type CodexPermissionSettings = { approvalPolicy: v2.AskForApproval; sandbox: v2.SandboxMode }

export const DEFAULT_CODEX_MODE = "workspace-write"

export const codexModes: readonly AgentPermissionMode[] = [
  { id: "read-only", name: "Read only", description: "Never asks; the sandbox permits reads only, so writes fail", level: "ask" },
  { id: DEFAULT_CODEX_MODE, name: "Workspace write", description: "Runs commands inside the workspace without asking; escalates outside it", level: "auto" },
  { id: "untrusted", name: "Untrusted", description: "Only trusted commands run without asking; anything else escalates" },
  { id: "full-access", name: "Full access", description: "Never asks; full filesystem and network access", level: "full" },
]

const protocolModeMap: Readonly<Record<string, CodexPermissionSettings>> = {
  "read-only": { approvalPolicy: "never", sandbox: "read-only" },
  [DEFAULT_CODEX_MODE]: { approvalPolicy: "on-request", sandbox: "workspace-write" },
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
  return { modes: [...codexModes], currentModeId: codexModeInEffect(modeId), appliesFrom: "next-turn" }
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
