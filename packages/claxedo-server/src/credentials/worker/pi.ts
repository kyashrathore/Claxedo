import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { HTTPException } from "hono/http-exception"
import { PI_LAUNCH_PROVIDERS, piCredentialConnected, piCredentialProviderIDs, projectPiProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-projection"
import { hostedCredentialsEnabled, hostedOrgCredentials } from "./index"

function credentialError(status: 400 | 503, code: string, message: string) {
  return new HTTPException(status, { res: Response.json({ error: { code, message } }, { status }) })
}

/** Production hosted ports: every credential operation is bound to the authority's org. */
export function hostedPiCredentials(input: {
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  env: Record<string, string | undefined>
}) {
  const credentials = async (auth: SignedControlPlaneAuth) => {
    if (!hostedCredentialsEnabled(input.env)) throw credentialError(503, "pi_credentials_unavailable", "Hosted credentials are disabled")
    return hostedOrgCredentials(await input.resolveOrgId(auth), input.env)
  }
  return {
    piProviderCatalog: async (auth: SignedControlPlaneAuth) => {
      if (!hostedCredentialsEnabled(input.env)) return projectPiProviderCatalog(new Set())
      const store = await credentials(auth)
      const connected = await Promise.all(PI_LAUNCH_PROVIDERS.map(async (provider) => {
        for (const id of piCredentialProviderIDs(provider)) {
          if (piCredentialConnected(provider, await store.getCredentialByProvider(id))) return provider
        }
        return undefined
      }))
      return projectPiProviderCatalog(new Set(connected.filter((id): id is NonNullable<typeof id> => !!id)))
    },
    putPiCredential: async (auth: SignedControlPlaneAuth, providerID: string, key: string) => {
      if (providerID !== "anthropic" && providerID !== "openai") {
        throw credentialError(400, "pi_provider_unsupported", "This Pi provider does not accept API keys")
      }
      const store = await credentials(auth)
      await store.putCredential({ provider_id: providerID, kind: "api_key", source: "managed", secret: key })
    },
    deletePiCredential: async (auth: SignedControlPlaneAuth, providerID: string) => {
      const ids = piCredentialProviderIDs(providerID)
      if (!ids.length) throw credentialError(400, "pi_provider_unsupported", "Unknown Pi provider")
      const store = await credentials(auth)
      for (const id of ids) await store.deleteCredentialsByProvider(id)
    },
  }
}
