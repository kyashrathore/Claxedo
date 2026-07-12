export function harnessQueryFetch(input: {
  request?: typeof fetch
  harnessType?: string
  baseUrl?: string
}): typeof fetch {
  const request = input.request ?? fetch
  const harnessType = input.harnessType
  if (!harnessType) return request
  const baseUrl = input.baseUrl ?? "http://claxedo.local"
  return async (requestInput, init) => {
    const next = requestInput instanceof Request ? new Request(requestInput, init) : undefined
    const url = new URL(next?.url ?? String(requestInput), baseUrl)
    url.searchParams.set("harness", harnessType)
    if (!next) return request(url.toString(), init)
    const method = next.method.toUpperCase()
    return request(url.toString(), {
      method: next.method,
      headers: next.headers,
      signal: next.signal,
      ...(method === "GET" || method === "HEAD" ? {} : { body: await next.clone().arrayBuffer() }),
    })
  }
}
