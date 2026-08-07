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
  RuntimeHarness,
  RuntimeRunner,
  RuntimeSnapshot,
  RuntimeSnapshotV1,
  RuntimeSnapshotV2,
}
  from "./routes/config"
