import { createMemo, createSignal, type Accessor } from "solid-js"
import type { SelectedLineRange } from "@pierre/diffs"
import { useTranslator } from "@/i18n"
import { createLineCommentController, type LineCommentAnnotationMeta, type TextFileProps } from "@/transcript"
import { filesDictionary } from "../i18n"

export type FileLineComment = {
  readonly id: string
  readonly file: string
  readonly selection: SelectedLineRange
  readonly comment: string
}

export type FileLineCommentInput = {
  readonly file: string
  readonly selection: SelectedLineRange
  readonly comment: string
  readonly preview?: string
}

export type FileLineComments = {
  readonly enabled: Accessor<boolean>
  readonly composerKey: Accessor<string | undefined>
  readonly comments: Accessor<readonly FileLineComment[]>
  readonly add: (input: FileLineCommentInput) => void
  readonly update: (id: string, input: FileLineCommentInput) => void
  readonly remove: (id: string) => void
}

type Comment = { id: string; file: string; selection: SelectedLineRange; comment: string }

export type FileCommentProps = Pick<
  TextFileProps<LineCommentAnnotationMeta<Comment>>,
  | "enableGutterUtility"
  | "commentedLines"
  | "annotations"
  | "renderAnnotation"
  | "renderGutterUtility"
  | "onLineSelected"
  | "onLineNumberSelectionEnd"
  | "onLineSelectionEnd"
>

function previewOf(contents: string | undefined, selection: SelectedLineRange): string | undefined {
  if (!contents) return undefined
  const start = Math.max(1, Math.min(selection.start, selection.end))
  const end = Math.max(selection.start, selection.end)
  const lines = contents.split("\n").slice(start - 1, end)
  return lines.length === 0 ? undefined : lines.slice(0, 2).join("\n")
}

export function createFileComments(input: {
  readonly path: Accessor<string>
  readonly contents: Accessor<string | undefined>
  readonly store: FileLineComments
  readonly selected: Accessor<SelectedLineRange | null>
  readonly setSelected: (range: SelectedLineRange | null) => void
}): FileCommentProps {
  const t = useTranslator(filesDictionary)
  const [opened, setOpened] = createSignal<string | null>(null)
  const [commenting, setCommenting] = createSignal<SelectedLineRange | null>(null)
  const comments = createMemo(() =>
    input.store.comments().flatMap((comment): Comment[] => (comment.file === input.path() ? [{ ...comment }] : [])),
  )
  const entry = (selection: SelectedLineRange, comment: string) => ({
    file: input.path(),
    selection,
    comment,
    preview: previewOf(input.contents(), selection),
  })
  const controller = createLineCommentController<Comment>({
    comments,
    label: t("files.comment.submit"),
    draftKey: input.path,
    state: { opened, setOpened, selected: input.selected, setSelected: input.setSelected, commenting, setCommenting },
    getHoverSelectedRange: input.selected,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => input.store.add(entry(selection, comment)),
    onUpdate: ({ id, comment, selection }) => input.store.update(id, entry(selection, comment)),
    onDelete: (comment) => input.store.remove(comment.id),
    editSubmitLabel: t("files.comment.save"),
  })
  return commentProps(controller, comments, () => input.store.enabled(), input.setSelected)
}

function commentProps(
  controller: ReturnType<typeof createLineCommentController<Comment>>,
  comments: Accessor<Comment[]>,
  enabled: Accessor<boolean>,
  setSelected: (range: SelectedLineRange | null) => void,
): FileCommentProps {
  return {
    get enableGutterUtility() {
      return enabled()
    },
    get commentedLines() {
      return enabled() ? comments().map((comment) => comment.selection) : undefined
    },
    get annotations() {
      if (!enabled()) return undefined
      return controller
        .annotations()
        .map(({ lineNumber, metadata }) =>
          metadata.kind === "comment" ? { lineNumber, metadata } : { lineNumber, metadata },
        )
    },
    renderAnnotation: controller.renderAnnotation,
    renderGutterUtility: (getHoveredRow) => (enabled() ? (controller.renderGutterUtility(getHoveredRow) ?? null) : null),
    onLineSelected: (range) => (enabled() ? controller.onLineSelected(range) : setSelected(range)),
    onLineNumberSelectionEnd: (range) => enabled() && controller.onLineSelectionEnd(range),
    onLineSelectionEnd: (range) => enabled() && controller.onLineSelectionEnd(range),
  }
}
