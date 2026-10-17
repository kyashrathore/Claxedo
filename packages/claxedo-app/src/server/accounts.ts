import type { QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import { accountCheckAnswer, accountRemovalAnswer } from "./account-answers"
import type { Account, AccountCheck, AccountsApi, EffectiveAccounts, MachineLogin } from "./account-types"
import { accountSourceQueries, createAccountSourceWrites } from "./account-sources"
import { accountWrites } from "./account-writes"
import { contractMismatch, responseError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import { accountFromWire, machineLoginFromWire, rowsFromWire } from "./wire/accounts"
import { createSandboxKeyWrites, sandboxKeyPlane, sandboxKeyQueries } from "./sandbox-keys"

const CREDENTIALS_PATH = "/api/claxedo/credentials"

async function unlessUnsupported(transport: Transport, path: string): Promise<unknown> {
  const response = await transport.request(path)
  if (response.status === 501) return undefined
  if (!response.ok) throw await responseError(response, `GET ${path}`)
  return response.json()
}

async function fetchMachineLogins(transport: Transport, query: { readonly harness?: string; readonly fresh?: boolean }): Promise<readonly MachineLogin[]> {
  const path = withQuery(`${CREDENTIALS_PATH}/machine-logins`, { harness: query.harness, fresh: query.fresh ? 1 : undefined })
  const body = await unlessUnsupported(transport, path)
  if (body === undefined) return []
  const logins = rowsFromWire(body, "machine_logins", machineLoginFromWire)
  if (!logins) throw contractMismatch("machine login")
  return logins
}

export function accountQueries(transport: Transport, account: HostedAccount | undefined) {
  const server = transport.serverUrl
  const list = (): FetchQuery<readonly Account[]> =>
    fetchQuery(queryKeys.accounts(server), async () => rowsFromWire(await transport.json(CREDENTIALS_PATH), "credentials", accountFromWire) ?? [])
  const effective = (): FetchQuery<EffectiveAccounts> =>
    fetchQuery(queryKeys.accountsEffective(server), async () => {
      const body = await unlessUnsupported(transport, `${CREDENTIALS_PATH}/effective`)
      if (body === undefined) return { kind: "unsupported" }
      return { kind: "listed", accounts: rowsFromWire(body, "credentials", accountFromWire) ?? [] }
    })
  const machineLogins = (): FetchQuery<readonly MachineLogin[]> => fetchQuery(queryKeys.machineLogins(server), () => fetchMachineLogins(transport, {}))
  return { list, effective, machineLogins, ...accountSourceQueries(transport), ...sandboxKeyQueries(server, sandboxKeyPlane(transport, account)) }
}

export function createAccountsApi(transport: Transport, queryClient: QueryClient, account: HostedAccount | undefined): AccountsApi {
  const { refresh, write } = accountWrites(queryClient, transport.serverUrl)
  const post = (path: string, body: unknown) => transport.json(`${CREDENTIALS_PATH}${path}`, jsonInit("POST", body))
  return {
    ...createAccountSourceWrites(transport, write),
    ...createSandboxKeyWrites(sandboxKeyPlane(transport, account), write),
    ...createMachineLoginScans(transport, queryClient),
    select: (ids) => write(async () => void (await post("/activate", { ids }))),
    selectMachineLogin: (providerIds) => write(async () => void (await post("/activate", { machine_login: { provider_ids: providerIds } }))),
    remove: (ids) =>
      write(async () => {
        for (const id of ids) accountRemovalAnswer(await transport.json(`${CREDENTIALS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" }))
      }),
    check: (id) => write(async (): Promise<AccountCheck> => accountCheckAnswer(await post(`/${encodeURIComponent(id)}/verify`, {}))),
    refresh,
  }
}

function createMachineLoginScans(transport: Transport, queryClient: QueryClient): Pick<AccountsApi, "checkMachineLogin" | "rescan"> {
  const server = transport.serverUrl
  return {
    checkMachineLogin: async (harness) => {
      const logins = await fetchMachineLogins(transport, { harness, fresh: true })
      queryClient.setQueryData<readonly MachineLogin[]>(queryKeys.machineLogins(server), (current) => [
        ...(current ?? []).filter((login) => login.harness !== harness),
        ...logins,
      ])
      return logins
    },
    rescan: async () => {
      const logins = await fetchMachineLogins(transport, { fresh: true })
      queryClient.setQueryData<readonly MachineLogin[]>(queryKeys.machineLogins(server), logins)
      await queryClient.invalidateQueries({ queryKey: queryKeys.accounts(server), predicate: (query) => query.queryKey[3] !== "machine-logins" })
    },
  }
}
