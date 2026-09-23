import { createMemo, createRoot, getOwner, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "@opencode-ai/ui/context/i18n"

import type { SelectedLineRange } from "@/platform/files/types"
import {
  cloneSelectedLineRange,
  createLineCommentController,
  createLineCommentEditorState,
  previewSelectedLines,
  resolveFileDiff,
  text,
  type DiffSource,
  type LineCommentAnnotationMeta,
  type LineCommentEditorProps,
  type LineCommentEditorState,
  type ReviewCodeViewComments,
  type ReviewCodeViewCommentOwner,
} from "@/ui/session-kit"
import { ReviewCommentMenu, type SessionReviewCommentActions } from "./review-comment-menu"

/**
 * What a review line comment is: the shapes the comment store, the prompt
 * context and this surface all speak.
 */
export type SessionReviewComment = {
  id: string
  file: string
  selection: SelectedLineRange
  comment: string
}

export type SessionReviewLineComment = {
  file: string
  selection: SelectedLineRange
  comment: string
  preview?: string
}

export type SessionReviewCommentUpdate = SessionReviewLineComment & { id: string }

export type SessionReviewCommentDelete = { id: string; file: string }

/** The comment a caller asked the surface to reveal. */
export type SessionReviewFocus = { file: string; id: string }

export type ReviewAnnotationMeta = LineCommentAnnotationMeta<SessionReviewComment>
type ReviewComments = ReviewCodeViewComments<ReviewAnnotationMeta>
type ReviewAnnotation = NonNullable<ReturnType<ReviewComments["annotations"]>>[number]

/** A file plus a range, the shape every review selection state carries. */
type FileRange = { file: string; range: SelectedLineRange }

export type ReviewCodeViewCommentsInput = {
  comments: Accessor<SessionReviewComment[]>
  /** The diff corpus, for the quoted preview a submitted comment carries. */
  diffs: Accessor<readonly DiffSource[]>
  actions: Accessor<SessionReviewCommentActions>
  mention?: LineCommentEditorProps["mention"]
  onLineComment: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete: (comment: SessionReviewCommentDelete) => void
}

export type ReviewCodeViewCommentsOwner = ReviewComments & {
  /** The selection to push into the engine, which runs controlled. */
  selectedLines: Accessor<FileRange | null>
  /** Open a comment's own state, for a caller navigating to it. */
  openComment: (focus: { file: string; id: string }) => void
}

const selectionSide = (range: SelectedLineRange) => range.endSide ?? range.side ?? "additions"
const annotationLine = (range: SelectedLineRange) => Math.max(range.start, range.end)

const sameRange = (a: SelectedLineRange, b: SelectedLineRange) =>
  a.start === b.start && a.end === b.end && a.side === b.side && a.endSide === b.endSide

/**
 * An annotation sits on one row but describes a whole range, and the range is
 * what the comment body and the draft popover quote. Two selections ending on
 * the same line are still different annotations, so the whole range is part of
 * the comparison.
 */
function sameAnnotation(left: ReviewAnnotation, right: ReviewAnnotation) {
  if (left.lineNumber !== right.lineNumber || left.side !== right.side) return false
  if (left.metadata.key !== right.metadata.key) return false
  if (left.metadata.kind === "comment" && right.metadata.kind === "comment") {
    return left.metadata.comment.comment === right.metadata.comment.comment
      && sameRange(left.metadata.comment.selection, right.metadata.comment.selection)
  }
  if (left.metadata.kind === "draft" && right.metadata.kind === "draft") {
    return sameRange(left.metadata.range, right.metadata.range)
  }
  return false
}

/**
 * The item reconciler re-measures on a new array, so reusing the previous one
 * keeps a comment change in one file from re-measuring every other commented
 * file.
 */
function sameAnnotations(a: ReviewAnnotation[], b: ReviewAnnotation[]) {
  return a.length === b.length && a.every((left, index) => sameAnnotation(left, b[index]))
}

/**
 * Review's line comments on Pierre's CodeView.
 *
 * Annotations are derived for the whole document, because an annotation takes
 * document height whether or not its file is on screen. Everything expensive —
 * the comment state machine, the managed annotation renderer, the gutter
 * utility — is built per file on first use by a rendered item and released the
 * moment that item stops being a painted expanded diff. Draft text, the comment
 * being edited and the current selection live here instead, so a release never
 * discards what the user typed and a remount restores it.
 */
export function createReviewCodeViewComments(input: ReviewCodeViewCommentsInput): ReviewCodeViewCommentsOwner {
  const i18n = useI18n()
  const registryOwner = getOwner()
  const [state, setState] = createStore({
    selection: null as FileRange | null,
    commenting: null as FileRange | null,
    opened: null as { file: string; id: string } | null,
  })

  const byFile = createMemo(() => {
    const map = new Map<string, SessionReviewComment[]>()
    for (const comment of input.comments()) {
      const list = map.get(comment.file)
      if (list) list.push(comment)
      else map.set(comment.file, [comment])
    }
    return map
  })

  const empty: ReviewAnnotation[] = []
  let retained = new Map<string, ReviewAnnotation[]>()
  const annotationsByFile = createMemo(() => {
    const next = new Map<string, ReviewAnnotation[]>()
    for (const [file, comments] of byFile()) {
      next.set(file, comments.map((comment) => ({
        side: selectionSide(comment.selection),
        lineNumber: annotationLine(comment.selection),
        metadata: { kind: "comment", key: `comment:${comment.id}`, comment },
      })))
    }
    const draft = state.commenting
    if (draft) {
      const list = next.get(draft.file) ?? []
      next.set(draft.file, [...list, {
        side: selectionSide(draft.range),
        lineNumber: annotationLine(draft.range),
        metadata: { kind: "draft", key: `draft:${draft.file}`, range: draft.range },
      }])
    }
    for (const [file, list] of next) {
      const previous = retained.get(file)
      if (previous && sameAnnotations(previous, list)) next.set(file, previous)
    }
    retained = next
    return next
  })

  const annotations = (file: string) => annotationsByFile().get(file) ?? empty

  const editors = new Map<string, LineCommentEditorState<string>>()
  const editorFor = (file: string) => {
    let editor = editors.get(file)
    if (!editor) {
      editor = createLineCommentEditorState<string>()
      editors.set(file, editor)
    }
    return editor
  }

  type Owner = { owner: ReviewCodeViewCommentOwner<ReviewAnnotationMeta>; dispose: VoidFunction }
  const owners = new Map<string, Owner>()

  const previewFor = (file: string, range: SelectedLineRange) => {
    const diff = input.diffs().find((item) => item.file === file)
    if (!diff) return undefined
    const contents = text({ fileDiff: resolveFileDiff(diff) }, selectionSide(range))
    if (contents.length === 0) return undefined
    return previewSelectedLines(contents, range)
  }

  const buildOwner = (file: string): Owner =>
    createRoot((dispose) => {
      const comments = createMemo(() => byFile().get(file) ?? [])
      const controller = createLineCommentController<SessionReviewComment>({
        comments,
        label: i18n.t("ui.lineComment.submit"),
        draftKey: () => file,
        mention: input.mention,
        getSide: selectionSide,
        clearSelectionOnSelectionEndNull: false,
        state: {
          opened: () => (state.opened?.file === file ? state.opened.id : null),
          setOpened: (id) => setState("opened", id ? { file, id } : null),
          selected: () => (state.selection?.file === file ? state.selection.range : null),
          setSelected: (range) => setState("selection", range ? { file, range } : null),
          commenting: () => (state.commenting?.file === file ? state.commenting.range : null),
          setCommenting: (range) => setState("commenting", range ? { file, range } : null),
          editor: editorFor(file),
        },
        onSubmit: ({ comment, selection }) => {
          input.onLineComment({ file, selection, comment, preview: previewFor(file, selection) })
        },
        onUpdate: ({ id, comment, selection }) => {
          input.onLineCommentUpdate({ id, file, selection, comment, preview: previewFor(file, selection) })
        },
        onDelete: (comment) => input.onLineCommentDelete({ id: comment.id, file }),
        editSubmitLabel: input.actions().saveLabel,
        renderCommentActions: (comment, controls) => (
          <ReviewCommentMenu labels={input.actions()} onEdit={controls.edit} onDelete={controls.remove} />
        ),
      })
      return {
        owner: {
          renderAnnotation: controller.renderAnnotation,
          renderGutterUtility: controller.renderGutterUtility,
          onLineSelected: controller.onLineSelected,
          onLineSelectionEnd: controller.onLineSelectionEnd,
        },
        dispose,
      }
    }, registryOwner ?? undefined)

  const owner = (file: string) => {
    let record = owners.get(file)
    if (!record) {
      record = buildOwner(file)
      owners.set(file, record)
    }
    return record.owner
  }

  const releaseOwner = (file: string, record: Owner) => {
    record.dispose()
    owners.delete(file)
  }

  /**
   * Owners live exactly as long as the expanded diff Pierre is painting. A file
   * the user was drafting in is no exception: its draft text, edit identity and
   * selection are held above, so scrolling away releases a comment controller
   * and its DOM, and scrolling back rebuilds both from that retained state.
   */
  const onRenderedFilesChange = (files: readonly string[]) => {
    const rendered = new Set(files)
    for (const [file, record] of owners) {
      if (rendered.has(file)) continue
      releaseOwner(file, record)
    }
  }

  onCleanup(() => {
    for (const [file, record] of owners) releaseOwner(file, record)
    editors.clear()
  })

  return {
    annotations,
    owner,
    onRenderedFilesChange,
    selectedLines: () => state.selection,
    openComment: (focus) => {
      const comment = input.comments().find((item) => item.file === focus.file && item.id === focus.id)
      setState("opened", focus)
      if (comment) setState("selection", { file: focus.file, range: cloneSelectedLineRange(comment.selection) })
    },
  }
}
