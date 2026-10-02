import { createComponent, createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import type { PlacementId } from "@/server"
import { createPlacementState } from "@/shell"
import type { RevealBatches } from "./tree-rows"

type PlacementFiles = {
  readonly expanded: Readonly<Partial<Record<string, boolean>>>
  readonly search: string
  readonly markdownSource: Readonly<Partial<Record<string, boolean>>>
  readonly scrollTop: number
  readonly batches: Readonly<Record<string, RevealBatches>>
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
  readonly batches: (dir: string) => RevealBatches
  readonly growBatches: (dir: string, side: keyof RevealBatches) => void
  readonly resetBatches: () => void
  readonly markdownSource: (path: string) => boolean
  readonly toggleMarkdownSource: (path: string) => void
}

const FilesContext = createContext<Files>()

const noBatches: RevealBatches = { before: 0, after: 0 }

const emptyFiles: PlacementFiles = { expanded: {}, search: "", markdownSource: {}, scrollTop: 0, batches: {} }

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
    batches: (dir) => current().batches[dir] ?? noBatches,
    growBatches: (dir, side) =>
      write((previous) => {
        const batches = previous.batches[dir] ?? noBatches
        return { ...previous, batches: { ...previous.batches, [dir]: { ...batches, [side]: batches[side] + 1 } } }
      }),
    resetBatches: () => write((previous) => (Object.keys(previous.batches).length === 0 ? previous : { ...previous, batches: {} })),
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
