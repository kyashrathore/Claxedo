import { asArrayOrUndefined as arr, asNumber, asRecord, asString } from "@claxedo/helpers/guards"
import { TransportError } from "../../contract/errors.js"

const CATALOG_CLIENT_VERSION = "0.159.2"

export type PlanModel = Readonly<{ id: string; name: string; context?: number; priority: number }>

type PlanCatalogRequest = Readonly<{ baseURL: string; access: string; accountID: string }>
type PlanFetch = (url: URL, init: RequestInit) => Promise<Response>

function unreadable(detail: string, cause?: unknown): TransportError {
  return new TransportError("opencode", "credential_unavailable", `OpenCode could not read the models the ChatGPT plan serves: ${detail}`, { cause })
}

export function planModels(body: unknown): readonly PlanModel[] {
  const rows = arr(asRecord(body)?.models)
  if (!rows) throw unreadable("the answer lists no models")
  return rows.flatMap((value) => {
    const row = asRecord(value)
    const id = asString(row?.slug)
    if (!row || !id || row.visibility !== "list") return []
    const context = asNumber(row.context_window)
    return [{ id, name: asString(row.display_name) ?? id, priority: asNumber(row.priority) ?? Number.MAX_SAFE_INTEGER,
      ...(context !== undefined && Number.isSafeInteger(context) && context > 0 ? { context } : {}) }]
  }).sort((left, right) => left.priority - right.priority)
}

export async function readPlanModels(request: PlanCatalogRequest, fetch: PlanFetch = (url, init) => globalThis.fetch(url, init)): Promise<readonly PlanModel[]> {
  const url = new URL(`${request.baseURL.replace(/\/+$/, "")}/models`)
  url.searchParams.set("client_version", CATALOG_CLIENT_VERSION)
  let body: unknown
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${request.access}`, "chatgpt-account-id": request.accountID, accept: "application/json" } })
    if (!response.ok) throw unreadable(`chatgpt.com answered ${response.status} ${response.headers.get("content-type") ?? ""}`.trim())
    body = await response.json()
  } catch (error) {
    throw error instanceof TransportError ? error : unreadable(error instanceof Error ? error.message : String(error), error)
  }
  const models = planModels(body)
  if (!models.length) throw unreadable("the plan lists none")
  return models
}
