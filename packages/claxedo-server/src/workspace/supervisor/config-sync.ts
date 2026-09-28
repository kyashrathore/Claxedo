import type { RuntimeConfigSnapshot } from "@claxedo/server-core/agent-config/index"
import { createClaxedoRuntimeConfig } from "@claxedo/server-core/hosts/workspace-runtime/runtime-config"
import {
  configTokenHeaders,
  stateConfigToken,
  supervisorBackplaneHeaders,
} from "./control-token"
import { runtimeWorkspaceDir } from "./state"
import { supervisorDriverIdentity } from "./driver-id"
import type { WorkspaceRuntimeState } from "./store"
import { numberField, readJsonRecord } from "@claxedo/server-core/platform/json/index"
import { createKeyedSerializer } from "@claxedo/helpers"

export async function runtimeConfigSnapshot(state: WorkspaceRuntimeState) {
  const scope = state.remote || state.ws.kind === "cloud" ? "shared" : "local"
  return createClaxedoRuntimeConfig({
    secretScope: scope,
    orgId: state.ws.org_id,
    workspaceDir: runtimeWorkspaceDir(state.ws),
    workspaceId: state.ws.id,
    // What the sandbox's own provider can do decides what a projection may
    // promise: a driver that cannot broker must refuse the turn here, because
    // nothing downstream of this snapshot can tell that it could not.
    ...(scope === "shared"
      ? { secretBrokering: (await supervisorDriverIdentity(state)).entry.metadata.secretBrokering }
      : {}),
  })
}

const pushes = createKeyedSerializer()
let configRevision = 0
const appliedRevisions = new Map<string, number>()

/** A settings or plugin change: every runtime that has not applied a snapshot read after this is stale. */
export function recordRuntimeConfigChange() {
  configRevision += 1
}

async function pushTurn(state: WorkspaceRuntimeState, onlyIfStale: boolean) {
  if (onlyIfStale && (appliedRevisions.get(state.ws.id) ?? -1) >= configRevision) return
  if (!state.url) throw new Error("workspace runtime missing url")
  // Read before the snapshot, so a change landing mid-read leaves this push
  // marked stale rather than a newer snapshot marked applied.
  const revision = configRevision
  await postRuntimeConfig(`${state.url}/api/wr/config`, state, await runtimeConfigSnapshot(state))
  appliedRevisions.set(state.ws.id, revision)
}

/**
 * Pushes run one at a time per workspace and each reads its snapshot inside
 * its turn: two concurrent pushes that read first and posted after could land
 * in either order, leaving the runtime on the older configuration. Keyed by
 * workspace id, not runtime state, because a restart replaces the state while
 * the previous push is still in flight.
 */
export function pushRuntimeConfig(state: WorkspaceRuntimeState) {
  return pushes.run(state.ws.id, () => pushTurn(state, false))
}

/** For a runtime whose start just finished: push only if a change landed after its start's own push read the snapshot. */
export function pushRuntimeConfigIfStale(state: WorkspaceRuntimeState) {
  return pushes.run(state.ws.id, () => pushTurn(state, true))
}

async function postRuntimeConfig(url: string, state: WorkspaceRuntimeState, cfg: RuntimeConfigSnapshot) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...await supervisorBackplaneHeaders(state),
    },
    body: JSON.stringify(cfg),
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
    const body = await readJsonRecord(res)
    return (numberField(body, "ptyCount") ?? 0) > 0 || (numberField(body, "activeProcessCount") ?? 0) > 0
  } catch {
    return false
  }
}
