import os from "node:os"
import path from "node:path"

export function envText(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim()
  return value || undefined
}

export function runtimeEnvText(env: NodeJS.ProcessEnv, key: string) {
  return envText(env, key)
}

export function workspaceRuntimeDataDir(env: NodeJS.ProcessEnv = process.env) {
  return runtimeEnvText(env, "WORKSPACE_RUNTIME_DATA_DIR")
    ?? path.join(os.homedir(), ".workspace-runtime")
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
    return path.join(
      runtimeEnvText(env, "WORKSPACE_RUNTIME_WORKSPACES_DIR") ?? path.join(os.homedir(), ".claxedo", "workspaces"),
      workspace,
      "runtime",
    )
  }
  return path.join(workspaceRuntimeDataDir(env), "store")
}

export function workspaceRuntimePtyHistoryDir(env: NodeJS.ProcessEnv = process.env) {
  return runtimeEnvText(env, "WORKSPACE_RUNTIME_PTY_HISTORY_DIR")
    ?? path.join(workspaceRuntimeStateDir(env), "pty-history")
}
