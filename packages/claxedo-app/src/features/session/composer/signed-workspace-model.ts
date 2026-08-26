//
// The server may report this legacy placeholder before a signed workspace has
// a concrete model. It has no serving path and must never make the composer
// submit-ready.
//
// Model selection and submit transport share this identity so the placeholder
// is filtered consistently before it can reach session configuration.

export const SIGNED_WORKSPACE_DEFAULT_MODEL = {
  id: "big-pickle",
  name: "Big Pickle",
  provider: { id: "opencode" },
} as const

export const SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER = SIGNED_WORKSPACE_DEFAULT_MODEL.provider.id
export const SIGNED_WORKSPACE_DEFAULT_MODEL_ID = SIGNED_WORKSPACE_DEFAULT_MODEL.id

export function isSignedWorkspaceDefaultModel(model: { id: string; provider: { id: string } } | undefined) {
  return (
    model?.id === SIGNED_WORKSPACE_DEFAULT_MODEL_ID && model.provider.id === SIGNED_WORKSPACE_DEFAULT_MODEL_PROVIDER
  )
}
