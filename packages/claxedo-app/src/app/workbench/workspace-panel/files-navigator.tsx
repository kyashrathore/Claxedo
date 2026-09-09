import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import FileTree from "@/app/workbench/controls/file-tree"
import { useFile } from "@/app/providers/file"
import { useSDK } from "@/app/providers/sdk/sdk"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { WorkspaceFileStatus as StatusFile } from "@claxedo/workspace-runtime/client"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import { workspaceFileStatusQueryOptions } from "@/platform/files/workspace-file-status-query"
import { cachedFileReadRequest } from "@/platform/files/file-request-cache"

type Kind = "add" | "del" | "mix"

function kindForStatus(status: StatusFile["status"]): Kind {
  if (status === "added") return "add"
  if (status === "deleted") return "del"
  return "mix"
}

function mergeKind(current: Kind | undefined, next: Kind) {
  if (!current) return next
  if (current === next) return current
  return "mix" as const
}

function buildKinds(files: readonly StatusFile[]) {
  const out = new Map<string, Kind>()
  for (const file of files) {
    const normalized = file.path.replaceAll("\\", "/").replace(/\/+$/, "")
    const kind = kindForStatus(file.status)
    out.set(normalized, kind)

    const parts = normalized.split("/")
    for (const [idx] of parts.slice(0, -1).entries()) {
      const dir = parts.slice(0, idx + 1).join("/")
      if (!dir) continue
      out.set(dir, mergeKind(out.get(dir), kind))
    }
  }
  return out
}

function afterVisibleWork(callback: () => void, delay = 0) {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: ReturnType<typeof requestAnimationFrame> | undefined

  frame = requestAnimationFrame(() => {
    frame = undefined
    if (cancelled) return
    timer = setTimeout(() => {
      timer = undefined
      if (cancelled) return
      callback()
    }, delay)
  })

  return () => {
    cancelled = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (timer) clearTimeout(timer)
  }
}

export function WorkspaceFilesNavigator(props: {
  active: boolean
  activePath?: string
  onFileClick: (path: string) => void
}) {
  const sdk = useSDK()
  const file = useFile()
  const [search, setSearch] = createSignal("")
  const [refresh, setRefresh] = createSignal<number | undefined>()
  const [filePrefetch, setFilePrefetch] = createSignal<{ path: string; state: "loading" | "ready" | "error" }>()
  let filePrefetchTimer: ReturnType<typeof setTimeout> | undefined
  let filePrefetchSequence = 0

  const cancelPendingFilePrefetch = (path?: string) => {
    const current = filePrefetch()
    if (path && current?.path !== path) return
    if (filePrefetchTimer) clearTimeout(filePrefetchTimer)
    filePrefetchTimer = undefined
  }

  const prefetchFile = (path: string) => {
    if (!props.active) return
    cancelPendingFilePrefetch()
    const sequence = ++filePrefetchSequence
    setFilePrefetch({ path, state: "loading" })
    // Avoid reading every row crossed by the pointer. A deliberate hover gets
    // authoritative bytes into the same runtime request cache TabFile reads,
    // while the viewer surface itself remains unmounted until click.
    filePrefetchTimer = setTimeout(() => {
      filePrefetchTimer = undefined
      if (!props.active || sequence !== filePrefetchSequence) return
      void cachedFileReadRequest({
        runtime: { baseUrl: sdk.url, workspaceId: sdk.workspaceId, directory: sdk.directory },
        file: path,
        read: () => sdk.client.file.read({ path }).then((response) => response.data),
      }).then(
        () => {
          if (sequence === filePrefetchSequence) setFilePrefetch({ path, state: "ready" })
        },
        () => {
          if (sequence === filePrefetchSequence) setFilePrefetch({ path, state: "error" })
        },
      )
    }, 120)
  }

  createEffect(() => {
    if (props.active) return
    filePrefetchSequence += 1
    cancelPendingFilePrefetch()
  })

  onCleanup(() => cancelPendingFilePrefetch())
  const statusQuery = useQuery(() => ({
    ...workspaceFileStatusQueryOptions({
      baseUrl: sdk.url,
      directoryPath: sdk.directory,
      workspaceKey: sdk.workspaceId,
      client: sdk.client,
    }),
    enabled: props.active && refresh() !== undefined,
  }))
  const status = () => statusQuery.data

  const changedFiles = createMemo(() => (status() ?? []).map((item) => item.path))
  const kinds = createMemo(() => buildKinds(status() ?? []))
  const query = createMemo(() => search().trim())
  const [searchResults] = createResource(query, (term) => {
    if (!term) return Promise.resolve([] as string[])
    return file.searchFiles(term)
  })

  createEffect(() => {
    if (!props.active) return
    if (!file.ready()) return
    const stop = afterVisibleWork(() => void file.tree.list(""))
    onCleanup(stop)
  })

  createEffect(() => {
    if (refresh() !== undefined) return
    if (!props.active) return
    // Change markers are decorative workspace-panel data. Do not let their
    // comparatively expensive file-status request race a session transcript
    // when the user navigates immediately after the panel becomes visible.
    const stop = afterVisibleWork(() => setRefresh(1), Math.max(250, fastSessionSwitchAnyQuietDelay()))
    onCleanup(stop)
  })

  // Reveal the active file (opened from a link / focus): expand its ancestor
  // directories and scroll its row into view. Expanding a directory kicks off
  // an async list, and the tree renders level-by-level as each load lands, so
  // observe the tree until the target row is materialized.
  let treeScrollRef: HTMLDivElement | undefined
  createEffect(() => {
    const path = props.activePath
    if (!path || !props.active) return
    if (!file.ready()) return
    const segments = path.split("/").slice(0, -1)
    let dir = ""
    for (const segment of segments) {
      dir = dir ? `${dir}/${segment}` : segment
      file.tree.expand(dir)
    }
    const reveal = () => {
      const row = treeScrollRef?.querySelector(`[data-file-tree-path="${CSS.escape(path)}"]`)
      if (!row) return false
      row.scrollIntoView({ block: "nearest" })
      return true
    }
    let observer: MutationObserver | undefined
    const observeUntilRevealed = () => {
      if (reveal()) return
      if (!treeScrollRef || typeof MutationObserver === "undefined") return
      observer = new MutationObserver(() => {
        if (reveal()) observer?.disconnect()
      })
      observer.observe(treeScrollRef, { childList: true, subtree: true })
    }
    // scrollIntoView forces layout; running it synchronously inside this
    // effect thrashes a mid-construction tree (a reopened panel mounts 500
    // rows in the same turn). One frame later the tree has laid out once and
    // the scroll reads clean geometry.
    if (typeof requestAnimationFrame !== "function") {
      observeUntilRevealed()
      onCleanup(() => observer?.disconnect())
      return
    }
    const frame = requestAnimationFrame(observeUntilRevealed)
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    })
  })

  // Calling the resource registers the enclosing memo with the nearest
  // SuspenseContext for as long as a fetch is in flight, and the only boundary
  // above this panel wraps the whole shell — so reading it while a search is
  // pending swapped the entire app for the boot fallback on every keystroke.
  // `state` is a plain signal read: it neither suspends nor rethrows, and
  // holding the previous hits keeps the tree stable while the next query runs.
  const allowedList = createMemo<readonly string[] | undefined>((previous) => {
    if (!query()) return undefined
    if (searchResults.state !== "ready") return previous
    return searchResults()
  }, undefined)

  const emptySearch = createMemo(() => !!query() && !searchResults.loading && (allowedList()?.length ?? 0) === 0)
  const pendingFilesShell = createMemo(() => {
    if (query()) return false
    if (!file.ready()) return true
    const root = file.tree.state("")
    return !root?.loaded && !root?.loading && file.tree.children("").length === 0
  })
  const rootRowsVisible = createMemo(() => !query() && file.tree.children("").length > 0)
  const fileTreeShellReady = createMemo(() => {
    if (pendingFilesShell() || rootRowsVisible()) return true
    if (query()) return false
    return !!file.tree.state("")?.loading
  })
  const fileTreeDataReady = createMemo(() => rootRowsVisible())

  const searchPending = createMemo(() => !!query() && searchResults.loading)
  const showFileTree = createMemo(() => !pendingFilesShell() && !searchPending() && !emptySearch())
  const fileTreeVisited = createMemo<boolean>((previous) => previous || showFileTree(), false)

  return (
    <div
      data-testid="workspace-files-navigator"
      data-file-prefetch-path={filePrefetch()?.path}
      data-file-prefetch-state={filePrefetch()?.state}
      data-file-tree-shell-ready={fileTreeShellReady() ? "true" : undefined}
      data-file-tree-data-ready={fileTreeDataReady() ? "true" : undefined}
      class="flex size-full min-h-0 flex-col"
    >
      <div class="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-border-weak-base">
        <Icon name="magnifying-glass" size="small" class="text-icon-weak-base shrink-0" />
        <div class="flex min-w-0 flex-1 items-center rounded-md border border-transparent bg-surface-base px-2 focus-within:border-border-strong-base focus-within:bg-background-base">
          <input
            type="text"
            value={search()}
            placeholder="Search files..."
            autofocus
            class="flex-1 min-w-0 bg-transparent text-sm text-text-base placeholder:text-text-weak/60 outline-none"
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("")
              }
            }}
          />
        </div>
        <Show when={query()}>
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setSearch("")
            }}
            class="flex items-center justify-center size-6 rounded text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer"
          >
            <Icon name="close-small" size="small" />
          </button>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto" ref={treeScrollRef}>
        {pendingFilesShell() ? (
          <div data-component="filetree" class="flex flex-col gap-0.5 p-1">
            <div data-file-tree-loading class="flex flex-col gap-0.5" aria-label="Loading files">
              <div class="h-6 w-[82%] rounded-md bg-surface-base" />
              <div class="h-6 w-[76%] rounded-md bg-surface-base" />
              <div class="h-6 w-[69%] rounded-md bg-surface-base" />
              <div class="h-6 w-[61%] rounded-md bg-surface-base" />
              <div class="h-6 w-[54%] rounded-md bg-surface-base" />
            </div>
          </div>
        ) : searchPending() ? (
          <div class="flex h-24 items-center justify-center">
            <Spinner class="h-4 w-4 text-text-weak" />
          </div>
        ) : emptySearch() ? (
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">No files found</div>
        ) : null}
        {/* Building the tree is a synchronous construction of every visible
          row, the largest single allocation the panel makes. Once built it
          stays mounted while a search is pending or empty, skipped by
          `content-visibility: hidden` (renders nothing, hit-tests nothing,
          measures as zero-sized, own effects disabled), so clearing the search
          is a reveal instead of a rebuild. */}
        <Show when={fileTreeVisited()}>
          <div style={{ "content-visibility": showFileTree() ? "visible" : "hidden" }}>
            <FileTree
              path=""
              enabled={props.active && showFileTree()}
              allowed={allowedList()}
              modified={changedFiles()}
              kinds={kinds()}
              active={props.activePath}
              draggable={false}
              visibleLimit={24}
              onFilePointerEnter={(node) => prefetchFile(node.path)}
              onFilePointerLeave={(node) => cancelPendingFilePrefetch(node.path)}
              onFileClick={(node) => props.onFileClick(node.path)}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}
