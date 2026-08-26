import { useQuery, type DefaultError, type QueryKey, type QueryOptions } from "@tanstack/solid-query"
import { isWorkspaceReady } from "./workspace-connection"

// A thin wrapper over `@tanstack/solid-query`'s `useQuery` that BAKES IN
// `enabled: isWorkspaceReady(workspaceId)`. Any query that depends on the
// workspace runtime MUST be created via `useWorkspaceQuery` and MUST pass
// `workspaceId` — it then cannot fire while the connection is not `ready`.
//
// This is the STRUCTURAL kill for the toast/retry spam: connection-failure
// handling becomes ABSENCE of a fetch, not a caught-and-suppressed error. When
// the authority flips `ready → reconnecting/offline`, `enabled` flips false and
// solid-query parks the query (no fetch, no error, no toast). When it flips back
// to `ready`, the query re-enables and refetches.
//
// Local workspaces are always `ready`, so this is a no-op gate for loopback —
// zero regression.

export type WorkspaceQueryOptions<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> = QueryOptions<TQueryFnData, TError, TData, TQueryKey> & {
  // The workspaceId whose connection gates this query. A relay-backed workspace
  // (cloud / user-hosted) supplies its real id and the query is gated on the
  // authority flipping that id to `ready`.
  //
  // `undefined` means there is NO relay backing for this scope — i.e. the query
  // targets the central / loopback-local server, which is reachable as soon as
  // the global bootstrap has happened. By default that is treated as a LOCAL
  // workspace (always ready), so the gate is a no-op for loopback — matching the
  // authority's "local workspaces are synthesized ready immediately" contract.
  // Pass `gateWhenUnbacked: true` to instead keep the query disabled when no
  // workspaceId is known (for the rare case where a missing id is an error, not
  // a local fallback).
  workspaceId: string | undefined
  // When `true`, an `undefined` workspaceId DISABLES the query instead of
  // treating it as the local/central fallback. Defaults to `false` (fallback).
  gateWhenUnbacked?: boolean
}

export function useWorkspaceQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(optsFn: () => WorkspaceQueryOptions<TQueryFnData, TError, TData, TQueryKey>) {
  return useQuery(() => {
    const opts = optsFn()
    const { workspaceId, gateWhenUnbacked, ...rest } = opts
    // Reactive: tracks the authority's status for this workspaceId.
    //
    // When `workspaceId` is undefined and the caller did NOT opt into
    // `gateWhenUnbacked`, the scope is local/central — there is no relay
    // connection to wait on, so `ready` is true (no-op gate for loopback).
    const ready = workspaceId === undefined ? gateWhenUnbacked !== true : isWorkspaceReady(workspaceId)
    return {
      ...rest,
      // AND with caller-supplied enabled — never widens it.
      enabled: ready && (opts.enabled ?? true),
      // Do not retry while offline; the authority owns retry/backoff.
      retry: opts.retry ?? false,
      // Workspace queries never seed initialData — narrow to the
      // no-initial-data overload so the generic spread resolves.
    } as QueryOptions<TQueryFnData, TError, TData, TQueryKey> & { initialData?: undefined }
  })
}
