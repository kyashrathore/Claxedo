import { asRecord } from "@claxedo/helpers/guards"
import type { AccountSources } from "./account-types"
import type { AccountsApi } from "./api"
import type { AccountWrite } from "./account-writes"
import { contractMismatch } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import { accountScopeFromWire, accountSourcesFromWire } from "./wire/accounts"

const SOURCES_PATH = "/api/claxedo/credentials/account-sources"

export function accountSourceQueries(transport: Transport) {
  const server = transport.serverUrl
  const sources = (): FetchQuery<AccountSources> =>
    fetchQuery(queryKeys.accountSources(server), async () => {
      const answer = accountSourcesFromWire(await transport.json(SOURCES_PATH))
      if (!answer) throw contractMismatch("account sources")
      return answer
    })
  return { sources }
}

export function createAccountSourceWrites(transport: Transport, write: AccountWrite): Pick<AccountsApi, "setSource" | "setScope"> {
  return {
    setSource: (providerIds, source) => write(async () => void (await transport.json(SOURCES_PATH, jsonInit("PUT", { provider_ids: providerIds, source })))),
    setScope: (ids, scope) =>
      write(async () => {
        for (const id of ids) {
          const answer = await transport.json(`/api/claxedo/credentials/${encodeURIComponent(id)}/scope`, jsonInit("PATCH", { scope }))
          if (accountScopeFromWire(asRecord(answer)?.scope) !== scope) throw contractMismatch("account scope")
        }
      }),
  }
}
