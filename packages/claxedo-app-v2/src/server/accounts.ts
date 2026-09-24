import type { QueryClient } from "@tanstack/solid-query"
import type { Account, AccountCheck, AccountKeyInput, EffectiveAccounts, MachineLogin } from "./account-types"
import type { AccountsApi } from "./api"
import { responseError, ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import { accountCheckFromWire, accountFromWire, machineLoginFromWire, rowsFromWire } from "./wire/accounts"

const CREDENTIALS_PATH = "/api/claxedo/credentials"

async function unlessUnsupported(transport: Transport, path: string): Promise<unknown> {
  const response = await transport.request(path)
  if (response.status === 501) return undefined
  if (!response.ok) throw await responseError(response, `GET ${path}`)
  return response.json()
}

function invalid(what: string): ServerError {
  return new ServerError({ class: "internal", message: `The ${what} answer does not match its contract` })
}

async function readMachineLogins(transport: Transport, query: { readonly harness?: string; readonly fresh?: boolean }): Promise<readonly MachineLogin[]> {
  const path = withQuery(`${CREDENTIALS_PATH}/machine-logins`, { harness: query.harness, fresh: query.fresh ? 1 : undefined })
  const body = await unlessUnsupported(transport, path)
  if (body === undefined) return []
  const logins = rowsFromWire(body, "machine_logins", machineLoginFromWire)
  if (!logins) throw invalid("machine login")
  return logins
}

export function accountQueries(transport: Transport) {
  const server = transport.serverUrl
  const list = (): FetchQuery<readonly Account[]> =>
    fetchQuery(queryKeys.accounts(server), async () => rowsFromWire(await transport.json(CREDENTIALS_PATH), "credentials", accountFromWire) ?? [])
  const effective = (): FetchQuery<EffectiveAccounts> =>
    fetchQuery(queryKeys.accountsEffective(server), async () => {
      const body = await unlessUnsupported(transport, `${CREDENTIALS_PATH}/effective`)
      if (body === undefined) return { kind: "unsupported" }
      return { kind: "listed", accounts: rowsFromWire(body, "credentials", accountFromWire) ?? [] }
    })
  const machineLogins = (): FetchQuery<readonly MachineLogin[]> => fetchQuery(queryKeys.machineLogins(server), () => readMachineLogins(transport, {}))
  return { list, effective, machineLogins }
}

export function createAccountsApi(transport: Transport, queryClient: QueryClient): AccountsApi {
  const server = transport.serverUrl
  const changed = () => queryClient.invalidateQueries({ queryKey: queryKeys.accounts(server) })
  const post = (path: string, body: unknown) => transport.json(`${CREDENTIALS_PATH}${path}`, jsonInit("POST", body))
  return {
    select: async (ids) => {
      await post("/activate", { ids })
      await changed()
    },
    selectMachineLogin: async (providerIds) => {
      await post("/activate", { machine_login: { provider_ids: providerIds } })
      await changed()
    },
    remove: async (ids) => {
      for (const id of ids) await transport.json(`${CREDENTIALS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" })
      await changed()
    },
    check: async (id): Promise<AccountCheck> => {
      const check = accountCheckFromWire(await post(`/${encodeURIComponent(id)}/verify`, {}))
      if (!check) throw invalid("account check")
      await changed()
      return check
    },
    checkMachineLogin: async (harness) => {
      const logins = await readMachineLogins(transport, { harness, fresh: true })
      queryClient.setQueryData<readonly MachineLogin[]>(queryKeys.machineLogins(server), (current) => [
        ...(current ?? []).filter((login) => login.harness !== harness),
        ...logins,
      ])
      return logins
    },
    addKey: async (input: AccountKeyInput) => {
      const body = { provider_id: input.providerId, kind: "api_key", source: "local_only", scope: "local", label: input.label, secret: input.secret }
      const saved = await transport.json<{ credential?: { id?: unknown } }>(CREDENTIALS_PATH, jsonInit("PUT", body))
      const id = saved.credential?.id
      if (typeof id !== "string") throw invalid("key save")
      await changed()
      return id
    },
  }
}
