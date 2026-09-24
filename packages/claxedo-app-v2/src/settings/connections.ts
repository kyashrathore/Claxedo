import { createStore } from "solid-js/store"
import { decodeHarnessConnectionsCatalog, type HarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import { readArray, readBoolean, readField, readFiniteNumber, readString, recordOrEmpty } from "@/lib/record"
import { machine, unreachable, type Transition } from "@/lib/machine"

export type IntegrationPrompt = { readonly id: string; readonly label: string; readonly placeholder?: string; readonly secret: boolean }

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

export type ConnectionsCatalog = {
  readonly integrations: readonly Integration[]
  readonly connections: readonly Connection[]
  readonly personalScopeEnabled: boolean
}

const INTEGRATIONS = "/api/claxedo/integrations"

const jsonOf = async (response: Response) => recordOrEmpty(await response.json().catch(() => undefined))

function integration(value: unknown): Integration | undefined {
  const id = readString(value, "id")
  if (id === undefined) return undefined
  return {
    id,
    name: readString(value, "name") ?? id,
    methods: (readArray(value, "methods") ?? []).filter((method): method is "key" | "oauth" => method === "key" || method === "oauth"),
    capabilities: (readArray(value, "capabilities") ?? []).filter((entry): entry is string => typeof entry === "string"),
    prompts: (readArray(value, "prompts") ?? []).flatMap((prompt) => {
      const promptId = readString(prompt, "id")
      if (promptId === undefined) return []
      const placeholder = readString(prompt, "placeholder")
      return [{ id: promptId, label: readString(prompt, "label") ?? promptId, ...(placeholder === undefined ? {} : { placeholder }), secret: readBoolean(prompt, "secret") === true }]
    }),
  }
}

function connection(value: unknown): Connection | undefined {
  const id = readString(value, "id")
  const integrationId = readString(value, "integrationId")
  if (id === undefined || integrationId === undefined) return undefined
  const status = readString(value, "status")
  const accountLabel = readString(value, "accountLabel")
  return {
    id,
    integrationId,
    scope: readString(value, "scope") === "personal" ? "personal" : "team",
    ...(accountLabel === undefined ? {} : { accountLabel }),
    status: status === "connected" || status === "degraded" ? status : "broken",
  }
}

export async function loadConnections(): Promise<ConnectionsCatalog> {
  const response = await fetch(INTEGRATIONS, { credentials: "include" })
  const body = await jsonOf(response)
  if (!response.ok) throw new Error(`Failed to load connections (${readString(body, "code") ?? response.status})`)
  return {
    integrations: (readArray(body, "integrations") ?? []).flatMap((row) => {
      const parsed = integration(row)
      return parsed ? [parsed] : []
    }),
    connections: (readArray(body, "connections") ?? []).flatMap((row) => {
      const parsed = connection(row)
      return parsed ? [parsed] : []
    }),
    personalScopeEnabled: body.personalScopeEnabled === true,
  }
}

export async function disconnectConnection(id: string): Promise<void> {
  const response = await fetch(`${INTEGRATIONS}/connections/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" })
  if (!response.ok && response.status !== 404) throw new Error(`Disconnect failed (${response.status})`)
}

export function verifyFailedMessage(reason: unknown): string {
  if (reason === "unauthorized") return "The provided credentials were rejected. Check the values and try again."
  if (reason === "network") return "Could not reach the integration to verify the credentials. Try again."
  return "Verification failed. Try again."
}

export async function reverifyConnection(id: string): Promise<void> {
  const response = await fetch(`${INTEGRATIONS}/connections/${encodeURIComponent(id)}/reverify`, { method: "POST", credentials: "include" })
  const body = await jsonOf(response)
  if (response.ok && body.ok === true) return
  throw new Error(verifyFailedMessage(body.reason))
}

export async function loadAgentConnections(): Promise<HarnessConnectionsCatalog> {
  const response = await fetch("/api/claxedo/agent-config/connections", { credentials: "include" })
  if (!response.ok) throw new Error(`Failed to load agent connections (${response.status})`)
  return decodeHarnessConnectionsCatalog(await response.json())
}

export async function removeAgentConnection(connectionId: string): Promise<void> {
  const response = await fetch(`/api/claxedo/agent-config/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE", credentials: "include" })
  if (!response.ok) throw new Error(`Remove failed (${response.status})`)
}

export type ConnectState =
  | { readonly kind: "form"; readonly error?: string }
  | { readonly kind: "submitting"; readonly mode: "key" | "oauth" }
  | { readonly kind: "confirmReplace"; readonly mode: "key" | "oauth" }
  | { readonly kind: "oauthWaiting"; readonly url: string; readonly userCode?: string }
  | { readonly kind: "done" }

export type ConnectEvent =
  | { readonly type: "submit"; readonly mode: "key" | "oauth" }
  | { readonly type: "exists" }
  | { readonly type: "confirm" }
  | { readonly type: "cancel" }
  | { readonly type: "authorize"; readonly url: string; readonly userCode?: string }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "connected" }

export const connectTransition: Transition<ConnectState, ConnectEvent> = (state, event) => {
  switch (event.type) {
    case "submit":
      return { kind: "submitting", mode: event.mode }
    case "exists":
      return state.kind === "submitting" ? { kind: "confirmReplace", mode: state.mode } : state
    case "confirm":
      return state.kind === "confirmReplace" ? { kind: "submitting", mode: state.mode } : state
    case "cancel":
      return { kind: "form" }
    case "authorize":
      return { kind: "oauthWaiting", url: event.url, ...(event.userCode ? { userCode: event.userCode } : {}) }
    case "failed":
      return { kind: "form", error: event.error }
    case "connected":
      return { kind: "done" }
    default:
      return unreachable(event)
  }
}

export const connectMachine = () => machine<ConnectState, ConnectEvent>({ kind: "form" }, connectTransition)

export type ConnectForm = {
  fields: Record<string, string>
  secret: string
  scope: ConnectionScope
}

export function createConnectForm(scope: ConnectionScope) {
  return createStore<ConnectForm>({ fields: {}, secret: "", scope })
}

const OAUTH_POLL_LIMIT = 150

export type OAuthAttempt = { readonly attemptId: string; readonly url: string; readonly userCode?: string; readonly intervalMs: number }

export async function startConnect(input: { integration: Integration; mode: "key" | "oauth"; form: ConnectForm; personalScope: boolean; confirmReplace: boolean }) {
  const body: Record<string, unknown> = {
    ...(input.confirmReplace ? { confirmReplace: true } : {}),
    ...(input.personalScope ? { scope: input.form.scope } : {}),
  }
  if (input.mode === "oauth") body.method = "oauth"
  else {
    const fields: Record<string, string> = {}
    for (const prompt of input.integration.prompts) if (!prompt.secret) fields[prompt.id] = input.form.fields[prompt.id] ?? ""
    body.fields = fields
    body.secret = input.form.secret
  }
  const response = await fetch(`${INTEGRATIONS}/${encodeURIComponent(input.integration.id)}/connect`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const payload = await jsonOf(response)
  if (response.status === 409 && payload.code === "connection_exists") return { kind: "exists" as const }
  if (!response.ok) {
    if (payload.code === "connection_verify_failed") return { kind: "failed" as const, error: verifyFailedMessage(payload.reason) }
    return { kind: "failed" as const, error: `Connect failed (${readString(payload, "code") ?? `status ${response.status}`})` }
  }
  if (input.mode !== "oauth") return { kind: "connected" as const }
  const url = readString(payload, "url")
  const attemptId = readString(payload, "attemptId")
  if (!url || !attemptId) return { kind: "failed" as const, error: "The server did not return an authorization URL. Try again." }
  const userCode = readString(payload, "userCode")
  const intervalMs = readFiniteNumber(payload, "intervalMs") ?? 2000
  return { kind: "authorize" as const, attempt: { attemptId, url, ...(userCode ? { userCode } : {}), intervalMs } satisfies OAuthAttempt }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function awaitOAuthAttempt(attempt: OAuthAttempt, live: () => boolean): Promise<{ kind: "connected" } | { kind: "failed"; error: string } | { kind: "abandoned" }> {
  let interval = attempt.intervalMs
  for (let poll = 0; poll < OAUTH_POLL_LIMIT; poll += 1) {
    await sleep(interval)
    if (!live()) return { kind: "abandoned" }
    const response = await fetch(`${INTEGRATIONS}/attempts/${encodeURIComponent(attempt.attemptId)}`, { credentials: "include" })
    if (!response.ok) return { kind: "failed", error: "The authorization attempt was not found or expired. Try again." }
    const body = await jsonOf(response)
    if (body.status === "pending") {
      const next = readFiniteNumber(body, "intervalMs")
      if (next !== undefined && next > 0) interval = next
      continue
    }
    if (body.status === "complete") return { kind: "connected" }
    return { kind: "failed", error: body.status === "expired" ? "The authorization attempt expired. Try again." : "Authorization failed. Try again." }
  }
  return { kind: "failed", error: "Timed out waiting for authorization. Try again." }
}
