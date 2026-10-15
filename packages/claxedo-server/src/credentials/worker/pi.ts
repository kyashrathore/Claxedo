import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { UsageProjectionLedger } from "@claxedo/server-core/usage/ledger"
import { PI_LAUNCH_PROVIDERS, piProviderAccountAmong, projectPiProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-projection"
import type { ControlPlaneCredentials } from "../../authority/services"
import { holderAccountSources, spendsAccount } from "@claxedo/server-core/credentials/account-holder"

const LAST_MODEL_WINDOW_MS = 30 * 24 * 60 * 60_000

/**
 * Production hosted ports: every credential operation is bound to the
 * authority's org. `credentials` is the plane's per-org store, absent while
 * `CLAXEDO_HOSTED_CREDENTIALS_ENABLED` is off. `latestHarnessModel` is the
 * usage ledger's read of the caller's own finished turns, from which a Pi
 * draft that names no model takes the one they last ran, over the last 30
 * days.
 */
export function hostedPiCredentials(input: {
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: ((orgId: string) => ControlPlaneCredentials) | undefined
  latestHarnessModel?: NonNullable<UsageProjectionLedger["latestHarnessModel"]>
}) {
  const latest = input.latestHarnessModel
  return {
    ...(latest
      ? {
          lastHarnessModel: async (auth: SignedControlPlaneAuth, harness: "pi") =>
            latest({ org_id: await input.resolveOrgId(auth), user_id: auth.user.subject, harness, since: Date.now() - LAST_MODEL_WINDOW_MS }),
        }
      : {}),
    piProviderCatalog: async (auth: SignedControlPlaneAuth) => {
      if (!input.credentials) return projectPiProviderCatalog(new Map())
      const store = input.credentials(await input.resolveOrgId(auth))
      const person = auth.user.subject
      const rows = await store.listCredentials()
      const sources = holderAccountSources(await store.accountSelections(), person, person)
      const account = (id: string) => rows.find((row) => row.provider_id === id && spendsAccount(row, person, sources, person))
      return projectPiProviderCatalog(new Map(PI_LAUNCH_PROVIDERS.flatMap((provider) => {
        const found = piProviderAccountAmong(provider, account)
        return found === undefined ? [] : [[provider, found] as const]
      })))
    },
  }
}
