import type { QueryClient } from "@tanstack/solid-query"
import { asRecord } from "@claxedo/helpers/guards"
import type { AccountSources, HostedAccountSources } from "./account-types"
import type { AccountsApi } from "./api"
import { contractMismatch } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import { accountScopeFromWire, accountSourcesFromWire, hostedAccountSourcesFromWire } from "./wire/accounts"

const SOURCES_PATH = "/api/claxedo/credentials/account-sources"

export function accountSourceQueries(transport: Transport) {
  const server = transport.serverUrl
  const sources = (): FetchQuery<AccountSources> =>
    fetchQuery(queryKeys.accountSources(server), async () => {
      const answer = accountSourcesFromWire(await transport.json(SOURCES_PATH))
      if (!answer) throw contractMismatch("account sources")
      return answer
    })
  const hostedSources = (harness: string): FetchQuery<HostedAccountSources> =>
    fetchQuery(queryKeys.hostedAccountSources(server, harness), async () => {
      const answer = hostedAccountSourcesFromWire(await transport.json(withQuery("/auth/sources", { harness })))
      if (!answer) throw contractMismatch("hosted account sources")
      return answer
    })
  return { sources, hostedSources }
}

export function createAccountSourceWrites(transport: Transport, queryClient: QueryClient, changed: () => Promise<void>): Pick<AccountsApi, "setSource" | "setHostedSource" | "setScope"> {
  const server = transport.serverUrl
  return {
    setSource: async (providerIds, source) => {
      await transport.json(SOURCES_PATH, jsonInit("PUT", { provider_ids: providerIds, source }))
      await changed()
    },
    setHostedSource: async (harness, providerId, source) => {
      await transport.json(withQuery(`/auth/${encodeURIComponent(providerId)}/source`, { harness }), jsonInit("PUT", { source }))
      await queryClient.invalidateQueries({ queryKey: queryKeys.hostedAccountSources(server, harness) })
      await queryClient.invalidateQueries({ queryKey: queryKeys.providerCatalogs(server) })
    },
    setScope: async (ids, scope) => {
      try {
        for (const id of ids) {
          const answer = await transport.json(`/api/claxedo/credentials/${encodeURIComponent(id)}/scope`, jsonInit("PATCH", { scope }))
          if (accountScopeFromWire(asRecord(answer)?.scope) !== scope) throw contractMismatch("account scope")
        }
      } finally {
        await changed()
      }
    },
  }
}
