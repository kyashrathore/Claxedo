import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import type { ControlPlaneAuthConfig, ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"

/** Shared options for the non-plugin Agent Config route families. */
export type AgentConfigRouteOptions = {
  services?: ControlPlaneServicesContract
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  updateCentralSessionModel?: (sessionId: string, model: { providerID: string; modelID: string }) => Promise<void>
  invalidateCentralSession?: (sessionId: string) => void
}
