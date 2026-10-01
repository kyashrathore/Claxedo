import { fetchDouble, fetchUrl, type FetchHandler } from "./fetch-double"

export function documentAuthorizedFetch(handler: FetchHandler): typeof fetch {
  return fetchDouble(async (input, init) => {
    if (new URL(fetchUrl(input)).pathname.endsWith("/runtime-authorization")) return new Response(null, { status: 204 })
    return await handler(input, init)
  })
}
