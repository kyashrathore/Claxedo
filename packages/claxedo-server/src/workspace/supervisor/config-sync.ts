import type { RuntimeConfigSnapshot } from "../../agent-config"
import { createClaxedoRuntimeConfig } from "../../hosts/workspace-runtime/runtime-config"
import {
  configTokenHeaders,
  stateConfigToken,
  supervisorBackplaneHeaders,
} from "./control-token"
import { runtimeWorkspaceDir } from "./state"
import type { WorkspaceRuntimeState } from "./store"

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
  const url = `${state.url}/api/wr/config`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...configTokenHeaders(stateConfigToken(state)),
      ...await supervisorBackplaneHeaders(state),
    },
    body: JSON.stringify(cfg ?? await runtimeConfigSnapshot(state)),
    signal: AbortSignal.timeout(5_000),
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : ""
    throw new Error(`config push failed: ${url}: ${message}${cause}`)
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
