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
export { createIdentityAwareEventSource }
  from "./event-delivery"
export type { EventDeliveryDecision, EventDeliveryPolicy, EventDeliveryPrincipal }
  from "./event-delivery"
/**
 * A host that serves several embedded runtimes behind one stream of its own
 * reads each runtime's frames through `WorkspaceHost.frames` and keeps the
 * runtime's rules for them: this predicate decides what its ring holds back
 * from eviction, and this writer is the one that turns an opened source into
 * a `wr/events` response.
 */
export { isRetainedWorkspaceEventFrame, streamWorkspaceEventFrames }
  from "./routes/events"
export type { WorkspaceEventFramesTap, WorkspaceEventStreamFrame }
  from "./routes/events"
/**
 * The canonical env-trim helper: reads `env[key]` (falling back to an optional
 * legacy key), trims it, and returns `undefined` for blank values. Exported so
 * hosts composing their own boot-policy ladder trim env exactly the way the kit
 * does — instead of re-implementing the trim/blank rules.
 */
export { runtimeEnvText } from "./env"
export { createWorkspaceOpenCodeRuntime } from "./opencode-runtime"
export { createWorkspaceHost } from "./workspace"
export type { WorkspaceHost, WorkspaceHostOptions } from "./workspace"
export {
  managedWorkspaceSessionAccessPolicy,
  sessionAccessRequiresWrite,
  sessionAccessWriteClass,
  SESSION_CORE_ROUTE_ACCESS,
} from "./session-access-policy"
export {
  WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL,
  remoteWorkspaceSessionAccessPolicy,
  remoteWorkspaceSessionAccessPolicyFromEnv,
} from "./remote-session-authority"
export type { AdoptRefusedSession } from "./remote-session-authority"
export type {
  SessionAccessActor,
  SessionAccessAuthor,
  SessionAccessDecision,
  SessionAccessStreamDecision,
  SessionAccessOperation,
  SessionAccessPolicy,
  SessionAccessPolicyInput,
  SessionAuthorityInput,
  SessionAuthorityPredicate,
  SessionWriteClass,
  ManagedWorkspaceSessionAccessPolicyOptions,
  SessionWorkspaceAuthority,
} from "./session-access-policy"
export { Pty } from "./pty/index"
export { defaultWorkspaceHarnessRegistry } from "./workspace/runtime"
export type {
  WorkspaceHarnessAdapterInput,
  WorkspaceHarnessRegistry,
  WorkspaceHarnessRegistryEntry,
  WorkspaceRuntimeStore,
  WorkspaceRuntimeStoreFactory,
} from "./workspace/runtime"
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
export { createProcessObserver } from "./managed-processes/process-observer"
export {
  createMemoryTranscriptHandleStore,
  createPersistentTranscriptHandleStore,
  createTranscriptResolver,
} from "./transcript-resolver"
export type {
  TranscriptHandleStore,
  TranscriptHandleBinding,
  TranscriptProvider,
  TranscriptResolution,
  TranscriptUnavailable,
} from "./transcript-resolver"
export { WorkspaceWorktreeManager, workspaceStorageRoot } from "./worktree"
export type { WorkspaceWorktreeRecord } from "./store"
export type {
  ProcessObserver,
  ProcessObserverEvent,
  ProcessObserverSink,
  ProcessOwnerCapabilities,
  ProcessOwnerDescriptor,
  ProcessOwnerExit,
  ProcessOwnerHandle,
  ProcessOwnerKind,
  ProcessOwnerOperations,
  ProcessOwnerRole,
} from "./managed-processes/process-observer"
export { normalizeRuntimeSnapshot }
  from "./routes/config"
export type {
  AppliedRuntimeSnapshot,
  RuntimeConnectionDescriptor,
  RuntimeHarnessSelection,
  RuntimeNativeHarnessId,
  RuntimeSnapshot,
}
  from "./routes/config"
