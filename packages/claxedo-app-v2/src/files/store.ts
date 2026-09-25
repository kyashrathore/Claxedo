import {
  createComponent,
  createContext,
  untrack,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { PlacementId } from "@/server"
import { useShellRoute } from "@/shell"

type PlacementFiles = {
  expanded: Record<string, boolean>
  search: string
  markdownSource: Record<string, boolean>
}

export type Files = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly expanded: (dir: string) => boolean
  readonly expandedDirs: () => readonly string[]
  readonly setExpanded: (dir: string, expanded: boolean) => void
  readonly search: () => string
  readonly setSearch: (query: string) => void
  readonly markdownSource: (path: string) => boolean
  readonly toggleMarkdownSource: (path: string) => void
}

const FilesContext = createContext<Files>()

const emptyFiles: PlacementFiles = { expanded: {}, search: "", markdownSource: {} }

export function FilesProvider(props: ParentProps): JSX.Element {
  const placementId = useShellRoute().placementId
  const [state, setState] = createStore<Record<string, PlacementFiles>>({})
  const current = () => {
    const id = placementId()
    return id === undefined ? emptyFiles : (state[id] ?? emptyFiles)
  }
  const target = () =>
    untrack(() => {
      const id = placementId()
      if (id !== undefined && state[id] === undefined) setState(id, { expanded: {}, search: "", markdownSource: {} })
      return id
    })
  const files: Files = {
    placementId,
    expanded: (dir) => current().expanded[dir] === true,
    expandedDirs: () => Object.keys(current().expanded).filter((dir) => current().expanded[dir] === true),
    setExpanded: (dir, expanded) => {
      const id = target()
      if (id === undefined || untrack(() => state[id]?.expanded[dir] === true) === expanded) return
      setState(id, "expanded", dir, expanded)
    },
    search: () => current().search,
    setSearch: (search) => {
      const id = target()
      if (id !== undefined) setState(id, "search", search)
    },
    markdownSource: (path) => current().markdownSource[path] === true,
    toggleMarkdownSource: (path) => {
      const id = target()
      if (id !== undefined) setState(id, "markdownSource", path, (source) => source !== true)
    },
  }
  return createComponent(FilesContext.Provider, {
    value: files,
    get children() {
      return props.children
    },
  })
}

export function useFiles(): Files {
  const files = useContext(FilesContext)
  if (!files) throw new Error("useFiles needs a FilesProvider above it")
  return files
}
