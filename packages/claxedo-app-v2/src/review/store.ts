import { createComponent, createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { DiffScope, PlacementId } from "@/server"
import type { PaneOpener } from "@/files"
import { defaultScope, type DiffStyle, type LineComment, type LineCommentInput } from "./model"

type PlacementReviewState = {
  readonly scope: DiffScope
  readonly open: Readonly<Record<string, boolean>>
  readonly style: DiffStyle
  readonly excluded: Readonly<Record<string, boolean>>
  readonly forced: Readonly<Record<string, boolean>>
  readonly comments: readonly LineComment[]
  readonly message: string
}

export type Review = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly openPane: PaneOpener
  readonly scope: () => DiffScope
  readonly setScope: (scope: DiffScope) => void
  readonly isOpen: (file: string) => boolean
  readonly setOpen: (file: string, open: boolean) => void
  readonly style: () => DiffStyle
  readonly toggleStyle: () => void
  readonly excluded: (path: string) => boolean
  readonly setExcluded: (path: string, excluded: boolean) => void
  readonly forced: (file: string) => boolean
  readonly force: (file: string) => void
  readonly comments: () => readonly LineComment[]
  readonly addComment: (input: LineCommentInput) => void
  readonly removeComment: (id: string) => void
  readonly takeComments: () => readonly LineComment[]
  readonly message: () => string
  readonly setMessage: (message: string) => void
}

const ReviewContext = createContext<Review>()

const emptyState = (): PlacementReviewState => ({
  scope: defaultScope,
  open: {},
  style: "unified",
  excluded: {},
  forced: {},
  comments: [],
  message: "",
})

export type ReviewProviderProps = ParentProps<{
  readonly placementId: Accessor<PlacementId | undefined>
  readonly openPane: PaneOpener
}>

export function ReviewProvider(props: ReviewProviderProps): JSX.Element {
  const [state, setState] = createStore<Record<string, PlacementReviewState>>({})
  const current = () => {
    const id = props.placementId()
    return id === undefined ? emptyState() : (state[id] ?? emptyState())
  }
  const write = (update: (current: PlacementReviewState) => PlacementReviewState) => {
    const id = props.placementId()
    if (id === undefined) return
    setState(id, update(state[id] ?? emptyState()))
  }
  const review: Review = {
    placementId: () => props.placementId(),
    openPane: (kind, value, options) => props.openPane(kind, value, options),
    scope: () => current().scope,
    setScope: (scope) => write((prev) => ({ ...prev, scope, open: {} })),
    isOpen: (file) => current().open[file] ?? false,
    setOpen: (file, open) => write((prev) => ({ ...prev, open: { ...prev.open, [file]: open } })),
    style: () => current().style,
    toggleStyle: () => write((prev) => ({ ...prev, style: prev.style === "unified" ? "split" : "unified" })),
    excluded: (path) => current().excluded[path] ?? false,
    setExcluded: (path, excluded) => write((prev) => ({ ...prev, excluded: { ...prev.excluded, [path]: excluded } })),
    forced: (file) => current().forced[file] ?? false,
    force: (file) => write((prev) => ({ ...prev, forced: { ...prev.forced, [file]: true } })),
    comments: () => current().comments,
    addComment: (input) => write((prev) => ({ ...prev, comments: [...prev.comments, { ...input, id: crypto.randomUUID() }] })),
    removeComment: (id) => write((prev) => ({ ...prev, comments: prev.comments.filter((comment) => comment.id !== id) })),
    takeComments: () => {
      const taken = current().comments
      write((prev) => ({ ...prev, comments: [] }))
      return taken
    },
    message: () => current().message,
    setMessage: (message) => write((prev) => ({ ...prev, message })),
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
