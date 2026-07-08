import type { RuntimeConfigSnapshot } from "./agent-config"
import { createClaxedoRuntimeConfig } from "./workspace-runtime-integration/runtime-config"
import {
  configTokenHeaders,
  stateConfigToken,
  supervisorBackplaneHeaders,
} from "./workspace-supervisor-control-token"
import { runtimeWorkspaceDir } from "./workspace-supervisor-state"
import type { WorkspaceRuntimeState } from "./workspace-supervisor-store"

export async function runtimeConfigSnapshot(state?: WorkspaceRuntimeState) {
  if (!state?.remote && state?.ws.kind !== "cloud") return createClaxedoRuntimeConfig()
  return createClaxedoRuntimeConfig({
    secretScope: "shared",
    workspaceDir: runtimeWorkspaceDir(state.ws),
    workspaceId: state.ws.id,
  })
}

export async function pushRuntimeConfig(state: WorkspaceRuntimeState, cfg?: RuntimeConfigSnapshot) {
  if (!state.url) throw new Error("workspace runtime missing url")
  const res = await fetch(`${state.url}/api/wr/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...configTokenHeaders(stateConfigToken(state)),
      ...await supervisorBackplaneHeaders(state),
    },
    body: JSON.stringify(cfg ?? await runtimeConfigSnapshot(state)),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "")
    throw new Error(
      `config push failed: ${res.status} ${res.statusText}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`,
    )
  }
}

export async function runtimeHasActiveWork(state: WorkspaceRuntimeState) {
  if (!state.url) return false
  try {
    const res = await fetch(`${state.url}/api/wr/health`, {
      headers: configTokenHeaders(stateConfigToken(state)),
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) return false
    const body = await res.json().catch(() => ({})) as {
      ptyCount?: number
      activeProcessCount?: number
    }
    return (body.ptyCount ?? 0) > 0 || (body.activeProcessCount ?? 0) > 0
  } catch {
    return false
  }
}
