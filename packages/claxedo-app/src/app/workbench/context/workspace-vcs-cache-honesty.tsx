import { createRenderEffect } from "solid-js"

import { useSDK } from "@/app/providers/sdk/sdk"
import { invalidateReviewVcsDirectory, type ReviewVcsDirectory } from "@/features/review/ui/review-vcs-cache"
import { createReviewVcsDirectoryClassifier, type ReviewVcsEvent } from "@/features/review/ui/review-vcs-invalidation"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

const FILE_STATUS_DEBOUNCE_MS = 250

/** The identity one freshness owner is responsible for. */
type HonestyIdentity = ReviewVcsDirectory & {
  serverUrl: string | undefined
  workspaceId: string | undefined
}

type HonestyListen = (handler: (event: { details: ReviewVcsEvent }) => void) => () => void

type HonestyOwner = {
  count: number
  dispose: () => void
}

/**
 * Module-scoped registry of freshness owners, keyed by
 * (serverUrl, workspaceId, directory).
 *
 * Contract:
 * - The FIRST acquisition for a key creates the single event listener and
 *   file-status debouncer. Every later same-key acquisition only increments
 *   the count, so one runtime event produces exactly one review-cache removal
 *   and one (debounced) file-status invalidation no matter how many panes of
 *   the workspace are mounted. Same-key mounts share one event stream: the
 *   per-scope emitters for one (serverUrl, workspaceId, directory) all bridge
 *   the same global stream, so the first mount's subscription observes every
 *   event the others would.
 * - The LAST release disposes the listener and any pending debounce, and
 *   remembers the key: the caches are infinite-stale and events during the
 *   ownerless gap go unobserved, so the next 0 -> 1 acquisition reconciles
 *   ONCE -- removes the review entries and invalidates file-status and the
 *   runtime VCS summary -- and the first read after the gap refetches. One
 *   reconciliation per gap, never per mount.
 * - The first acquisition ever seen for a key does not reconcile: no owner
 *   existed before it, so nothing could have been cached during a gap.
 */
const registry: {
  owners: Map<string, HonestyOwner>
  keysWithOwnerlessGap: Set<string>
} = {
  owners: new Map(),
  keysWithOwnerlessGap: new Set(),
}

function ownerKey(identity: HonestyIdentity) {
  return JSON.stringify([identity.serverUrl ?? "", identity.workspaceId ?? "", identity.directory])
}

function fileStatusKey(identity: HonestyIdentity) {
  return queryKeys.directory.fileStatus(identity.serverUrl, identity.directory, identity.workspaceId)
}

/**
 * Every `queryKeys.runtime.vcs` entry for this worktree. The family prefix,
 * not one exact key: the same directory is read through the workbench scope
 * and through each session pane's SDK scope, and those resolve the workspaceId
 * independently (and late, once the signed inventory loads).
 */
function runtimeVcsKey(identity: HonestyIdentity) {
  return queryKeys.runtime.vcsDirectory(identity.serverUrl, identity.directory)
}

function createHonestyOwner(identity: HonestyIdentity, listen: HonestyListen): HonestyOwner {
  const stale = createReviewVcsDirectoryClassifier()
  let fileStatusTimer: ReturnType<typeof setTimeout> | undefined
  const unlisten = listen((event) => {
    const invalidation = stale(event.details)
    // The branch summary changes only when HEAD/refs move, so it is invalidated
    // on its own bit rather than on every worktree write. It has live observers
    // (the session environment card), so invalidate -- not remove -- and let
    // them refetch in place. Undebounced: HEAD writes are single events, not
    // the burst the file watcher produces for a save.
    if (invalidation.branch) void queryClient.invalidateQueries({ queryKey: runtimeVcsKey(identity) })
    if (!invalidation.diffs) return
    invalidateReviewVcsDirectory({ directory: identity.directory })
    if (fileStatusTimer) clearTimeout(fileStatusTimer)
    fileStatusTimer = setTimeout(() => {
      fileStatusTimer = undefined
      void queryClient.invalidateQueries({ queryKey: fileStatusKey(identity) })
    }, FILE_STATUS_DEBOUNCE_MS)
  })
  return {
    count: 1,
    dispose: () => {
      unlisten()
      if (fileStatusTimer) clearTimeout(fileStatusTimer)
    },
  }
}

function acquireWorkspaceVcsCacheHonesty(identity: HonestyIdentity, listen: HonestyListen): () => void {
  const key = ownerKey(identity)
  const existing = registry.owners.get(key)
  if (existing) {
    existing.count += 1
  } else {
    // A change may have landed while nothing observed the stream: reconcile
    // once so the infinite-stale caches cannot restore pre-gap data.
    if (registry.keysWithOwnerlessGap.delete(key)) {
      invalidateReviewVcsDirectory({ directory: identity.directory })
      void queryClient.invalidateQueries({ queryKey: fileStatusKey(identity) })
      void queryClient.invalidateQueries({ queryKey: runtimeVcsKey(identity) })
    }
    registry.owners.set(key, createHonestyOwner(identity, listen))
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const owner = registry.owners.get(key)
    if (!owner) return
    owner.count -= 1
    if (owner.count > 0) return
    registry.owners.delete(key)
    registry.keysWithOwnerlessGap.add(key)
    owner.dispose()
  }
}

export function resetWorkspaceVcsCacheHonestyForTest() {
  for (const owner of registry.owners.values()) owner.dispose()
  registry.owners.clear()
  registry.keysWithOwnerlessGap.clear()
}

/**
 * Keeps the infinite-stale VCS caches for one workspace directory honest --
 * the module-scoped review reads (diff/file/refs/targets), the canonical
 * file-status query, and the runtime VCS summary (`queryKeys.runtime.vcs`,
 * branch and default branch) -- for as long as ANY surface of that workspace
 * is mounted.
 *
 * This owner is why those caches can be infinite-stale at all: freshness comes
 * from the workspace's own event stream (watcher writes, `vcs.branch.updated`,
 * settled turns) instead of a wall clock, so a session switch never pays a
 * refetch just because some timer happened to expire.
 *
 * This deliberately does not live with the Review surface, the files
 * navigator, or the workspace panel: all three are disposed (the surface on a
 * tab switch, the panel on close), and a change landing while they are gone
 * would otherwise be restored as stale data from an infinite-stale cache on
 * the next mount. DirectoryScope outlives them whenever a session, page, or
 * terminal for the workspace is open anywhere in the workbench.
 *
 * The review entries are removed (their consumers are one-shot fetchQuery
 * calls); the file-status entry is invalidated, so a live navigator observer
 * refetches in place -- debounced, since watcher events arrive in bursts.
 *
 * Several panes for one directory each mount this, but the work is owned by
 * the ref-counted registry above: one listener and one refresh per event
 * regardless of pane count, and a single reconciliation when ownership
 * resumes after a window with no mounted surface at all.
 */
export function WorkspaceVcsCacheHonesty(props: ReviewVcsDirectory) {
  const sdk = useSDK()
  // The compute phase owns the reactive reads and returns the identity; the
  // effect phase owns the acquisition and returns its release as cleanup (the
  // two-phase form of the previous `onCleanup(acquire(...))`).
  //
  // It returns the PREVIOUS identity object when every field still matches, so
  // the effect phase is skipped on an invalidation that resolves to the same
  // (serverUrl, workspaceId, directory). Returning a fresh object each run
  // would release and immediately re-acquire the same key -- dropping the count
  // to 0, registering an ownerless gap, and paying a full reconciliation
  // (review removals plus two invalidations) for a no-op re-render.
  createRenderEffect(
    (previous: HonestyIdentity | undefined) => {
      const identity: HonestyIdentity = {
        directory: props.directory,
        serverUrl: sdk.url,
        workspaceId: sdk.workspaceId,
      }
      if (
        previous &&
        previous.directory === identity.directory &&
        previous.serverUrl === identity.serverUrl &&
        previous.workspaceId === identity.workspaceId
      )
        return previous
      return identity
    },
    (identity) =>
      acquireWorkspaceVcsCacheHonesty(identity, (handler) =>
        sdk.event.listen((event) => handler({ details: event.details })),
      ),
  )
  return null
}
