import { createRenderEffect, onCleanup } from "solid-js"

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
 *   ONCE -- removes the review entries and invalidates file-status -- and the
 *   first read after the gap refetches. One reconciliation per gap, never per
 *   mount.
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

function createHonestyOwner(identity: HonestyIdentity, listen: HonestyListen): HonestyOwner {
  const stale = createReviewVcsDirectoryClassifier()
  let fileStatusTimer: ReturnType<typeof setTimeout> | undefined
  const unlisten = listen((event) => {
    if (!stale(event.details)) return
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
 * Keeps the module-scoped VCS caches for one workspace directory honest -- the
 * review reads (diff/file/refs/targets) and the canonical file-status query --
 * for as long as ANY surface of that workspace is mounted.
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
  createRenderEffect(() => {
    onCleanup(acquireWorkspaceVcsCacheHonesty(
      { directory: props.directory, serverUrl: sdk.url, workspaceId: sdk.workspaceId },
      (handler) => sdk.event.listen((event) => handler({ details: event.details })),
    ))
  })
  return null
}
