// target-layer: session
//
// The default model a signed control-plane (cloud / user-hosted) workspace
// session falls back to when the server has not yet reported a concrete model
// for it. "big-pickle" is the internal id of the hosted OpenCode default model;
// the server assigns it, and session-client only needs a stable local
// placeholder so the composer can render and submit before the authoritative
// model list has loaded.
//
// This id is singled out in two places:
//   1. `createSignedWorkspaceRuntimeFallback` (runtime-fallback.ts) returns it as
//      the fallback model for signed workspaces with no other model info.
//   2. `firstConnectedModelInfo` (model-strategy.ts) treats it as a KNOWN-STALE
//      provider default: when the server's `default` map still points at this id
//      we skip it and pick the first real connected model instead, so a user
//      never gets stuck on the placeholder once real models exist.
//
// Keeping the literal in one place means a future rename/retirement of the
// hosted default only has to change here, and both call sites stay in sync.

export const SIGNED_WORKSPACE_DEFAULT_MODEL = {
  id: "big-pickle",
  name: "Big Pickle",
  provider: { id: "opencode" },
} as const

export const SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER = SIGNED_WORKSPACE_DEFAULT_MODEL.provider.id
export const SIGNED_WORKSPACE_DEFAULT_MODEL_ID = SIGNED_WORKSPACE_DEFAULT_MODEL.id
