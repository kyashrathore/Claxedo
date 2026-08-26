/**
 * Read a solid-query observer's `.data` WITHOUT ever suspending.
 *
 * solid-query's result proxy (`useBaseQuery.ts`, `handler.get("data")`) routes
 * a `.data` read through its internal async source whenever
 * `state.data === undefined` — and that resource flips to loading every time
 * the observer's options getter re-runs (each run mints a new options object,
 * which triggers the `on([observer, defaultedOptions], … refetch())`
 * computation). So a bare `.data` read on a not-yet-populated cache-mirror
 * observer (`enabled: false` queries fed by the family's imperative cache
 * writers) registers with the nearest `<Loading>` boundary and
 * re-arms it — an ALREADY-RENDERED subtree is swapped out for its fallback and
 * back within a flush. (Cache mirrors are populated by their family's declared
 * imperative cache writers, never by the observer's own fetch.) Measured in
 * the session pane: the sticky header
 * detached, composer focus dropped to `<body>`, and an open slash popover
 * closed mid-typing every time the delayed first-fold hydrate started its
 * fetches.
 *
 * Gating on `status === "success"` (a plain store read through `Reflect.get`,
 * never the resource) only touches `.data` once `state.data` is defined —
 * which the proxy serves from `queryResource.latest` without suspending.
 */
export function settledQueryData<T>(query: { status: string; data: T | undefined }): T | undefined {
  return query.status === "success" ? query.data : undefined
}
