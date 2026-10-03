import type { AccountSource } from "@claxedo/account-contract/vocabulary"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { HTTPException } from "hono/http-exception"
import { PI_LAUNCH_PROVIDERS, piCredentialConnected, piCredentialProviderIDs, projectPiProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-projection"
import type { ControlPlaneCredentials } from "../../authority/services"
import { holderAccountSources, spendsAccount, type AccountSources } from "@claxedo/server-core/credentials/account-holder"

function credentialError(status: 400 | 503, code: string, message: string) {
  return new HTTPException(status, { res: Response.json({ error: { code, message } }, { status }) })
}

/**
 * Production hosted ports: every credential operation is bound to the
 * authority's org. `credentials` is the plane's per-org store, absent while
 * `CLAXEDO_HOSTED_CREDENTIALS_ENABLED` is off.
 */
export function hostedPiCredentials(input: {
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: ((orgId: string) => ControlPlaneCredentials) | undefined
  changed?: (orgId: string) => Promise<void>
}) {
  const credentials = async (auth: SignedControlPlaneAuth) => {
    if (!input.credentials) throw credentialError(503, "pi_credentials_unavailable", "Hosted credentials are disabled")
    return input.credentials(await input.resolveOrgId(auth))
  }
  return {
    piProviderCatalog: async (auth: SignedControlPlaneAuth) => {
      if (!input.credentials) return projectPiProviderCatalog(new Set())
      const store = await credentials(auth)
      const person = auth.user.subject
      const rows = await store.listCredentials()
      const sources = holderAccountSources(await store.accountSelections(), person, person)
      const account = (id: string) => rows.find((row) => row.provider_id === id && spendsAccount(row, person, sources, person))
      return projectPiProviderCatalog(new Set(PI_LAUNCH_PROVIDERS.filter((provider) =>
        piCredentialProviderIDs(provider).some((id) => piCredentialConnected(provider, account(id))))))
    },
    piAccountSources: async (auth: SignedControlPlaneAuth) => {
      const store = await credentials(auth)
      const person = auth.user.subject
      const sources = holderAccountSources(await store.accountSelections(), person, person)
      const rows = await store.listCredentials()
      return {
        sources: Object.fromEntries(PI_LAUNCH_PROVIDERS.map((provider) => [provider, piAccountSource(provider, sources)])),
        org: PI_LAUNCH_PROVIDERS.filter((provider) => piCredentialProviderIDs(provider)
          .some((id) => rows.some((row) => row.owner === null && row.provider_id === id))),
      }
    },
    putPiAccountSource: async (auth: SignedControlPlaneAuth, providerID: string, source: AccountSource) => {
      const ids = piCredentialProviderIDs(providerID)
      if (!ids.length) throw credentialError(400, "pi_provider_unsupported", "Unknown Pi provider")
      const orgId = await input.resolveOrgId(auth)
      await (await credentials(auth)).setAccountSources(ids, source, undefined, auth.user.subject)
      await input.changed?.(orgId)
    },
    deletePiCredential: async (auth: SignedControlPlaneAuth, providerID: string) => {
      const ids = piCredentialProviderIDs(providerID)
      if (!ids.length) throw credentialError(400, "pi_provider_unsupported", "Unknown Pi provider")
      const orgId = await input.resolveOrgId(auth)
      const store = await credentials(auth)
      for (const row of await store.listCredentials()) {
        if (row.owner === auth.user.subject && ids.includes(row.provider_id)) await store.deleteCredential(row.id)
      }
      await input.changed?.(orgId)
    },
  }
}

/** A Pi provider spends the org account only when every credential it resolves through does. */
function piAccountSource(provider: string, sources: AccountSources): AccountSource {
  return piCredentialProviderIDs(provider).every((id) => sources[id] === "org") ? "org" : "own"
}
