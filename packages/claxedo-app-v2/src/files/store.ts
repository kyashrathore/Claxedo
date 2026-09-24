import { createComponent, createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { PlacementId } from "@/server"
import type { Json } from "@/shell/types"

export type PaneOpener = (kind: string, state: Json, options?: { readonly paneId?: string }) => void

type PlacementFilesState = {
  readonly expanded: Readonly<Record<string, boolean>>
  readonly search: string
}

export type Files = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly openPane: PaneOpener
  readonly expanded: (dir: string) => boolean
  readonly setExpanded: (dir: string, expanded: boolean) => void
  readonly search: () => string
  readonly setSearch: (query: string) => void
}

const FilesContext = createContext<Files>()

const emptyState = (): PlacementFilesState => ({ expanded: {}, search: "" })

export type FilesProviderProps = ParentProps<{
  readonly placementId: Accessor<PlacementId | undefined>
  readonly openPane: PaneOpener
}>

export function FilesProvider(props: FilesProviderProps): JSX.Element {
  const [state, setState] = createStore<Record<string, PlacementFilesState>>({})
  const current = () => {
    const id = props.placementId()
    return id === undefined ? undefined : (state[id] ?? emptyState())
  }
  const write = (update: (current: PlacementFilesState) => PlacementFilesState) => {
    const id = props.placementId()
    if (id === undefined) return
    setState(id, update(state[id] ?? emptyState()))
  }
  const files: Files = {
    placementId: () => props.placementId(),
    openPane: (kind, value, options) => props.openPane(kind, value, options),
    expanded: (dir) => current()?.expanded[dir] ?? false,
    setExpanded: (dir, expanded) => write((prev) => ({ ...prev, expanded: { ...prev.expanded, [dir]: expanded } })),
    search: () => current()?.search ?? "",
    setSearch: (search) => write((prev) => ({ ...prev, search })),
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
