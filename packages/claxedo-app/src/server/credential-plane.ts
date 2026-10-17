import type { QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import type { AccountSources, SandboxKeys } from "./account-types"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"

export const CREDENTIALS_PATH = "/api/claxedo/credentials"
const SOURCES_PATH = `${CREDENTIALS_PATH}/account-sources`
const SANDBOX_PATH = `${CREDENTIALS_PATH}/sandbox-drivers`

export type CredentialPlane = {
  readonly sources: () => Promise<unknown>
  readonly setSources: (providerIds: readonly string[], source: string) => Promise<unknown>
  readonly sandbox: () => Promise<unknown>
  readonly chooseSandboxDriver: (driver: string | null) => Promise<unknown>
  readonly save: (body: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly verify: (id: string) => Promise<unknown>
  readonly remove: (id: string) => Promise<unknown>
}

export type CredentialPlanes = {
  readonly organization: CredentialPlane
  readonly ofCredential: (id: string) => CredentialPlane
}

function hostedPlane(account: HostedAccount): CredentialPlane {
  return {
    sources: () => account.run("credentials.sources.read"),
    setSources: (providerIds, source) => account.run("credentials.sources.set", { provider_ids: providerIds, source }),
    sandbox: () => account.run("credentials.sandbox.read"),
    chooseSandboxDriver: (driver) => account.run("credentials.sandbox.choose", { driver }),
    save: (body) => account.run("credentials.save", body),
    verify: (id) => account.run("credentials.verify", { id }),
    remove: (id) => account.run("credentials.remove", { id }),
  }
}

function serverPlane(transport: Transport): CredentialPlane {
  const credential = (id: string) => `${CREDENTIALS_PATH}/${encodeURIComponent(id)}`
  return {
    sources: () => transport.json(SOURCES_PATH),
    setSources: (providerIds, source) => transport.json(SOURCES_PATH, jsonInit("PUT", { provider_ids: providerIds, source })),
    sandbox: () => transport.json(SANDBOX_PATH),
    chooseSandboxDriver: (driver) => transport.json(`${SANDBOX_PATH}/default`, jsonInit("PUT", { driver })),
    save: (body) => transport.json(CREDENTIALS_PATH, jsonInit("PUT", body)),
    verify: (id) => transport.json(`${credential(id)}/verify`, jsonInit("POST", {})),
    remove: (id) => transport.json(credential(id), { method: "DELETE" }),
  }
}

export function organizationCredentialPlane(transport: Transport, account: HostedAccount | undefined): CredentialPlane {
  return account ? hostedPlane(account) : serverPlane(transport)
}

function hostedCredentialIds(queryClient: QueryClient, server: string): ReadonlySet<string> {
  const sources = queryClient.getQueryData<AccountSources>(queryKeys.accountSources(server))
  const sandbox = queryClient.getQueryData<SandboxKeys>(queryKeys.sandboxKeys(server))
  return new Set([...(sources?.org ?? []).map((row) => row.id), ...(sandbox?.kind === "listed" ? sandbox.keys.map((row) => row.id) : [])])
}

export function credentialPlanes(transport: Transport, account: HostedAccount | undefined, queryClient: QueryClient): CredentialPlanes {
  const server = serverPlane(transport)
  if (!account) return { organization: server, ofCredential: () => server }
  const hosted = hostedPlane(account)
  return { organization: hosted, ofCredential: (id) => (hostedCredentialIds(queryClient, transport.serverUrl).has(id) ? hosted : server) }
}
