import type { QueryClient } from "@tanstack/solid-query"
import { readArray, readBoolean, readField, readFiniteNumber, readString } from "../lib/record"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { ask } from "./answer"
import { jsonInit, type Transport } from "./transport"
import type { CodeHostConnection } from "./cloud-types"
import type { FetchQuery } from "./types"

const INTEGRATIONS_PATH = "/api/claxedo/integrations"
const CODE_HOST_CAPABILITY = "code-host"
const GRANT_LIFETIME_MS = 15 * 60 * 1000

export type IntegrationPrompt = {
  readonly id: string
  readonly label: string
  readonly placeholder?: string
  readonly createUrl?: string
  readonly secret: boolean
}

export type Integration = {
  readonly id: string
  readonly name: string
  readonly methods: readonly ("key" | "oauth")[]
  readonly capabilities: readonly string[]
  readonly prompts: readonly IntegrationPrompt[]
}

export type ConnectionScope = "team" | "personal"

export type Connection = {
  readonly id: string
  readonly integrationId: string
  readonly scope: ConnectionScope
  readonly accountLabel?: string
  readonly status: "connected" | "degraded" | "broken"
}

export type IntegrationsCatalog = {
  readonly integrations: readonly Integration[]
  readonly connections: readonly Connection[]
  readonly personalScopeEnabled: boolean
}

export type IntegrationGrant = { readonly attemptId: string; readonly url: string; readonly userCode?: string; readonly intervalMs: number }

export type IntegrationFailure = "exists" | "rejected" | "unoffered" | "unreachable" | "expired" | "denied" | "gone" | "timeout" | "failed"

export type IntegrationConnectOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "authorize"; readonly grant: IntegrationGrant }
  | { readonly kind: "failed"; readonly reason: IntegrationFailure; readonly status?: number; readonly code?: string; readonly verifyReason?: string }

export type IntegrationGrantOutcome = { readonly kind: "connected" } | { readonly kind: "failed"; readonly reason: IntegrationFailure } | { readonly kind: "abandoned" }

type ConnectOptions = { readonly scope?: ConnectionScope; readonly confirmReplace?: boolean }

export type IntegrationConnectInput =
  | (ConnectOptions & { readonly method: "oauth" })
  | (ConnectOptions & { readonly method: "key"; readonly secret: string; readonly fields?: Readonly<Record<string, string>> })

export type IntegrationQueries = { readonly catalog: () => FetchQuery<IntegrationsCatalog> }

export type IntegrationsApi = {
  readonly connect: (integrationId: string, input: IntegrationConnectInput) => Promise<IntegrationConnectOutcome>
  readonly awaitGrant: (grant: IntegrationGrant, alive: () => boolean) => Promise<IntegrationGrantOutcome>
  readonly disconnect: (connectionId: string) => Promise<void>
  readonly reverify: (connectionId: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly verifyReason?: string }>
}

export function codeHostIntegrations(catalog: IntegrationsCatalog | undefined): readonly Integration[] {
  return (catalog?.integrations ?? []).filter((integration) => integration.capabilities.includes(CODE_HOST_CAPABILITY))
}

export function codeHostConnections(catalog: IntegrationsCatalog | undefined): readonly CodeHostConnection[] {
  const names = new Map(codeHostIntegrations(catalog).map((integration) => [integration.id, integration.name]))
  return (catalog?.connections ?? []).flatMap((connection) => {
    const providerName = names.get(connection.integrationId)
    if (!providerName) return []
    return [{ id: connection.id, providerName, ...(connection.accountLabel ? { accountLabel: connection.accountLabel } : {}), status: connection.status }]
  })
}

function httpsLink(value: string | undefined) {
  if (!value) return undefined
  return URL.canParse(value) && new URL(value).protocol === "https:" ? value : undefined
}

function integrationPromptFromWire(value: unknown): IntegrationPrompt[] {
  const id = readString(value, "id")
  if (id === undefined) return []
  const placeholder = readString(value, "placeholder")
  const createUrl = httpsLink(readString(value, "createUrl"))
  return [{ id, label: readString(value, "label") ?? id, ...(placeholder ? { placeholder } : {}), ...(createUrl ? { createUrl } : {}), secret: readBoolean(value, "secret") === true }]
}

function integrationOf(value: unknown): Integration[] {
  const id = readString(value, "id")
  if (id === undefined) return []
  const methods = (readArray(value, "methods") ?? []).filter((method): method is "key" | "oauth" => method === "key" || method === "oauth")
  const capabilities = (readArray(value, "capabilities") ?? []).filter((entry): entry is string => typeof entry === "string")
  return [{ id, name: readString(value, "name") ?? id, methods, capabilities, prompts: (readArray(value, "prompts") ?? []).flatMap(integrationPromptFromWire) }]
}

function connectionOf(value: unknown): Connection[] {
  const id = readString(value, "id")
  const integrationId = readString(value, "integrationId")
  if (id === undefined || integrationId === undefined) return []
  const status = readString(value, "status")
  const accountLabel = readString(value, "accountLabel")
  return [{
    id,
    integrationId,
    scope: readString(value, "scope") === "personal" ? "personal" : "team",
    ...(accountLabel === undefined ? {} : { accountLabel }),
    status: status === "connected" || status === "degraded" ? status : "broken",
  }]
}

export function integrationQueries(transport: Transport): IntegrationQueries {
  return {
    catalog: () =>
      fetchQuery(queryKeys.integrations(transport.serverUrl), async () => {
        const body = await transport.json<unknown>(INTEGRATIONS_PATH)
        return {
          integrations: (readArray(body, "integrations") ?? []).flatMap(integrationOf),
          connections: (readArray(body, "connections") ?? []).flatMap(connectionOf),
          personalScopeEnabled: readBoolean(body, "personalScopeEnabled") === true,
        }
      }),
  }
}

function connectFailure(status: number, body: unknown): IntegrationConnectOutcome {
  const code = readString(body, "code") ?? readString(readField(body, "error"), "code")
  const verifyReason = readString(body, "reason")
  const detail = { status, ...(code ? { code } : {}), ...(verifyReason ? { verifyReason } : {}) }
  if (code === "connection_exists") return { kind: "failed", reason: "exists", ...detail }
  if (code === "verify_failed" || code === "connection_verify_failed" || status === 401 || status === 403) return { kind: "failed", reason: "rejected", ...detail }
  return { kind: "failed", reason: status === 404 ? "unoffered" : "failed", ...detail }
}

function connectBody(input: IntegrationConnectInput) {
  const options = { ...(input.scope ? { scope: input.scope } : {}), ...(input.confirmReplace ? { confirmReplace: true } : {}) }
  return input.method === "oauth" ? { ...options, method: "oauth" } : { ...options, fields: input.fields ?? {}, secret: input.secret }
}

async function connectIntegration(transport: Transport, integrationId: string, input: IntegrationConnectInput): Promise<IntegrationConnectOutcome> {
  const answer = await ask(transport, `${INTEGRATIONS_PATH}/${encodeURIComponent(integrationId)}/connect`, jsonInit("POST", connectBody(input)))
  if (answer.kind === "unreachable") return { kind: "failed", reason: "unreachable" }
  const body = answer.body
  if (!answer.ok) return connectFailure(answer.status, body)
  const url = readString(body, "url")
  const attemptId = readString(body, "attemptId")
  if (input.method !== "oauth") return { kind: "connected" }
  if (!url || !attemptId) return { kind: "failed", reason: "failed" }
  const userCode = readString(body, "userCode")
  return { kind: "authorize", grant: { attemptId, url, ...(userCode ? { userCode } : {}), intervalMs: readFiniteNumber(body, "intervalMs") ?? 5000 } }
}

type AttemptState = { readonly state: "pending"; readonly intervalMs?: number } | { readonly state: "complete" } | { readonly state: IntegrationFailure }

async function readAttempt(transport: Transport, attemptId: string): Promise<AttemptState> {
  const answer = await ask(transport, `${INTEGRATIONS_PATH}/attempts/${encodeURIComponent(attemptId)}`)
  if (answer.kind === "unreachable") return { state: "pending" }
  if (!answer.ok) return { state: "gone" }
  const body = answer.body
  const status = readString(body, "status")
  if (status === "pending") {
    const intervalMs = readFiniteNumber(body, "intervalMs")
    return intervalMs !== undefined && intervalMs > 0 ? { state: "pending", intervalMs } : { state: "pending" }
  }
  if (status === "complete") return { state: "complete" }
  return { state: status === "expired" ? "expired" : "denied" }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function awaitGrant(transport: Transport, grant: IntegrationGrant, alive: () => boolean): Promise<IntegrationGrantOutcome> {
  const deadline = Date.now() + GRANT_LIFETIME_MS
  let interval = grant.intervalMs
  while (Date.now() < deadline) {
    await wait(interval)
    if (!alive()) return { kind: "abandoned" }
    const answer = await readAttempt(transport, grant.attemptId)
    if (!alive()) return { kind: "abandoned" }
    if (answer.state === "complete") return { kind: "connected" }
    if (answer.state !== "pending") return { kind: "failed", reason: answer.state }
    interval = answer.intervalMs ?? interval
  }
  return { kind: "failed", reason: "timeout" }
}

async function reverify(transport: Transport, connectionId: string) {
  const answer = await ask(transport, `${INTEGRATIONS_PATH}/connections/${encodeURIComponent(connectionId)}/reverify`, jsonInit("POST"))
  if (answer.kind === "unreachable") throw answer.error
  const body = answer.body
  if (answer.ok && readBoolean(body, "ok") === true) return { ok: true } as const
  const verifyReason = readString(body, "reason")
  return verifyReason ? ({ ok: false, verifyReason } as const) : ({ ok: false } as const)
}

async function disconnect(transport: Transport, connectionId: string) {
  const response = await transport.request(`${INTEGRATIONS_PATH}/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" })
  if (!response.ok && response.status !== 404) throw new Error(`Disconnect failed (${response.status})`)
}

export function createIntegrationsApi(transport: Transport, queryClient: QueryClient): IntegrationsApi {
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.integrations(transport.serverUrl) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.codeHostAll(transport.serverUrl) }),
    ])
  const settled = async <T extends { readonly kind: string }>(outcome: T) => {
    if (outcome.kind === "connected") await refresh()
    return outcome
  }
  return {
    connect: async (integrationId, input) => settled(await connectIntegration(transport, integrationId, input)),
    awaitGrant: async (grant, alive) => settled(await awaitGrant(transport, grant, alive)),
    disconnect: async (connectionId) => {
      await disconnect(transport, connectionId)
      await refresh()
    },
    reverify: async (connectionId) => {
      const outcome = await reverify(transport, connectionId)
      await refresh()
      return outcome
    },
  }
}
