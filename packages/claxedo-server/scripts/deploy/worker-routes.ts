import { asRecord, isRecordArray, stringField } from "@claxedo/server-core/platform/json/index"

const API = "https://api.cloudflare.com/client/v4"

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

async function api(fetcher: Fetch, token: string, path: string, method = "GET") {
  const response = await fetcher(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}` } })
  const body = asRecord(await response.json().catch(() => undefined))
  if (!response.ok || body?.success !== true) throw new Error(`Cloudflare ${method} ${path} answered ${response.status}: ${JSON.stringify(body?.errors ?? body)}`)
  return body.result
}

/** The zone a hostname belongs to: the longest of its parent names the account holds as a zone. */
async function zoneOf(fetcher: Fetch, token: string, host: string) {
  const labels = host.split(".")
  for (let start = 0; start < labels.length - 1; start++) {
    const result = await api(fetcher, token, `/zones?name=${encodeURIComponent(labels.slice(start).join("."))}`)
    const id = isRecordArray(result) ? stringField(result[0], "id") : undefined
    if (id) return id
  }
  throw new Error(`no zone on this account holds ${host}`)
}

/**
 * Unassigns from `script` the routes among `patterns` it still holds on
 * `host`'s zone, so another Worker can take them: Wrangler deploys a Worker's
 * routes only when none of them is "assigned to another worker", and a
 * Worker deployed with no routes keeps the ones it had. Answers the patterns
 * it released; none once the routes have moved.
 * (developers.cloudflare.com/api/resources/workers/subresources/routes/)
 */
export async function releaseWorkerRoutes(input: {
  script: string
  host: string
  patterns: readonly string[]
  token: string
  fetch?: Fetch
}): Promise<string[]> {
  const fetcher = input.fetch ?? ((url, init) => fetch(url, init))
  const zone = await zoneOf(fetcher, input.token, input.host)
  const routes = await api(fetcher, input.token, `/zones/${zone}/workers/routes`)
  if (!isRecordArray(routes)) throw new Error(`Cloudflare listed no routes array for ${input.host}`)
  const held = routes.filter((route) => stringField(route, "script") === input.script && input.patterns.includes(stringField(route, "pattern") ?? ""))
  for (const route of held) await api(fetcher, input.token, `/zones/${zone}/workers/routes/${stringField(route, "id")}`, "DELETE")
  return held.map((route) => stringField(route, "pattern") ?? "")
}
