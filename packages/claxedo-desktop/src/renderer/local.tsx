/**
 * The UNSIGNED desktop renderer entry.
 *
 * This is the one base entry for every desktop build. An official release may
 * emit `hosted-contributions.ts` as a separate hashed chunk, but this module
 * neither imports the auth vendor client nor receives a bearer. Electron main owns the account;
 * the existing AccountPort lifecycle asks the loader below for that optional
 * chunk only after main reports a signed account.
 *
 * Concretely, what this entry does NOT import, and why each matters:
 *
 *   - `@claxedo/app/auth` — the package's authenticated-identity subpath, and
 *     the edge by which the old renderer reached `auth-client.ts` and the auth vendor client.
 *   - `@/platform/remote-access/machine-remote-access`'s binder — it lives in
 *     the optional chunk and cannot execute before account-driven activation.
 *
 * And what it therefore never binds: `configureApiRuntime({ bearerToken })` or
 * `configureAuthSession`. The renderer has no account secret. Named hosted
 * operations cross the Electron AccountPort instead.
 *
 * `renderer-entry-closure.guard.test.ts` asserts those absences against the
 * real static import graph rather than trusting this comment.
 */

// @refresh reload
import { startDesktopRenderer } from "./shell"

const loadHostedContributions = __CLAXEDO_HOSTED_ACTIVATION_ENABLED__
  ? async () => {
      const activation = await import("./hosted-contributions")
      return activation.loadDesktopHostedContributions()
    }
  : undefined

const serviceContributionLoaders = __CLAXEDO_HOSTED_ACTIVATION_ENABLED__
  ? {
      documents: async () => {
        const activation = await import("./documents-contributions")
        return activation.loadDesktopDocumentsContributions()
      },
    }
  : undefined

const loadAgentPluginContributions = __CLAXEDO_AGENT_PLUGINS_ENABLED__
  ? async () => (await import("@/app/composition/agent-plugin-contribution-loader")).agentPluginContributions()
  : undefined

startDesktopRenderer({ loadHostedContributions, serviceContributionLoaders, loadAgentPluginContributions })
