import { createComponent, createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { PlacementId } from "@/server"
import { useShellRoute } from "@/shell"

type PlacementFiles = {
  readonly expanded: Readonly<Record<string, boolean>>
  readonly search: string
}

export type Files = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly expanded: (dir: string) => boolean
  readonly setExpanded: (dir: string, expanded: boolean) => void
  readonly search: () => string
  readonly setSearch: (query: string) => void
}

const FilesContext = createContext<Files>()

const emptyFiles: PlacementFiles = { expanded: {}, search: "" }

export function FilesProvider(props: ParentProps): JSX.Element {
  const placementId = useShellRoute().placementId
  const [state, setState] = createStore<Record<string, PlacementFiles>>({})
  const current = () => {
    const id = placementId()
    return id === undefined ? emptyFiles : (state[id] ?? emptyFiles)
  }
  const write = (update: (previous: PlacementFiles) => PlacementFiles) => {
    const id = placementId()
    if (id !== undefined) setState(id, update(state[id] ?? emptyFiles))
  }
  const files: Files = {
    placementId,
    expanded: (dir) => current().expanded[dir] === true,
    setExpanded: (dir, expanded) =>
      write((previous) => ({ ...previous, expanded: { ...previous.expanded, [dir]: expanded } })),
    search: () => current().search,
    setSearch: (search) => write((previous) => ({ ...previous, search })),
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
