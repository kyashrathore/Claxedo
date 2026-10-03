import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxDriverEnsureInput } from "@claxedo/sandbox-manager"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { D1ChannelRuntimeAuthority } from "../authority/adapters/d1/channel-runtime-authority"
import { isCloudRoot } from "../workspace/cloud-root-backing"
import { mintCloudSessionRowsGrant } from "./cloud-session-rows-grant"

/** Runs in the driver's launch callback, after lease acquisition supplied the exact epoch and host. */
export function createCloudSessionRowsLaunchEnvironment(input: {
  database: D1Database
  deploymentId: string
  signingEnv: Record<string, string | undefined>
  passes: SandboxPassRegister
  controlPlaneOrigin: string
  now?: () => number
}) {
  const authority = new D1ChannelRuntimeAuthority(input.database, {
    deploymentId: input.deploymentId, ...(input.now ? { now: input.now } : {}),
  })
  const url = `${input.controlPlaneOrigin.replace(/\/+$/, "")}/api/claxedo/cloud/session-rows`
  return async (launch: SandboxDriverEnsureInput, host: { id: string }): Promise<Record<string, string>> => {
    if (!await isCloudRoot(input.database, launch.workspaceId)) throw new Error("Cloud session producer requires a cloud workspace")
    const owner = await authority.resolveWorkspaceOwner(launch.workspaceId)
    if (!owner) throw new Error("Cloud session producer requires an active workspace owner")
    const minted = await mintCloudSessionRowsGrant({
      ...owner, workspaceId: launch.workspaceId, hostId: host.id, epoch: launch.epoch,
    }, input.signingEnv, { register: input.passes, ...(input.now ? { now: input.now } : {}) })
    return {
      WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN: minted.token,
      WORKSPACE_RUNTIME_SESSION_ROWS_EXPIRES_AT: String(minted.expiresAt),
      WORKSPACE_RUNTIME_SESSION_ROWS_URL: url,
      WORKSPACE_RUNTIME_SESSION_ROWS_RENEW_URL: `${url}/renew`,
    }
  }
}
