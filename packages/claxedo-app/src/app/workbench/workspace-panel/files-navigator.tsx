import { createAsyncState } from "@/lib/async-state"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import FileTree from "@/app/workbench/controls/file-tree"
import { useFile } from "@/app/providers/file"
import { useSDK } from "@/app/providers/sdk/sdk"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { File as StatusFile } from "@opencode-ai/sdk/v2"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import { workspaceFileStatusQueryOptions } from "@/platform/files/workspace-file-status-query"
import { cachedFileReadRequest } from "@/platform/files/file-request-cache"

type Kind = "add" | "del" | "mix"

function kindForStatus(status: StatusFile["status"] | string): Kind {
  if (status === "added") return "add"
  if (status === "deleted") return "del"
  return "mix"
}

function mergeKind(current: Kind | undefined, next: Kind) {
  if (!current) return next
  if (current === next) return current
  return "mix" as const
}

function getDirectory(file: string) {
  const index = file.lastIndexOf("/")
  if (index === -1) return ""
  return file.slice(0, index)
}

function getFilename(file: string) {
  const index = file.lastIndexOf("/")
  if (index === -1) return file
  return file.slice(index + 1)
}

function kindTextColor(kind: Kind) {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

function kindLabel(kind: Kind) {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
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
  mode: "files" | "changes"
  active: boolean
  activePath?: string
  onFileClick: (path: string, intent: "tab" | "review") => void
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
    if (!props.active || props.mode !== "files") return
    cancelPendingFilePrefetch()
    const sequence = ++filePrefetchSequence
    setFilePrefetch({ path, state: "loading" })
    // Avoid reading every row crossed by the pointer. A deliberate hover gets
    // authoritative bytes into the same runtime request cache TabFile reads,
    // while the viewer surface itself remains unmounted until click.
    filePrefetchTimer = setTimeout(() => {
      filePrefetchTimer = undefined
      if (!props.active || props.mode !== "files" || sequence !== filePrefetchSequence) return
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

  // Two-phase: the compute tracks only the suspension inputs, so the apply
  // phase's cancel never subscribes this effect to the prefetch state it pokes.
  createEffect(
    () => !(props.active && props.mode === "files"),
    (suspended) => {
      if (!suspended) return
      filePrefetchSequence += 1
      cancelPendingFilePrefetch()
    },
  )

  onCleanup(() => cancelPendingFilePrefetch())
  // One cache identity for workspace change status (see
  // `workspaceFileStatusQueryOptions`): freshness is event-owned, so a reopened
  // panel reuses the cached rows instead of refetching, and two observers of
  // the same directory share one in-flight request.
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
  const changedStatusByPath = createMemo(
    () => new Map((status() ?? []).map((item) => [item.path, item.status] as const)),
  )
  const kinds = createMemo(() => buildKinds(status() ?? []))
  const query = createMemo(() => search().trim())
  const searchResults = createAsyncState(async () => {
    const term = query()
    if (props.mode === "changes") return Promise.resolve([] as string[])
    if (!term) return Promise.resolve([] as string[])
    return file.searchFiles(term)
  })

  createEffect(
    () => props.mode !== "changes" && !!props.active && file.ready(),
    (shouldList) => {
      if (!shouldList) return
      return afterVisibleWork(() => void file.tree.list(""))
    },
  )

  createEffect(
    () => refresh() === undefined && !!props.active,
    (shouldPrime) => {
      if (!shouldPrime) return
      // Change counts are decorative workspace-panel data. Do not let their
      // comparatively expensive file-status request race a session transcript
      // when the user navigates immediately after the panel becomes visible.
      return afterVisibleWork(() => setRefresh(1), Math.max(250, fastSessionSwitchAnyQuietDelay()))
    },
  )

  // Reveal the active file (opened from a link / focus): expand its ancestor
  // directories and scroll its row into view. Expanding a directory kicks off
  // an async list, and the tree renders level-by-level as each load lands, so
  // observe the tree until the target row is materialized.
  let treeScrollRef: HTMLDivElement | undefined
  createEffect(
    () => (props.active && props.mode === "files" && file.ready() ? props.activePath : undefined),
    (path) => {
      if (!path) return
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
        return () => observer?.disconnect()
      }
      const frame = requestAnimationFrame(observeUntilRevealed)
      return () => {
        cancelAnimationFrame(frame)
        observer?.disconnect()
      }
    },
  )

  const allowedList = createMemo(() => {
    const term = query().toLowerCase()
    const base = props.mode === "changes" ? changedFiles() : undefined
    if (!term) return base
    if (!base) return searchResults.data()
    return base.filter((path) => path.toLowerCase().includes(term))
  })

  const emptyChanges = createMemo(
    () => props.mode === "changes" && !statusQuery.isLoading && (allowedList()?.length ?? 0) === 0,
  )
  const emptySearch = createMemo(
    () => props.mode === "files" && !!query() && !searchResults.loading() && (allowedList()?.length ?? 0) === 0,
  )
  const pendingFilesShell = createMemo(() => {
    if (props.mode !== "files") return false
    if (query()) return false
    if (!file.ready()) return true
    const root = file.tree.state("")
    return !root?.loaded && !root?.loading && file.tree.children("").length === 0
  })
  const rootRowsVisible = createMemo(() => props.mode === "files" && !query() && file.tree.children("").length > 0)
  const fileTreeShellReady = createMemo(() => {
    if (pendingFilesShell() || rootRowsVisible()) return true
    if (props.mode !== "files") return false
    if (query()) return false
    return !!file.tree.state("")?.loading
  })
  const fileTreeDataReady = createMemo(() => rootRowsVisible())

  const totalChanged = createMemo(() => changedFiles().length)

  /**
   * Whether the file tree is the branch this navigator should be showing —
   * the same condition the branch chain below encodes, named once so the
   * retained tree can be hidden by it instead of unmounted by it.
   */
  const showFileTree = createMemo(() =>
    props.mode === "files" && !pendingFilesShell() && !(!!query() && searchResults.loading) && !emptySearch()
  )
  /** Has the tree ever been shown? Nothing is retained before it is built.
   * (Solid 2 createMemo takes no seed argument; the first run's `previous`
   * is undefined, which the latch condition already treats as false.) */
  const fileTreeVisited = createMemo<boolean>((previous) => previous === true || showFileTree())

  return (
    <div
      data-testid="workspace-files-navigator"
      data-mode={props.mode}
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
            placeholder={props.mode === "changes" ? "Filter changes..." : "Search files..."}
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
        <Show when={props.mode === "changes"}>
          <span class="shrink-0 text-xs text-text-weak">{totalChanged()}</span>
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
        ) : (props.mode === "changes" && statusQuery.isLoading) ||
          (props.mode === "files" && !!query() && searchResults.loading()) ? (
          <div class="flex h-24 items-center justify-center">
            <Spinner class="h-4 w-4 text-text-weak" />
          </div>
        ) : emptyChanges() ? (
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">No changed files</div>
        ) : emptySearch() ? (
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">No files found</div>
        ) : props.mode === "changes" ? (
          <div data-testid="workspace-changed-file-list" class="flex flex-col gap-0.5 p-1" data-navigator-list="changes">
            <For each={allowedList() ?? []}>
              {(path) => {
                const status = () => changedStatusByPath().get(path) ?? "modified"
                const kind = () => kindForStatus(status())
                return (
                  <button
                    type="button"
                    data-file-tree-path={path}
                    class={[
                      "group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-12-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover active:bg-surface-base-active",
                      {
                        "bg-surface-base-active": props.activePath === path,
                      },
                    ]}

                    onClick={() => props.onFileClick(path, "review")}
                  >
                    <FileIcon
                      node={{ path, type: "file" }}
                      class="size-4 shrink-0 filetree-icon filetree-icon--mono"
                      style={kindTextColor(kind())}
                      mono
                    />
                    <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span class="min-w-0 truncate text-text-base">{getFilename(path)}</span>
                      <Show when={getDirectory(path)}>
                        <span class="min-w-0 truncate text-11-regular text-text-weak/70">{getDirectory(path)}</span>
                      </Show>
                    </span>
                    <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(kind())}>
                      {kindLabel(kind())}
                    </span>
                  </button>
                )
              }}
            </For>
          </div>
        ) : null}
        {/* The tree is a SIBLING of the branches above, not the last of them.
          Files and Changes are two lists over one workspace and the user flips
          between them; rebuilding the materialized tree on every flip is a
          synchronous construction of every visible row — the dominant task of
          a Changes -> Files switch, and the largest single allocation the
          panel makes, which is also what puts a major GC inside the next
          interaction. Once built the tree stays built, skipped by
          `content-visibility: hidden` while another branch shows: it renders
          nothing, hit-tests nothing, measures as zero-sized, and its own
          effects are disabled — but coming back is a reveal instead of a
          rebuild. */}
        <Show when={fileTreeVisited()}>
          <div
            data-navigator-list="files"
            style={{ "content-visibility": showFileTree() ? "visible" : "hidden" }}
          >
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
              onFileClick={(node) => props.onFileClick(node.path, props.mode === "changes" ? "review" : "tab")}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}
