import type { SandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"
import {
  workspaceRuntimeDirectAuthEnv,
  sandboxLeaseEnv as sandboxLeaseVariables,
  workspaceRuntimeRelayVerificationEnv,
} from "../../workspace-runtime-integration/env"

export type WorkspaceSupervisorOptions = {
  server_url: string
  /**
   * @deprecated Vestigial. The supervisor never reads this; the sandbox runtime
   * owns opencode via SANDBOX env in supervised-spawn mode. Optional so embedded
   * compositions (no local opencode URL) need not forward a meaningless value.
   */
  opencode_url?: string
  relay_url?: string
  default_sandbox_driver?: SandboxDriverID
}

export function sandboxControlPlaneUrl(driverId: SandboxDriverID, serverUrl: string) {
  return sandboxReachableUrl(driverId, serverUrl)
}

export function runtimeDirectAuthEnv(token: string) {
  return workspaceRuntimeDirectAuthEnv({ token })
}

export function sandboxLeaseEnv(input: {
  leaseId: string
  epoch: number
  sandboxId: string
}) {
  return sandboxLeaseVariables(input)
}

export function relayHostVerificationEnv(
  driverId: SandboxDriverID,
  input: {
    options: WorkspaceSupervisorOptions
  },
): Record<string, string> {
  if (!input.options.relay_url?.trim() && localControlPlaneConfigured(input.options)) {
    return workspaceRuntimeRelayVerificationEnv({ kind: "dev-unsafe-private-network" })
  }
  return workspaceRuntimeRelayVerificationEnv({ kind: "jwks", jwksUrl: relayJwksUrl(driverId, input.options) })
}

export function controlPlaneVerificationEnv(
  driverId: SandboxDriverID,
  controlPlaneUrl: string,
  input: {
    options: WorkspaceSupervisorOptions
    env?: NodeJS.ProcessEnv
  },
): Record<string, string> {
  const publicKeyPem = (input.env ?? process.env).CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM?.trim()
  if (driverId !== "docker" && localControlPlaneConfigured(input.options) && publicKeyPem) {
    return {
      WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM: publicKeyPem,
      WORKSPACE_RUNTIME_MANAGEMENT_ISSUER: "claxedo-control-plane",
      WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE: "supervisor-backplane",
    }
  }
  return {
    WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: `${controlPlaneUrl.replace(/\/+$/g, "")}/.well-known/jwks.json`,
    WORKSPACE_RUNTIME_MANAGEMENT_ISSUER: "claxedo-control-plane",
    WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE: "supervisor-backplane",
  }
}

function sandboxReachableUrl(driverId: SandboxDriverID, input: string) {
  if (driverId !== "docker") return input
  try {
    const url = new URL(input)
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return input
    url.hostname = "host.docker.internal"
    return url.toString().replace(/\/$/, "")
  } catch {
    return input
  }
}

function relayJwksUrl(driverId: SandboxDriverID, options: WorkspaceSupervisorOptions) {
  const relayUrl = options.relay_url?.trim()
  if (!relayUrl) {
    throw new Error("managed cloud VM runtime requires relay_url to configure relay-host auth")
  }
  return `${sandboxReachableUrl(driverId, relayUrl).replace(/\/+$/g, "")}/.well-known/jwks.json`
}

function localControlPlaneConfigured(options: WorkspaceSupervisorOptions) {
  try {
    const url = new URL(options.server_url)
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]"
  } catch {
    return false
  }
}
