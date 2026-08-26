import { storePath } from "solid-js"
// Claxedo FileProvider owns file tree, read cache, and view state outside the override resolver.
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { useSDK } from "@/app/providers/sdk/sdk"
import { useLanguage } from "@/platform/i18n/provider"
import { useLayout } from "@/app/providers/layout"
import { createPathHelpers } from "@/platform/files/path"
import {
  acquireFileRequestCache,
  cachedFileReadRequest,
  fileRequestRuntimeKey,
  invalidateCachedFileReadRequest,
  type FileRequestRuntime,
} from "@/platform/files/file-request-cache"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "@/platform/files/content-cache"
import { createFileViewCache } from "@/platform/files/view-cache"
import { createFileTreeStore } from "@/platform/files/tree-store"
import { invalidateFromWatcher } from "@/platform/files/watcher"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "@/platform/files/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

function isCancelledError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.name === "CancelledError" || error.name === "AbortError" || error.message === "CancelledError"
}

const fileContextInput = {
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk.directory)
    const requestRuntime = createMemo<FileRequestRuntime>(() => ({
      baseUrl: sdk.url,
      workspaceId: sdk.workspaceId,
      directory: scope(),
    }))
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(scope)

    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      runtime: requestRuntime,
      normalizeDir: path.normalizeDir,
      list: (dir) => sdk.client.file.list({ path: dir }).then((x) => x.data ?? []),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(($state) => {
          const draft = $state["file"][target]
          draft.content = undefined
          draft.loaded = false
        })
      })
    }

    // Keyed on the whole runtime (base url + workspace + directory), not just
    // the directory: the refcounted request cache is shared per runtime key, so
    // the previous runtime's handle must be released before the next one is
    // acquired. The returned cleanup does exactly what `onCleanup` did here.
    createEffect(
      () => requestRuntime(),
      (runtime) => {
        const requestCache = acquireFileRequestCache(runtime)
        resetFileContentLru()
        setStore(($store) => {
          reconcile({})($store.file)
        })
        tree.reset()
        return requestCache.release
      },
    )

    const viewCache = createFileViewCache()
    const view = createMemo(() => viewCache.load(scope(), undefined))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore(storePath("file", file, { path: file, name: getFilename(file) }))
    }

    const setLoading = (file: string) => {
      setStore(($state) => {
        const draft = $state["file"][file]
        draft.loading = true
        draft.error = undefined
      })
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(($state) => {
        const draft = $state["file"][file]
        draft.loaded = true
        draft.loading = false
        draft.content = content
      })
    }

    const setLoadError = (file: string, message: string) => {
      setStore(($state) => {
        const draft = $state["file"][file]
        draft.loading = false
        draft.error = message
      })
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const runtime = requestRuntime()
      const runtimeKey = fileRequestRuntimeKey(runtime)
      const directory = runtime.directory
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      setLoading(file)

      return cachedFileReadRequest({
        runtime,
        file,
        force: options?.force,
        read: () => sdk.client.file.read({ path: file }).then((x) => x.data),
      })
        .then((x) => {
          if (fileRequestRuntimeKey(requestRuntime()) !== runtimeKey) return
          const content = x
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (fileRequestRuntimeKey(requestRuntime()) !== runtimeKey) return
          if (isCancelledError(e)) {
            setStore(($state) => {
              const draft = $state["file"][file]
              draft.loading = false
            })
            return
          }
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
    }

    const search = (query: string, dirs: "true" | "false") =>
      sdk.client.find.files({ query, dirs }).then(
        (x) => (x.data ?? []).map(path.normalize),
        () => [],
      )

    const stop = sdk.event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        invalidateFile: (file) => invalidateCachedFileReadRequest(requestRuntime(), file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      stop()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
    }
  },
}
export const { use: useFile, provider: FileProvider } = createSimpleContext<
  ReturnType<typeof fileContextInput.init>,
  Record<string, any>
>(fileContextInput)
