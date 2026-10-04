import type { QueryClient } from "@tanstack/solid-query"
import { readFiniteNumber, readString } from "@claxedo/helpers/readers"
import { contractMismatch, ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import { customProviderBody } from "./wire/custom-provider"
import type { ProviderSource } from "./wire/provider-catalog"
import type { FetchQuery } from "./types"

const AUTH_PATH = "/api/claxedo/agent-config/providers/auth"
const CREDENTIALS_PATH = "/api/claxedo/credentials"
const CUSTOM_PATH = "/api/claxedo/agent-config/providers/custom"

export type ProviderAuthMethod = { readonly type: string; readonly label: string; readonly command?: string }

export type ProviderAuthMethods = Readonly<Record<string, readonly ProviderAuthMethod[]>>

export type ProviderAuthorization = { readonly url: string; readonly method: "auto" | "code"; readonly instructions: string; readonly attempt?: string }

export type ProviderKeyInput = { readonly providerId: string; readonly label: string; readonly secret: string }

export type CustomProviderConfig = {
  readonly providerId: string
  readonly name: string
  readonly baseURL: string
  readonly env: readonly string[]
  readonly headers: Readonly<Record<string, string>>
  readonly credentialHeader: { readonly name: string; readonly scheme?: "Bearer" }
  readonly models: Readonly<Record<string, { readonly name: string }>>
}

export type CustomProviderDraft = { readonly config: CustomProviderConfig; readonly key?: string }

export type ProviderConnectQueries = { readonly authMethods: (harness: string) => FetchQuery<ProviderAuthMethods> }

export type ProviderConnectApi = {
  readonly authorize: (providerId: string, method: number) => Promise<ProviderAuthorization | undefined>
  readonly callback: (providerId: string, method: number, step: { readonly code?: string; readonly attempt?: string }) => Promise<void>
  readonly saveKey: (input: ProviderKeyInput) => Promise<void>
  readonly reconnect: (credentialId: string, secret: string) => Promise<void>
  readonly disconnect: (harness: string, provider: { readonly id: string; readonly source?: ProviderSource }) => Promise<void>
  readonly saveCustomProvider: (draft: CustomProviderDraft) => Promise<void>
}

function methodsOf(value: unknown): ProviderAuthMethod[] {
  return (Array.isArray(value) ? value : []).flatMap((item): ProviderAuthMethod[] => {
    const type = readString(item, "type")
    if (type === undefined) return []
    const command = readString(item, "command")
    return [{ type, label: readString(item, "label") ?? "", ...(command ? { command } : {}) }]
  })
}

function authMethodsOf(body: unknown): ProviderAuthMethods {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw contractMismatch("provider authentication")
  return Object.fromEntries(Object.entries(body).map(([providerId, methods]) => [providerId, methodsOf(methods)]))
}

function authorizationOf(body: unknown): ProviderAuthorization | undefined {
  const url = readString(body, "url")
  const method = readString(body, "method")
  if (!url || (method !== "auto" && method !== "code")) return undefined
  const attempt = readString(body, "attempt")
  return { url, method, instructions: readString(body, "instructions") ?? "", ...(attempt ? { attempt } : {}) }
}

export function providerConnectQueries(transport: Transport): ProviderConnectQueries {
  return {
    authMethods: (harness) =>
      fetchQuery(queryKeys.providerAuth(transport.serverUrl, harness), async () => authMethodsOf(await transport.json(withQuery(AUTH_PATH, { nativeHarness: harness })))),
  }
}

export function createProviderConnectApi(transport: Transport, queryClient: QueryClient): ProviderConnectApi {
  const server = transport.serverUrl
  const changed = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.accounts(server) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.providerCatalogs(server) })
  }
  const oauthPath = (providerId: string, step: "authorize" | "callback") => `/provider/${encodeURIComponent(providerId)}/oauth/${step}`
  return {
    authorize: async (providerId, method) => authorizationOf(await transport.json(oauthPath(providerId, "authorize"), jsonInit("POST", { method }))),
    callback: async (providerId, method, step) => {
      await transport.json(oauthPath(providerId, "callback"), jsonInit("POST", {
        method, ...(step.code ? { code: step.code } : {}), ...(step.attempt ? { attempt: step.attempt } : {}),
      }))
      await changed()
    },
    saveKey: async (input) => {
      await transport.json(CREDENTIALS_PATH, jsonInit("PUT", { provider_id: input.providerId, kind: "api_key", source: "managed", label: input.label, secret: input.secret }))
      await changed()
    },
    reconnect: async (credentialId, secret) => {
      await transport.json(`${CREDENTIALS_PATH}/${encodeURIComponent(credentialId)}/reconnect`, jsonInit("POST", { secret }))
      await changed()
    },
    saveCustomProvider: async (draft) => {
      const config = draft.config
      if (draft.key) await transport.json(CREDENTIALS_PATH, jsonInit("PUT", { provider_id: config.providerId, kind: "api_key", source: "managed", label: config.name, secret: draft.key }))
      await transport.json(withQuery(CUSTOM_PATH, { nativeHarness: "opencode" }), jsonInit("PUT", customProviderBody(config)))
      await changed()
    },
    disconnect: async (harness, provider) => {
      const removed = await transport.json(`${CREDENTIALS_PATH}/provider/${encodeURIComponent(provider.id)}`, { method: "DELETE" })
      if (provider.source !== "custom" && !((readFiniteNumber(removed, "deleted") ?? 0) > 0)) {
        throw new ServerError({ class: "not_found", message: `No ${provider.id} account of yours was stored to disconnect` })
      }
      if (provider.source === "custom") await transport.json(withQuery(`${CUSTOM_PATH}/${encodeURIComponent(provider.id)}`, { nativeHarness: harness }), { method: "DELETE" })
      await changed()
    },
  }
}
