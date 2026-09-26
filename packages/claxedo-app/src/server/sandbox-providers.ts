import type { QueryClient } from "@tanstack/solid-query"
import { readArray, readBoolean, readField, readString } from "../lib/record"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { ask } from "./answer"
import { jsonInit, type Transport } from "./transport"
import { SANDBOX_DRIVERS_PATH, sandboxDriverAuthPath } from "./wire/sandbox-drivers"
import type { FetchQuery } from "./types"

export type SandboxProviderField = { readonly key: string; readonly label: string; readonly secret: boolean }

export type SandboxProviderVerification = { readonly state: "working" | "broken" | "unknown"; readonly reason?: string }

export type SandboxProviderOption = {
  readonly id: string
  readonly label: string
  readonly fields: readonly SandboxProviderField[]
  readonly configured: boolean
  readonly isDefault: boolean
  readonly verification?: SandboxProviderVerification
}

export type SandboxProviderCatalog = { readonly providers: readonly SandboxProviderOption[]; readonly defaultProviderId?: string }

export type SandboxProviderFailure = "missing" | "unsupported" | "rejected" | "unmanaged" | "failed"

export type SandboxProviderSaveOutcome =
  | { readonly ok: true; readonly catalog: SandboxProviderCatalog; readonly verification?: SandboxProviderVerification }
  | { readonly ok: false; readonly failure: SandboxProviderFailure; readonly reason?: string }

export type SandboxProviderQueries = { readonly catalog: () => FetchQuery<SandboxProviderCatalog> }

export type SandboxProvidersApi = { readonly saveKey: (providerId: string, values: Readonly<Record<string, string>>) => Promise<SandboxProviderSaveOutcome> }

function verificationOf(value: unknown): SandboxProviderVerification | undefined {
  const state = readString(value, "state")
  if (state !== "working" && state !== "broken" && state !== "unknown") return undefined
  const reason = readString(value, "reason")
  return { state, ...(reason ? { reason } : {}) }
}

function fieldsOf(value: unknown[] | undefined): SandboxProviderField[] {
  return (value ?? []).flatMap((item) => {
    const key = readString(item, "key")
    return key === undefined ? [] : [{ key, label: readString(item, "label") ?? key, secret: readBoolean(item, "secret") === true }]
  })
}

function catalogOf(body: unknown): SandboxProviderCatalog {
  const defaultProviderId = readString(body, "default_driver")
  const providers = (readArray(body, "drivers") ?? []).flatMap((value): SandboxProviderOption[] => {
    const id = readString(value, "id")
    if (id === undefined) return []
    const verification = verificationOf(readField(value, "verification"))
    return [{
      id,
      label: readString(value, "label") ?? id,
      fields: fieldsOf(readArray(value, "fields")),
      configured: readBoolean(value, "configured") === true,
      isDefault: defaultProviderId ? id === defaultProviderId : readBoolean(value, "default") === true,
      ...(verification ? { verification } : {}),
    }]
  })
  return { providers, ...(defaultProviderId ? { defaultProviderId } : {}) }
}

function saveFailure(status: number, body: unknown): SandboxProviderSaveOutcome {
  const error = readField(body, "error")
  const reason = (readString(error, "reason") ?? readString(readField(error, "data"), "reason"))?.trim()
  const code = `${readString(error, "code") ?? readString(body, "code") ?? ""} ${readString(error, "message") ?? ""}`.toLowerCase()
  const failure: SandboxProviderFailure = code.includes("missing")
    ? "missing"
    : code.includes("unsupported")
      ? "unsupported"
      : status === 401 || status === 403 || code.includes("unauthor")
        ? "rejected"
        : status === 404
          ? "unmanaged"
          : "failed"
  return { ok: false, failure, ...(reason ? { reason } : {}) }
}

export function sandboxProviderQueries(transport: Transport): SandboxProviderQueries {
  return { catalog: () => fetchQuery(queryKeys.sandboxProviders(transport.serverUrl), async () => catalogOf(await transport.json<unknown>(SANDBOX_DRIVERS_PATH))) }
}

export function createSandboxProvidersApi(transport: Transport, queryClient: QueryClient): SandboxProvidersApi {
  return {
    saveKey: async (providerId, values) => {
      const answer = await ask(transport, sandboxDriverAuthPath(providerId), jsonInit("PUT", { auth: values, default: true }))
      if (answer.kind === "unreachable") return { ok: false, failure: "failed" }
      const body = answer.body
      if (!answer.ok) return saveFailure(answer.status, body)
      const catalog = catalogOf(body)
      queryClient.setQueryData(queryKeys.sandboxProviders(transport.serverUrl), catalog)
      const verification = verificationOf(readField(body, "verification"))
      return { ok: true, catalog, ...(verification ? { verification } : {}) }
    },
  }
}
