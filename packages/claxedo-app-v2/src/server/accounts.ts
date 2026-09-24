import type { Account } from "./account-types"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery } from "./types"
import { accountFromWire } from "./wire/accounts"

const CREDENTIALS_PATH = "/api/claxedo/credentials"

export function accountQueries(transport: Transport) {
  const list = (): FetchQuery<readonly Account[]> => fetchQuery(queryKeys.accounts(transport.serverUrl), async () => {
    const body = await transport.json<{ credentials?: unknown }>(CREDENTIALS_PATH)
    return (Array.isArray(body.credentials) ? body.credentials : []).flatMap((row) => {
      const account = accountFromWire(row)
      return account ? [account] : []
    })
  })
  return { list }
}
