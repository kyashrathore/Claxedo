import type { QueryClient } from "@tanstack/solid-query"
import { readArray, readBoolean, readField, readFiniteNumber, readString } from "../lib/record"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery } from "./types"

const INTEGRATIONS_PATH = "/api/claxedo/integrations"
const CODE_HOST_CAPABILITY = "code-host"
const GRANT_LIFETIME_MS = 15 * 60 * 1000

export type CodeHostPrompt = {
  readonly id: string
  readonly label: string
  readonly placeholder?: string
  readonly createUrl?: string
  readonly secret: boolean
}

export type CodeHostIntegration = {
  readonly id: string
  readonly name: string
  readonly methods: readonly ("key" | "oauth")[]
  readonly prompts: readonly CodeHostPrompt[]
}

export type CodeHostGrant = { readonly attemptId: string; readonly url: string; readonly userCode?: string; readonly intervalMs: number }

export type CodeHostFailure = "exists" | "rejected" | "unoffered" | "unreachable" | "expired" | "denied" | "gone" | "failed"

export type CodeHostConnectOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "authorize"; readonly grant: CodeHostGrant }
  | { readonly kind: "failed"; readonly reason: CodeHostFailure }

export type CodeHostGrantOutcome = { readonly kind: "connected" } | { readonly kind: "failed"; readonly reason: CodeHostFailure } | { readonly kind: "abandoned" }

export type CodeHostConnectInput = { readonly method: "oauth" } | { readonly method: "key"; readonly secret: string }

export type CodeHostQueries = { readonly offered: () => FetchQuery<readonly CodeHostIntegration[]> }

export type CodeHostsApi = {
  readonly connect: (integrationId: string, input: CodeHostConnectInput) => Promise<CodeHostConnectOutcome>
  readonly awaitGrant: (grant: CodeHostGrant, alive: () => boolean) => Promise<CodeHostGrantOutcome>
}

function httpsLink(value: string | undefined) {
  if (!value) return undefined
  try {
    return new URL(value).protocol === "https:" ? value : undefined
  } catch {
    return undefined
  }
}

function promptOf(value: unknown): CodeHostPrompt[] {
  const id = readString(value, "id")
  if (id === undefined) return []
  const placeholder = readString(value, "placeholder")
  const createUrl = httpsLink(readString(value, "createUrl"))
  return [{ id, label: readString(value, "label") ?? id, ...(placeholder ? { placeholder } : {}), ...(createUrl ? { createUrl } : {}), secret: readBoolean(value, "secret") === true }]
}

function integrationOf(value: unknown): CodeHostIntegration[] {
  const id = readString(value, "id")
  if (id === undefined || !(readArray(value, "capabilities") ?? []).includes(CODE_HOST_CAPABILITY)) return []
  const methods = (readArray(value, "methods") ?? []).filter((method): method is "key" | "oauth" => method === "key" || method === "oauth")
  return [{ id, name: readString(value, "name") ?? id, methods, prompts: (readArray(value, "prompts") ?? []).flatMap(promptOf) }]
}

export function codeHostQueries(transport: Transport): CodeHostQueries {
  return {
    offered: () => fetchQuery(queryKeys.codeHostOffered(transport.serverUrl), async () => (readArray(await transport.json<unknown>(INTEGRATIONS_PATH), "integrations") ?? []).flatMap(integrationOf)),
  }
}

function failureOf(status: number, body: unknown): CodeHostFailure {
  const code = readString(body, "code") ?? readString(readField(body, "error"), "code") ?? ""
  if (code === "connection_exists") return "exists"
  if (code === "verify_failed" || code === "connection_verify_failed" || status === 401 || status === 403) return "rejected"
  return status === 404 ? "unoffered" : "failed"
}

async function post(transport: Transport, path: string, body: unknown) {
  const response = await transport.request(path, jsonInit("POST", body))
  return { status: response.status, ok: response.ok, body: await response.json().catch(() => undefined) }
}

async function connect(transport: Transport, integrationId: string, input: CodeHostConnectInput): Promise<CodeHostConnectOutcome> {
  const body = input.method === "oauth" ? { method: "oauth" } : { fields: {}, secret: input.secret }
  const answer = await post(transport, `${INTEGRATIONS_PATH}/${encodeURIComponent(integrationId)}/connect`, body).catch(() => undefined)
  if (!answer) return { kind: "failed", reason: "unreachable" }
  if (!answer.ok) return { kind: "failed", reason: failureOf(answer.status, answer.body) }
  const url = readString(answer.body, "url")
  const attemptId = readString(answer.body, "attemptId")
  if (input.method !== "oauth" || !url || !attemptId) return { kind: "connected" }
  const userCode = readString(answer.body, "userCode")
  return { kind: "authorize", grant: { attemptId, url, ...(userCode ? { userCode } : {}), intervalMs: readFiniteNumber(answer.body, "intervalMs") ?? 5000 } }
}

async function readAttempt(transport: Transport, attemptId: string): Promise<"pending" | "complete" | CodeHostFailure> {
  const response = await transport.request(`${INTEGRATIONS_PATH}/attempts/${encodeURIComponent(attemptId)}`).catch(() => undefined)
  if (!response) return "pending"
  if (!response.ok) return "gone"
  const status = readString(await response.json().catch(() => undefined), "status")
  if (status === "pending" || status === "complete") return status
  return status === "expired" ? "expired" : "denied"
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function awaitGrant(transport: Transport, grant: CodeHostGrant, alive: () => boolean): Promise<CodeHostGrantOutcome> {
  const polls = Math.ceil(GRANT_LIFETIME_MS / grant.intervalMs)
  for (let poll = 0; poll < polls; poll += 1) {
    await wait(grant.intervalMs)
    if (!alive()) return { kind: "abandoned" }
    const state = await readAttempt(transport, grant.attemptId)
    if (!alive()) return { kind: "abandoned" }
    if (state === "pending") continue
    return state === "complete" ? { kind: "connected" } : { kind: "failed", reason: state }
  }
  return { kind: "failed", reason: "expired" }
}

export function createCodeHostsApi(transport: Transport, queryClient: QueryClient): CodeHostsApi {
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.codeHostAll(transport.serverUrl) })
  const settled = async <T extends { readonly kind: string }>(outcome: T) => {
    if (outcome.kind === "connected") await refresh()
    return outcome
  }
  return {
    connect: async (integrationId, input) => settled(await connect(transport, integrationId, input)),
    awaitGrant: async (grant, alive) => settled(await awaitGrant(transport, grant, alive)),
  }
}
