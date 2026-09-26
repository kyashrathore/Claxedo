import { createComponent, createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import type { PlacementId } from "@/server"
import { createPlacementState } from "@/shell"

type PlacementFiles = {
  readonly expanded: Readonly<Record<string, boolean>>
  readonly search: string
  readonly markdownSource: Readonly<Record<string, boolean>>
  readonly scrollTop: number
}

export type Files = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly expanded: (dir: string) => boolean
  readonly expandedDirs: () => readonly string[]
  readonly setExpanded: (dir: string, expanded: boolean) => void
  readonly search: () => string
  readonly setSearch: (query: string) => void
  readonly scrollTop: () => number
  readonly setScrollTop: (top: number) => void
  readonly markdownSource: (path: string) => boolean
  readonly toggleMarkdownSource: (path: string) => void
}

const FilesContext = createContext<Files>()

const emptyFiles: PlacementFiles = { expanded: {}, search: "", markdownSource: {}, scrollTop: 0 }

export function FilesProvider(props: ParentProps): JSX.Element {
  const { placementId, current, write } = createPlacementState(emptyFiles)
  const files: Files = {
    placementId,
    expanded: (dir) => current().expanded[dir] === true,
    expandedDirs: () => Object.keys(current().expanded).filter((dir) => current().expanded[dir] === true),
    setExpanded: (dir, expanded) =>
      write((previous) =>
        (previous.expanded[dir] === true) === expanded ? previous : { ...previous, expanded: { ...previous.expanded, [dir]: expanded } },
      ),
    search: () => current().search,
    setSearch: (search) => write((previous) => ({ ...previous, search })),
    scrollTop: () => current().scrollTop,
    setScrollTop: (scrollTop) => write((previous) => ({ ...previous, scrollTop })),
    markdownSource: (path) => current().markdownSource[path] === true,
    toggleMarkdownSource: (path) =>
      write((previous) => ({ ...previous, markdownSource: { ...previous.markdownSource, [path]: previous.markdownSource[path] !== true } })),
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
