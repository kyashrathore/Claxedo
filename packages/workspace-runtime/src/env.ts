import path from "node:path"
import { envText } from "@claxedo/helpers/env"
import { userHomeDir } from "@claxedo/helpers/path"
import type { MachineLoginPolicy, RuntimePlacement } from "@claxedo/harness/contract"

export function runtimeEnvText(env: NodeJS.ProcessEnv, key: string) {
  return envText(env, key)
}

const RUNTIME_PLACEMENTS: readonly RuntimePlacement[] = ["desktop", "loopback", "self-hosted", "cloud"]

/**
 * Where a standalone runtime process runs, for every transport's own-login
 * decision. `WORKSPACE_RUNTIME_PLACEMENT` names it; absent, a relay-exposed
 * process is a self-hosted node and any other is the machine's own loopback.
 * `WORKSPACE_RUNTIME_MACHINE_OWNER_USER_ID` names the person whose machine
 * logins the process may spend; absent, only a machine-owner actor may.
 */
export function workspaceRuntimePlacementFromEnv(env: NodeJS.ProcessEnv, input: { relay: boolean }): MachineLoginPolicy {
  const named = runtimeEnvText(env, "WORKSPACE_RUNTIME_PLACEMENT")
  const placement = RUNTIME_PLACEMENTS.find((candidate) => candidate === named)
  if (named && !placement) throw new Error(`Unsupported WORKSPACE_RUNTIME_PLACEMENT: ${named}`)
  const resolved = placement ?? (input.relay ? "self-hosted" : "loopback")
  return {
    placement: resolved,
    machineOwnerUserId: runtimeEnvText(env, "WORKSPACE_RUNTIME_MACHINE_OWNER_USER_ID") ?? "",
    canUseOwnLogin: resolved === "desktop" || resolved === "loopback",
  }
}

/**
 * The lease generation this process was booted for, as the provisioner wrote
 * it into the sandbox (`sandboxLeaseEnv`). A runtime that reports on itself
 * must fence the report with it, so absent means "no lease" — a local or
 * embedded runtime no control plane placed — not "the current one".
 */
export function workspaceRuntimeEpoch(env: NodeJS.ProcessEnv = process.env) {
  const raw = runtimeEnvText(env, "WORKSPACE_RUNTIME_EPOCH")
  if (!raw) return undefined
  const epoch = Number(raw)
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : undefined
}

export function workspaceRuntimeDataDir(env: NodeJS.ProcessEnv = process.env) {
  return runtimeEnvText(env, "WORKSPACE_RUNTIME_DATA_DIR")
    ?? path.join(userHomeDir(env), ".workspace-runtime")
}

export function workspaceRuntimeWorkspacesDir(env: NodeJS.ProcessEnv = process.env) {
  return runtimeEnvText(env, "WORKSPACE_RUNTIME_WORKSPACES_DIR")
    ?? path.join(userHomeDir(env), ".claxedo", "workspaces")
}

export function workspaceRuntimeStateDir(env: NodeJS.ProcessEnv = process.env) {
  return runtimeEnvText(env, "WORKSPACE_RUNTIME_STATE_DIR")
    ?? path.join(workspaceRuntimeDataDir(env), "state")
}

export function workspaceRuntimeStoreDir(env: NodeJS.ProcessEnv = process.env) {
  const configured = runtimeEnvText(env, "WORKSPACE_RUNTIME_STORE_DIR")
  if (configured) return configured
  const workspace = runtimeEnvText(env, "WORKSPACE_RUNTIME_WORKSPACE_ID")
  if (workspace && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspace)) {
    return path.join(workspaceRuntimeWorkspacesDir(env), workspace, "runtime")
  }
  return path.join(workspaceRuntimeDataDir(env), "store")
}

export function workspaceRuntimePtyHistoryDir(env: NodeJS.ProcessEnv = process.env) {
  return runtimeEnvText(env, "WORKSPACE_RUNTIME_PTY_HISTORY_DIR")
    ?? path.join(workspaceRuntimeStateDir(env), "pty-history")
}
