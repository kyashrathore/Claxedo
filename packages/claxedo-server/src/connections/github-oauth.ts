/**
 * Builds the GitHub integration from this deployment's environment.
 *
 * The kit reads no env by design, so the decision "does this server have a
 * GitHub App?" lives here. It is a per-deployment decision, not a build-time
 * one: Claxedo Cloud registers an app, a self-hoster may not, and the same
 * binary serves both. The app is named by `CLAXEDO_INTEGRATION_GITHUB_*` alone:
 * `GITHUB_CLIENT_ID` is the sign-in OAuth app, whose device grant would ask
 * for an OAuth scope instead of the app's installed permissions. With no app
 * the integration declares the pasted-token method alone — the Connect button
 * never appears rather than appearing and failing at the first request.
 *
 * The client secret is only ever read on this side. The device grant itself
 * needs nothing but the client id, and GitHub does not require the secret to
 * refresh a device-minted token, so a deployment can run the whole flow
 * without one.
 */
import { githubIntegration, type GitHubIntegrationOptions } from "@claxedo/connections"
import { envText } from "@claxedo/helpers/env"

type Env = Record<string, string | undefined>

export function githubIntegrationForEnv(env: Env, options: GitHubIntegrationOptions = {}) {
  const clientId = envText(env, "CLAXEDO_INTEGRATION_GITHUB_CLIENT_ID")
  const clientSecret = envText(env, "CLAXEDO_INTEGRATION_GITHUB_CLIENT_SECRET")
  return githubIntegration({
    ...options,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  })
}
