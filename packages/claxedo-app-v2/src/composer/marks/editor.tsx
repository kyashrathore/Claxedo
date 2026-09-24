import { Show, createSignal, onMount, type JSX } from "solid-js"
import { createElementSize } from "@solid-primitives/resize-observer"
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, LineCommentEditor, useDialog } from "@/ui"
import { MARK_COLOR } from "@/lib/image-mark-badge"
import type { ImageMark, ImagePart } from "../model"
import { useComposerText } from "../text"
import { ImageMarkLayer } from "./layer"
import type { Size } from "./marks"
import { commentBoxPosition, createMarkDraft, shownSize, type MarkDraft } from "./editor-geometry"
import { createMarkSurface, type MarkSurface } from "./surface"

export type ImageMarkEditorProps = {
  image: ImagePart
  firstNumber: number
  focusIndex?: number
  onSave: (marks: ImageMark[]) => void
}

function MarkPreview(props: { surface: MarkSurface }) {
  return (
    <Show when={props.surface.preview()}>
      {(mark) => (
        <rect
          x={mark().x}
          y={mark().y}
          width={mark().width}
          height={mark().height}
          fill="transparent"
          stroke={MARK_COLOR}
          stroke-width={props.surface.style()?.stroke}
          stroke-dasharray={`${(props.surface.style()?.stroke ?? 2) * 3}`}
        />
      )}
    </Show>
  )
}

type CommentProps = {
  draft: MarkDraft
  index: number
  isNew: boolean
  firstNumber: number
  position: (mark: ImageMark) => JSX.CSSProperties
}

function MarkComment(props: CommentProps) {
  const t = useComposerText()
  return (
    <Show when={props.draft.marks()[props.index]}>
      {(mark) => (
        <div
          ref={(element) => onMount(() => element.querySelector("textarea")?.focus())}
          data-owns-escape
          data-slot="composer-marks-comment"
          style={props.position(mark())}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Show when={!props.isNew}>
            <Button size="small" variant="ghost" onClick={() => props.draft.remove(props.index)}>
              {t("composer.marks.delete")}
            </Button>
          </Show>
          <LineCommentEditor
            value={props.draft.comment()}
            selection={t("composer.marks.mark", { number: String(props.firstNumber + props.index) })}
            onInput={props.draft.setComment}
            onCancel={() => props.draft.cancel()}
            onSubmit={(comment) => {
              props.draft.setComment(comment)
              props.draft.settle()
            }}
          />
        </div>
      )}
    </Show>
  )
}

function MarkStage(props: { image: ImagePart; firstNumber: number; draft: MarkDraft }) {
  const [size, setSize] = createSignal<Size>()
  const [stage, setStage] = createSignal<HTMLDivElement>()
  const stageSize = createElementSize(stage)
  const surface = createMarkSurface({ size, settle: props.draft.settle, add: props.draft.add })
  const measured = () => !!size() && !!stageSize.width && !!stageSize.height
  const openMark = (index: number, event: PointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
    props.draft.open(index)
  }
  return (
    <div ref={setStage} data-slot="composer-marks-stage">
      <div data-slot="composer-marks-frame" style={shownSize(size(), stageSize.width, stageSize.height)}>
        <img
          src={props.image.dataUrl}
          alt={props.image.filename}
          draggable={false}
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        />
        <Show when={size()}>
          {(imageSize) => (
            <svg
              ref={surface.setSurface}
              data-slot="composer-marks-surface"
              viewBox={`0 0 ${imageSize().width} ${imageSize().height}`}
              onPointerDown={surface.down}
              onPointerMove={surface.move}
              onPointerUp={surface.up}
              onPointerCancel={surface.cancel}
            >
              <ImageMarkLayer size={imageSize()} marks={props.draft.marks()} firstNumber={props.firstNumber} onMarkDown={openMark} />
              <MarkPreview surface={surface} />
            </svg>
          )}
        </Show>
        <Show when={measured() && props.draft.editing()} keyed>
          {(current) => (
            <MarkComment
              draft={props.draft}
              index={current.index}
              isNew={current.isNew}
              firstNumber={props.firstNumber}
              position={(mark) => commentBoxPosition(mark, size(), stageSize.width, stageSize.height)}
            />
          )}
        </Show>
      </div>
    </div>
  )
}

export function ImageMarkEditor(props: ImageMarkEditorProps) {
  const dialog = useDialog()
  const t = useComposerText()
  const draft = createMarkDraft(props.image.marks ?? [], props.focusIndex)
  const save = () => {
    draft.settle()
    props.onSave(draft.marks().filter((mark) => mark.comment.trim().length > 0))
    dialog.close()
  }
  return (
    <Dialog size="x-large">
      <DialogHeader>
        <DialogTitle>{t("composer.marks.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="composer-marks-body">
        <MarkStage image={props.image} firstNumber={props.firstNumber} draft={draft} />
      </DialogBody>
      <DialogFooter>
        <span data-slot="composer-marks-hint">{t("composer.marks.hint")}</span>
        <Button size="large" variant="ghost" onClick={() => dialog.close()}>
          {t("composer.action.cancel")}
        </Button>
        <Button size="large" variant="contrast" onClick={save}>
          {t("composer.action.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
