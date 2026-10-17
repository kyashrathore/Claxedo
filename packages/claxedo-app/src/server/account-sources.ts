import { asRecord } from "@claxedo/helpers/guards"
import type { AccountsApi, AccountSources } from "./account-types"
import type { AccountWrite } from "./account-writes"
import type { CredentialPlane } from "./credential-plane"
import { CREDENTIALS_PATH } from "./credential-plane"
import { contractMismatch } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import { accountFromWire, accountScopeFromWire, accountSourcesFromWire } from "./wire/accounts"

export function accountSourceQueries(server: string, plane: CredentialPlane) {
  const sources = (): FetchQuery<AccountSources> =>
    fetchQuery(queryKeys.accountSources(server), async () => {
      const answer = accountSourcesFromWire(await plane.sources())
      if (!answer) throw contractMismatch("account sources")
      return answer
    })
  return { sources }
}

export function createAccountSourceWrites(transport: Transport, plane: CredentialPlane, write: AccountWrite): Pick<AccountsApi, "setSource" | "setScope" | "saveOrgAccount"> {
  return {
    setSource: (providerIds, source) => write(async () => void (await plane.setSources(providerIds, source))),
    setScope: (ids, scope) =>
      write(async () => {
        for (const id of ids) {
          const answer = await transport.json(`${CREDENTIALS_PATH}/${encodeURIComponent(id)}/scope`, jsonInit("PATCH", { scope }))
          if (accountScopeFromWire(asRecord(answer)?.scope) !== scope) throw contractMismatch("account scope")
        }
      }),
    saveOrgAccount: (providerId, secret, label) =>
      write(async () => {
        const named = label.trim() ? { label: label.trim() } : {}
        const body = { provider_id: providerId, kind: "api_key", source: "managed", owner: "org", ...named, secret }
        const saved = accountFromWire(asRecord(await plane.save(body))?.credential)
        if (!saved) throw contractMismatch("team account")
        return saved
      }),
  }
}
