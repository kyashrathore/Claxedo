import { randomUUID, timingSafeEqual } from "crypto"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER } from "@claxedo/workspace-runtime/config"
import { mintSupervisorBackplaneToken } from "./control-plane/runtime-access-token"
import { runtimes, type WorkspaceRuntimeState } from "./workspace-supervisor-store"

export function externalConfigToken() {
  return process.env.WORKSPACE_RUNTIME_CONFIG_TOKEN?.trim()
}

export function stateConfigToken(state: WorkspaceRuntimeState) {
  return externalConfigToken() || state.config_token
}

export function configToken(state: WorkspaceRuntimeState) {
  const external = externalConfigToken()
  if (external) return external
  state.config_token ??= randomUUID()
  return state.config_token
}

function tokenEquals(left: string, right: string) {
  const lhs = Buffer.from(left)
  const rhs = Buffer.from(right)
  return lhs.length === rhs.length && timingSafeEqual(lhs, rhs)
}

export function verifyWorkspaceRuntimeControlToken(workspaceId: string | undefined, token: string | undefined) {
  if (!workspaceId || !token) return false
  const hit = runtimes.get(workspaceId)
  const expected = hit ? stateConfigToken(hit) : undefined
  return !!expected && tokenEquals(expected, token)
}

export function configTokenHeaders(token: string | undefined) {
  return token
    ? {
        Authorization: `Bearer ${token}`,
        "X-Claxedo-Runtime-Config-Token": token,
      }
    : undefined
}

function runtimeSupervisorHostId(state: WorkspaceRuntimeState) {
  return state.sandbox_target?.hostId ?? state.relay_host_id ?? state.sandbox_id ?? state.ws.id
}

export async function supervisorBackplaneHeaders(state: WorkspaceRuntimeState) {
  const token = await mintSupervisorBackplaneToken({
    workspaceId: state.ws.id,
    hostId: runtimeSupervisorHostId(state),
    subject: "workspace-supervisor",
  })
  return {
    [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: token.supervisorBackplaneToken,
  }
}
