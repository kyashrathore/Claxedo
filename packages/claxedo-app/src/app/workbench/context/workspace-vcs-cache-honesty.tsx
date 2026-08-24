import { onCleanup } from "solid-js"

import { useSDK } from "@/app/providers/sdk/sdk"
import { invalidateReviewVcsDirectory, type ReviewVcsDirectory } from "@/features/review/ui/review-vcs-cache"
import { createReviewVcsDirectoryClassifier } from "@/features/review/ui/review-vcs-invalidation"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

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
 * Several panes for one directory each mount this; both operations are
 * idempotent, so the duplicates cost a string compare per event. A workspace
 * with NO mounted surface at all has no event stream either -- that residual
 * window is accepted and documented in the performance handoff.
 */
export function WorkspaceVcsCacheHonesty(props: ReviewVcsDirectory) {
  const sdk = useSDK()
  const stale = createReviewVcsDirectoryClassifier()
  let fileStatusTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(sdk.event.listen((event) => {
    if (!stale(event.details)) return
    invalidateReviewVcsDirectory({ directory: props.directory })
    if (fileStatusTimer) clearTimeout(fileStatusTimer)
    fileStatusTimer = setTimeout(() => {
      fileStatusTimer = undefined
      void queryClient.invalidateQueries({
        queryKey: queryKeys.directory.fileStatus(sdk.url, props.directory, sdk.workspaceId),
      })
    }, 250)
  }))
  onCleanup(() => {
    if (fileStatusTimer) clearTimeout(fileStatusTimer)
  })
  return null
}
