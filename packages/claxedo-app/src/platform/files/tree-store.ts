import { storePath } from "solid-js"
import { createStore, reconcile } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { cachedFileTreeRequest, clearFileRequestCache } from "@/platform/files/file-request-cache"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  children?: string[]
}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Promise<FileNode[]>
  onError: (message: string) => void
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string") return error
  return "Unknown error"
}

function isCancelledError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.name === "CancelledError" || error.name === "AbortError" || error.message === "CancelledError"
}

export function createFileTreeStore(options: TreeStoreOptions) {
  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>({
    node: {},
    dir: { "": { expanded: true } },
  })

  const reset = () => {
    clearFileRequestCache(options.scope())
    setTree(($tree) => {
      reconcile({})($tree.node)
      reconcile({})($tree.dir)
    })
    setTree(storePath("dir", "", { expanded: true }))
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    setTree(storePath("dir", path, { expanded: false }))
  }

  const listDir = (input: string, opts?: { force?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loading) return Promise.resolve()
    if (!opts?.force && current?.loaded) return Promise.resolve()

    setTree(($state) => {
      const draft = $state["dir"][dir]
      draft.loading = true
      draft.error = undefined
    })

    const directory = options.scope()

    return cachedFileTreeRequest({
      directory,
      dir,
      force: opts?.force,
      list: () => options.list(dir),
    })
      .then((nodes) => {
        if (options.scope() !== directory) return
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextChildren = nodes.map((node) => node.path)
        const nextSet = new Set(nextChildren)

        setTree(($state) => {
          const draft = $state["node"]
          const removedDirs: string[] = []
          for (const child of prevChildren) {
            if (nextSet.has(child)) continue
            const existing = draft[child]
            if (existing?.type === "directory") removedDirs.push(child)
            delete draft[child]
          }
          if (removedDirs.length > 0) {
            const keys = Object.keys(draft)
            for (const key of keys) {
              for (const removed of removedDirs) {
                if (!key.startsWith(removed + "/")) continue
                delete draft[key]
                break
              }
            }
          }
          for (const node of nodes) {
            draft[node.path] = node
          }
        })

        setTree(($state) => {
          const draft = $state["dir"][dir]
          draft.loaded = true
          draft.loading = false
          draft.children = nextChildren
        })
      })
      .catch((e) => {
        if (options.scope() !== directory) return
        if (isCancelledError(e)) {
          setTree(($state) => {
            const draft = $state["dir"][dir]
            draft.loading = false
          })
          return
        }
        const message = errorMessage(e)
        setTree(($state) => {
          const draft = $state["dir"][dir]
          draft.loading = false
          draft.error = message
        })
        options.onError(message)
      })
  }

  const expandDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree(storePath("dir", dir, "expanded", true))
    void listDir(dir)
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree(storePath("dir", dir, "expanded", false))
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    const ids = tree.dir[dir]?.children
    if (!ids) return []
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    return out
  }

  return {
    listDir,
    expandDir,
    collapseDir,
    dirState,
    children,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    reset,
  }
}
