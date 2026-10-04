import { createKeyedSerializer } from "@claxedo/helpers"
import { isPiLaunchProvider, isProviderUnavailable, PI_LAUNCH_PROVIDERS, piCredentialProviderIDs,
  type ProviderDirect, type ProviderProjection, type TurnAccount } from "@claxedo/agent-runtime-contract"
import { createModels, type AuthContext, type Credential, type CredentialStore, type MutableModels, type OAuthCredential,
  type ProviderAuth } from "@earendil-works/pi-ai"
import type { CustomProviderDefinition, ResolvedCredentials } from "../../contract"
import { customPiProvider } from "./custom-providers"
import { piConfiguration, piCredentialExpired } from "./errors"
import { PI_BUILT_IN_PROVIDERS } from "./launch-catalog"

const NO_AMBIENT_AUTH: AuthContext = { env: async () => undefined, fileExists: async () => false }

export type PiDirectRefresh = (credentialProviderId: string) => Promise<ProviderDirect | undefined>

function credentialOf(row: ProviderDirect): Credential {
  return row.authKind === "api-key" ? { type: "api_key", key: row.secret }
    : { type: "oauth", access: row.secret, refresh: "", expires: row.expiresAt ?? Number.MAX_SAFE_INTEGER }
}

function apiRoot(providerId: string, row: ProviderDirect): string {
  return providerId === "anthropic" ? row.baseUrl : `${row.baseUrl}${row.apiPath ?? ""}`
}

export class PiCredentials {
  readonly models: MutableModels
  private rows: Readonly<Record<string, ProviderDirect>> = {}
  private accounts: Readonly<Record<string, ProviderProjection>> = {}
  private definitions: readonly CustomProviderDefinition[] = []
  private readonly refreshed = new Map<string, Credential>()
  private readonly writes = createKeyedSerializer()

  constructor(credentials: ResolvedCredentials, definitions: readonly CustomProviderDefinition[], private readonly refreshRow: PiDirectRefresh) {
    this.models = createModels({ credentials: this.store(), authContext: NO_AMBIENT_AUTH })
    for (const id of PI_LAUNCH_PROVIDERS) this.models.setProvider({ ...PI_BUILT_IN_PROVIDERS[id](), auth: this.auth(id) })
    this.update(credentials, definitions)
  }

  update(credentials: ResolvedCredentials, definitions: readonly CustomProviderDefinition[]): void {
    this.rows = credentials.direct ?? {}
    this.accounts = credentials.providers
    this.refreshed.clear()
    for (const old of this.definitions) this.models.deleteProvider(old.id)
    this.definitions = definitions.filter((definition) => !isPiLaunchProvider(definition.id))
    for (const definition of this.definitions) this.models.setProvider(customPiProvider(definition, this.auth(definition.id)))
  }

  connected(): string[] {
    return this.models.getProviders().flatMap((provider) => this.direct(provider.id) ? [provider.id] : [])
  }

  catalogProviders(): string[] {
    return this.models.getProviders().flatMap((provider) => this.credentialIds(provider.id).some((id) =>
      Object.hasOwn(this.rows, id) || (Object.hasOwn(this.accounts, id) && !isProviderUnavailable(this.accounts[id]!))) ? [provider.id] : [])
  }

  direct(providerId: string): { credentialProviderId: string; row: ProviderDirect } | undefined {
    const credentialProviderId = this.credentialIds(providerId).find((id) => Object.hasOwn(this.rows, id))
    return credentialProviderId ? { credentialProviderId, row: this.rows[credentialProviderId]! } : undefined
  }

  private credentialIds(providerId: string): readonly string[] {
    const definition = this.definitions.find((candidate) => candidate.id === providerId)
    return definition ? [definition.credentialProviderId] : piCredentialProviderIDs(providerId)
  }

  account(providerId: string): TurnAccount | undefined {
    const account = this.direct(providerId)?.row.account
    return account ? { kind: "stored", harnessId: "pi", ...account } : undefined
  }

  private store(): CredentialStore {
    const read = async (providerId: string) => {
      const row = this.direct(providerId)?.row
      return this.refreshed.get(providerId) ?? (row ? credentialOf(row) : undefined)
    }
    return {
      read,
      list: async () => this.connected().map((providerId) => ({ providerId, type: credentialOf(this.direct(providerId)!.row).type })),
      modify: (providerId, change) => this.writes.run(providerId, async () => {
        const current = await read(providerId)
        const next = await change(current)
        if (next) this.refreshed.set(providerId, next)
        return next ?? current
      }),
      delete: async () => { throw piConfiguration("Claxedo owns Pi's provider sign-in") },
    }
  }

  private auth(providerId: string): ProviderAuth {
    const root = () => { const direct = this.direct(providerId); return direct ? { baseUrl: apiRoot(providerId, direct.row) } : {} }
    return {
      apiKey: { name: providerId, resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key, ...root() } } : undefined },
      oauth: {
        name: providerId, isSubscription: true,
        login: async () => { throw piConfiguration("Claxedo owns Pi's provider sign-in") },
        refresh: (credential) => this.refresh(providerId, credential),
        toAuth: async (credential) => ({ apiKey: credential.access, ...root() }),
      },
    }
  }

  private async refresh(providerId: string, credential: OAuthCredential): Promise<OAuthCredential> {
    const direct = this.direct(providerId)
    const row = direct ? await this.refreshRow(direct.credentialProviderId) : undefined
    const renewed = row ? credentialOf(row) : undefined
    if (renewed?.type !== "oauth" || renewed.expires <= credential.expires) throw piCredentialExpired(providerId)
    return renewed
  }
}
