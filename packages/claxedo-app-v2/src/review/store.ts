import { createComponent, createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useShellRoute } from "@/shell"
import type { DiffScope, PlacementId } from "@/server"
import { defaultScope, type DiffStyle } from "./model"

type PlacementReview = {
  readonly scope: DiffScope
  readonly open: readonly string[]
  readonly forced: readonly string[]
  readonly message: string
  readonly style: DiffStyle
}

export type Review = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly scope: () => DiffScope
  readonly setScope: (scope: DiffScope) => void
  readonly open: () => readonly string[]
  readonly setOpen: (files: readonly string[]) => void
  readonly expand: (file: string) => void
  readonly toggleOpen: (file: string) => void
  readonly style: Accessor<DiffStyle>
  readonly setStyle: (style: DiffStyle) => void
  readonly forced: (file: string) => boolean
  readonly force: (file: string) => void
  readonly message: () => string
  readonly setMessage: (message: string) => void
}

const ReviewContext = createContext<Review>()

const emptyReview: PlacementReview = { scope: defaultScope, open: [], forced: [], message: "", style: "unified" }

function toggled(list: readonly string[], item: string): readonly string[] {
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]
}

export function ReviewProvider(props: ParentProps): JSX.Element {
  const placementId = useShellRoute().placementId
  const [state, setState] = createStore<Record<string, PlacementReview>>({})
  const current = () => {
    const id = placementId()
    return id === undefined ? emptyReview : (state[id] ?? emptyReview)
  }
  const write = (update: (previous: PlacementReview) => PlacementReview) => {
    const id = placementId()
    if (id !== undefined) setState(id, update(state[id] ?? emptyReview))
  }
  const review: Review = {
    placementId,
    scope: () => current().scope,
    setScope: (scope) => write((previous) => ({ ...previous, scope, open: [] })),
    open: () => current().open,
    setOpen: (files) => write((previous) => ({ ...previous, open: files })),
    expand: (file) =>
      write((previous) => (previous.open.includes(file) ? previous : { ...previous, open: [...previous.open, file] })),
    toggleOpen: (file) => write((previous) => ({ ...previous, open: toggled(previous.open, file) })),
    style: () => current().style,
    setStyle: (style) => write((previous) => ({ ...previous, style })),
    forced: (file) => current().forced.includes(file),
    force: (file) => write((previous) => ({ ...previous, forced: [...previous.forced, file] })),
    message: () => current().message,
    setMessage: (message) => write((previous) => ({ ...previous, message })),
  }
  return createComponent(ReviewContext.Provider, {
    value: review,
    get children() {
      return props.children
    },
  })
}

export function useReview(): Review {
  const review = useContext(ReviewContext)
  if (!review) throw new Error("useReview needs a ReviewProvider above it")
  return review
}
