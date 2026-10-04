import { Hono } from "hono"
import { RuntimeConnectionSecretRoutes, type RuntimeConnectionSecretOptions } from "./runtime-connection-secrets"
import { RuntimeCredentialRefreshRoutes, type RuntimeCredentialRefreshOptions } from "./runtime-credential-refresh"

export type RuntimeSandboxSecretOptions = {
  connectionSecrets?: RuntimeConnectionSecretOptions
  credentialRefresh?: RuntimeCredentialRefreshOptions
}

type SandboxProofs = Omit<Parameters<typeof RuntimeConnectionSecretRoutes>[0], keyof RuntimeConnectionSecretOptions>

/**
 * The secrets a cloud sandbox asks for while it works, each under the proof of
 * the operation that needs it: a connection's secret lease and a renewal of
 * the ChatGPT plan it was handed. Each is served only where its options are.
 */
export function RuntimeSandboxSecretRoutes(options: RuntimeSandboxSecretOptions, proofs: SandboxProofs) {
  const app = new Hono()
  if (options.connectionSecrets) app.route("/connection-secrets", RuntimeConnectionSecretRoutes({ ...options.connectionSecrets, ...proofs }))
  if (options.credentialRefresh) app.route("/credential-refresh", RuntimeCredentialRefreshRoutes({ ...options.credentialRefresh, ...proofs }))
  return app
}
