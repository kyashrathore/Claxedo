import { QueryObserver, type QueryKey } from "@tanstack/solid-query"
import { queryClient } from "@/platform/query/query-client"

const leaseAuthorityMetaKey = "claxedoLeaseAuthority"

function leasedRequestKey(scopeKey: QueryKey, authority: object) {
  const existing = queryClient.getQueryCache().findAll({ queryKey: scopeKey }).find(
    (query) => query.meta?.[leaseAuthorityMetaKey] === authority,
  )
  return existing?.queryKey ?? [...scopeKey, crypto.randomUUID()]
}

function waitForConsumer<T>(shared: Promise<T>, signal?: AbortSignal) {
  if (!signal) return shared
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", aborted, { once: true })
    shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}

/**
 * Shares one transport request across consumers without making the first
 * consumer's activation signal the owner of that request. The ephemeral query
 * retains its transport closure only while at least one consumer lease exists.
 */
export async function leasedQueryRequest<T>(input: {
  scopeKey: QueryKey
  authority: object
  signal?: AbortSignal
  queryFn: (signal: AbortSignal) => Promise<T>
}) {
  const queryKey = leasedRequestKey(input.scopeKey, input.authority)
  const meta = { [leaseAuthorityMetaKey]: input.authority }
  const queryFn = ({ signal }: { signal: AbortSignal }) => input.queryFn(signal)
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    meta,
    enabled: false,
    // The final lease removes the query explicitly. Automatic gcTime: 0 can
    // delete the flight during the cancellation await before a concurrent
    // consumer has a chance to reacquire it.
    gcTime: Number.POSITIVE_INFINITY,
  })
  const ownedQuery = observer.getCurrentQuery()
  const release = observer.subscribe(() => undefined)
  try {
    const shared = queryClient.fetchQuery({
      queryKey,
      queryFn,
      meta,
      gcTime: Number.POSITIVE_INFINITY,
    })
    return await waitForConsumer(shared, input.signal)
  } finally {
    release()
    if (ownedQuery.getObserversCount() === 0) {
      await queryClient.cancelQueries({ queryKey, exact: true })
      const current = queryClient.getQueryCache().find({ queryKey, exact: true })
      if (current === ownedQuery && ownedQuery.getObserversCount() === 0) {
        queryClient.getQueryCache().remove(ownedQuery)
      }
    }
  }
}

export function leasedQueryRequestKey(scopeKey: QueryKey, authority: object) {
  return leasedRequestKey(scopeKey, authority)
}
