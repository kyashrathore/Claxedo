import { createMemo, createRoot, getOwner, onCleanup, type Accessor, type Owner } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { SelectedLineRange } from "@pierre/diffs"
import { useTranslator } from "@/i18n"
import {
  createLineCommentController,
  createLineCommentEditorState,
  previewSelectedLines,
  resolveFileDiff,
  text,
  type DiffSource,
  type LineCommentEditorState,
  type LineCommentStateProps,
  type ReviewCodeViewCommentOwner,
  type ReviewCodeViewComments,
} from "@/transcript"
import type { ReviewComment, ReviewComments } from "../comments"
import { reviewDictionary } from "../i18n"
import {
  createReviewAnnotations,
  selectionSide,
  type FileRange,
  type ReviewAnnotationMeta,
} from "./code-view-annotations"
import { CommentMenu, type CommentMenuLabels } from "./comment-menu"

type CommentUi = {
  selection: FileRange | null
  commenting: FileRange | null
  opened: { readonly file: string; readonly id: string } | null
}

type CommentOwner = ReviewCodeViewCommentOwner<ReviewAnnotationMeta>

export type CodeViewComments = ReviewCodeViewComments<ReviewAnnotationMeta> & {
  readonly selectedLines: Accessor<FileRange | null>
}

export type CodeViewCommentsInput = {
  readonly comments: ReviewComments
  readonly diffs: Accessor<readonly DiffSource[]>
}

type OwnerInput = CodeViewCommentsInput & {
  readonly byFile: Accessor<ReadonlyMap<string, readonly ReviewComment[]>>
  readonly state: LineCommentStateProps<string>
  readonly labels: { readonly gutter: string; readonly save: string; readonly menu: CommentMenuLabels }
}

function previewFor(diffs: readonly DiffSource[], file: string, range: SelectedLineRange): string | undefined {
  const diff = diffs.find((item) => item.file === file)
  if (!diff) return undefined
  const contents = text({ fileDiff: resolveFileDiff(diff) }, selectionSide(range))
  return contents.length === 0 ? undefined : previewSelectedLines(contents, range)
}

function fileState(
  file: string,
  ui: CommentUi,
  setUi: SetStoreFunction<CommentUi>,
  editor: LineCommentEditorState<string>,
): LineCommentStateProps<string> {
  return {
    opened: () => (ui.opened?.file === file ? ui.opened.id : null),
    setOpened: (id) => setUi("opened", id ? { file, id } : null),
    selected: () => (ui.selection?.file === file ? ui.selection.range : null),
    setSelected: (range) => setUi("selection", range ? { file, range } : null),
    commenting: () => (ui.commenting?.file === file ? ui.commenting.range : null),
    setCommenting: (range) => setUi("commenting", range ? { file, range } : null),
    editor,
  }
}

function fileOwner(file: string, input: OwnerInput): CommentOwner {
  const comments = createMemo((): ReviewComment[] => [...(input.byFile().get(file) ?? [])])
  const withPreview = (selection: SelectedLineRange) => previewFor(input.diffs(), file, selection)
  const controller = createLineCommentController<ReviewComment>({
    comments,
    label: input.labels.gutter,
    draftKey: () => file,
    getSide: selectionSide,
    clearSelectionOnSelectionEndNull: false,
    state: input.state,
    onSubmit: ({ comment, selection }) =>
      input.comments.add({ file, selection, comment, preview: withPreview(selection) }),
    onUpdate: ({ id, comment, selection }) =>
      input.comments.update(id, { file, selection, comment, preview: withPreview(selection) }),
    onDelete: (comment) => input.comments.remove(comment.id),
    editSubmitLabel: input.labels.save,
    renderCommentActions: (_comment, controls) => (
      <CommentMenu labels={input.labels.menu} onEdit={controls.edit} onDelete={controls.remove} />
    ),
  })
  const { renderAnnotation, renderGutterUtility, onLineSelected, onLineSelectionEnd } = controller
  return { renderAnnotation, renderGutterUtility, onLineSelected, onLineSelectionEnd }
}

function createOwnerRegistry(parent: Owner | null, build: (file: string) => CommentOwner) {
  const owners = new Map<string, { readonly owner: CommentOwner; readonly dispose: () => void }>()
  const release = (file: string) => {
    owners.get(file)?.dispose()
    owners.delete(file)
  }
  onCleanup(() => {
    for (const file of [...owners.keys()]) release(file)
  })
  return {
    owner: (file: string): CommentOwner => {
      const existing = owners.get(file)
      if (existing) return existing.owner
      const created = createRoot((dispose) => ({ owner: build(file), dispose }), parent ?? undefined)
      owners.set(file, created)
      return created.owner
    },
    keep: (files: readonly string[]) => {
      const rendered = new Set(files)
      for (const file of [...owners.keys()]) if (!rendered.has(file)) release(file)
    },
  }
}

export function createCodeViewComments(input: CodeViewCommentsInput): CodeViewComments {
  const t = useTranslator(reviewDictionary)
  const [ui, setUi] = createStore<CommentUi>({ selection: null, commenting: null, opened: null })
  const byFile = createMemo(() => Map.groupBy(input.comments.comments(), (comment) => comment.file))
  const editors = new Map<string, LineCommentEditorState<string>>()
  const editorFor = (file: string) => {
    const existing = editors.get(file)
    if (existing) return existing
    const created = createLineCommentEditorState<string>()
    editors.set(file, created)
    return created
  }
  const registry = createOwnerRegistry(getOwner(), (file) => {
    const labels = {
      gutter: t("review.comment.gutter"),
      save: t("review.comment.save"),
      menu: { more: t("review.comment.more"), edit: t("review.comment.edit"), remove: t("review.comment.delete") },
    }
    return fileOwner(file, { ...input, byFile, labels, state: fileState(file, ui, setUi, editorFor(file)) })
  })
  return {
    annotations: createReviewAnnotations(input.comments.comments, () => ui.commenting),
    owner: registry.owner,
    onRenderedFilesChange: registry.keep,
    selectedLines: () => ui.selection,
  }
}
