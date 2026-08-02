/**
 * Builds the GitHub integration from this deployment's environment.
 *
 * The kit reads no env by design, so the decision "does this server have a
 * GitHub App?" lives here. It is a per-deployment decision, not a build-time
 * one: Claxedo Cloud registers an app, a self-hoster may not, and the same
 * binary serves both. With no app the integration declares the pasted-token
 * method alone — the Connect button never appears rather than appearing and
 * failing at the first request.
 *
 * The client secret is only ever read on this side. The device grant itself
 * needs nothing but the client id, and GitHub does not require the secret to
 * refresh a device-minted token, so a deployment can run the whole flow
 * without one.
 */
import { githubIntegration, type GitHubIntegrationOptions } from "@claxedo/connections"

type Env = Record<string, string | undefined>

const read = (env: Env, ...names: string[]) => {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return undefined
}

export function githubIntegrationForEnv(env: Env, options: GitHubIntegrationOptions = {}) {
  const clientId = read(env, "CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID", "GITHUB_CLIENT_ID")
  const clientSecret = read(env, "CLAXEDO_INTEGRATION_GITHUB_CLIENT_SECRET", "GITHUB_CLIENT_SECRET")
  return githubIntegration({
    ...options,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  })
}
