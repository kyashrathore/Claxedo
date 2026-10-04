import { createComponent, createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { createPlacementState } from "@/shell"
import type { DiffScope, PlacementId } from "@/server"
import { defaultScope, defaultSections, type DiffStyle, type SourceControlSection, type SourceControlSections } from "./model"
import type { ReviewScrollPosition } from "./scroll-restoration"

type PlacementReview = {
  readonly scope: DiffScope
  readonly open: readonly string[]
  readonly forced: readonly string[]
  readonly message: string
  readonly style: DiffStyle
  readonly scroll: ReviewScrollPosition
  readonly sections: SourceControlSections
  readonly groupsScrollTop: number
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
  readonly scroll: () => ReviewScrollPosition
  readonly setScroll: (position: ReviewScrollPosition) => void
  readonly sections: () => SourceControlSections
  readonly toggleSection: (section: SourceControlSection) => void
  readonly groupsScrollTop: () => number
  readonly setGroupsScrollTop: (top: number) => void
  readonly forced: (file: string) => boolean
  readonly force: (file: string) => void
  readonly message: () => string
  readonly setMessage: (message: string) => void
}

const ReviewContext = createContext<Review>()

const emptyReview: PlacementReview = {
  scope: defaultScope,
  open: [],
  forced: [],
  message: "",
  style: "unified",
  scroll: { top: 0 },
  sections: defaultSections,
  groupsScrollTop: 0,
}

function toggled(list: readonly string[], item: string): readonly string[] {
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]
}

export function ReviewProvider(props: ParentProps): JSX.Element {
  const { placementId, current, write } = createPlacementState(emptyReview)
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
    scroll: () => current().scroll,
    setScroll: (scroll) => write((previous) => ({ ...previous, scroll })),
    sections: () => current().sections,
    toggleSection: (section) =>
      write((previous) => ({ ...previous, sections: { ...previous.sections, [section]: !previous.sections[section] } })),
    groupsScrollTop: () => current().groupsScrollTop,
    setGroupsScrollTop: (groupsScrollTop) => write((previous) => ({ ...previous, groupsScrollTop })),
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
