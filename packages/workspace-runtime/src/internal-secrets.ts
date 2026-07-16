export const LOCAL_DOCUMENT_BROKER_TOKEN_ENV = "CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN"

export type WorkspaceRuntimeInternalSecrets = ReturnType<typeof captureWorkspaceRuntimeInternalSecrets>

let retained: WorkspaceRuntimeInternalSecrets | undefined

export function captureWorkspaceRuntimeInternalSecrets(env: NodeJS.ProcessEnv = process.env) {
  const localDocumentBrokerToken = env[LOCAL_DOCUMENT_BROKER_TOKEN_ENV]?.trim()
  delete env[LOCAL_DOCUMENT_BROKER_TOKEN_ENV]
  return { ...(localDocumentBrokerToken ? { localDocumentBrokerToken } : {}) }
}

export function retainedWorkspaceRuntimeInternalSecrets(env: NodeJS.ProcessEnv = process.env) {
  retained ??= captureWorkspaceRuntimeInternalSecrets(env)
  return retained
}
