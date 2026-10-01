export {
  createWorkspaceRuntimeApp,
  startServer,
  startServer as startWorkspaceRuntime,
  isLoopbackHostname,
  waitForWorkspaceRuntimeServerPort,
  workspaceRuntimeListenHostname,
}
  from "./server"
export type {
  WorkspaceRuntimeApp,
  WorkspaceRuntimeCorsOrigin,
  WorkspaceRuntimeLifecycleOptions,
  WorkspaceRuntimeServerOptions,
}
  from "./server"
export {
  WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER,
  createWorkspaceRuntimeJwtManagementAuth,
  loadWorkspaceRuntimeManagementVerificationKey,
}
  from "./management-auth"
export type {
  WorkspaceRuntimeManagementAction,
  WorkspaceRuntimeManagementAuth,
  WorkspaceRuntimeManagementAuthResult,
  WorkspaceRuntimeManagementTarget,
  WorkspaceRuntimeManagementVerifierKey,
}
  from "./management-auth"
export {
  WORKSPACE_RUNTIME_OWNER_GRANT_AUDIENCE,
  WORKSPACE_RUNTIME_OWNER_GRANT_ISSUER,
  ownerGrantIdentity,
  ownerGrantIdentityFromEnv,
}
  from "./owner-grant"
export type { OwnerGrantIdentity } from "./owner-grant"
export {
  WorkspaceRuntimeRouteManifest,
  WorkspaceRuntimeRoutes,
  workspaceRuntimeRoute,
}
  from "./routes/manifest"
export type { WorkspaceRuntimeRouteFamily }
  from "./routes/manifest"
export { flushRuntimeDocument, forgetRuntimeDocuments } from "./routes/document-hydration"
export {
  embeddedWorkspaceRuntimeExposure,
  loopbackWorkspaceRuntimeExposure,
  privateNetworkDevUnsafeWorkspaceRuntimeExposure,
  privateNetworkWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
}
  from "./exposure"
export type { WorkspaceRuntimeExposure, WorkspaceRuntimeRequestGuard }
  from "./exposure"

/**
 * The canonical env-trim helper: reads `env[key]` (falling back to an optional
 * legacy key), trims it, and returns `undefined` for blank values. Exported so
 * hosts composing their own boot-policy ladder trim env exactly the way the kit
 * does — instead of re-implementing the trim/blank rules.
 */
export { runtimeEnvText } from "./env"
export { createWorkspaceHost } from "./workspace"
export type { WorkspaceHost, WorkspaceHostOptions } from "./workspace"

export {
  WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL,
  remoteWorkspaceSessionAccessPolicy,
  remoteWorkspaceSessionAccessPolicyFromEnv,
} from "./remote-session-authority"
export type { AdoptRefusedSession } from "./remote-session-authority"

export { Pty } from "./pty/index"
export {
  authorizePtyAttach,
  createAuthorizedPtyConnection,
  isPtyStreamSocket,
  ptyAccessRefusalResponse,
  ptyStreamAccess,
  PTY_NOT_FOUND_REFUSAL,
} from "./pty/authorized-connection"
export type {
  AuthorizedPtyConnection,
  PtyAccessRefusal,
  PtyStreamAccess,
  PtyStreamSocket,
} from "./pty/authorized-connection"
export type { EmbeddedRelayHostIdentity } from "./workspace-host-service-auth"
export type {
  WorkspaceRuntimeStore,
  WorkspaceRuntimeStoreFactory,
} from "./workspace/host-options"
export type { WorkspaceCapabilities } from "./capabilities"
export {
  FIRST_PARTY_MCP_PATH,
  FIRST_PARTY_MCP_SERVER_NAME,
  createRuntimeCredentialIssuer,
  firstPartyMcpServerFor,
  runtimeCredentialWorkspaceId,
} from "./first-party-mcp/index"
export type {
  FirstPartyMcpServerEntry,
  RuntimeCredentialClaims,
  RuntimeCredentialIssuer,
  RuntimeCredentialIssuerOptions,
  RuntimeCredentialVerifier,
  WorkspaceFirstPartyMcpLaunchOptions,
} from "./first-party-mcp/index"
export type { WorkspaceProfile } from "./profile"
export { WorkspaceWorktreeManager, workspaceStorageRoot } from "./worktree"

export { normalizeRuntimeSnapshot } from "./routes/config"
export type { AppliedRuntimeSnapshot, RuntimeConnectionDescriptor, RuntimeHarnessSelection, RuntimeNativeHarnessId, RuntimeSnapshot } from "./routes/config"
