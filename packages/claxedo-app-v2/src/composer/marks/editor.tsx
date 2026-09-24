import { Show, createMemo, createSignal, onMount } from "solid-js"
import { createElementSize } from "@solid-primitives/resize-observer"
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, LineCommentEditor, useDialog } from "@/ui"
import type { ImageMark, ImagePart } from "../model"
import { useComposerText } from "../text"
import { ImageMarkLayer } from "./layer"
import { MARK_COLOR } from "@/lib/image-mark-badge"
import { markFromDrag, markStyle, type Point, type Size } from "./marks"
import { commentBoxPosition, createMarkDraft, shownSize } from "./editor-geometry"

export type ImageMarkEditorProps = {
  image: ImagePart
  firstNumber: number
  focusIndex?: number
  onSave: (marks: ImageMark[]) => void
}

const PIN_BELOW_SCREEN_PX = 4

export function ImageMarkEditor(props: ImageMarkEditorProps) {
  const dialog = useDialog()
  const t = useComposerText()
  const [size, setSize] = createSignal<Size>()
  const [stage, setStage] = createSignal<HTMLDivElement>()
  const stageSize = createElementSize(stage)
  const draft = createMarkDraft(props.image.marks ?? [], props.focusIndex)
  const [drag, setDrag] = createSignal<{ start: Point; current: Point }>()
  let surface: SVGSVGElement | undefined

  const measured = () => !!size() && !!stageSize.width && !!stageSize.height
  const shown = () => shownSize(size(), stageSize.width, stageSize.height)
  const style = createMemo(() => (size() ? markStyle(size()!) : undefined))

  const toImage = (event: PointerEvent): Point | undefined => {
    const current = size()
    if (!surface || !current) return undefined
    const rect = surface.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    return { x: ((event.clientX - rect.left) * current.width) / rect.width, y: ((event.clientY - rect.top) * current.height) / rect.height }
  }

  const onSurfaceDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const point = toImage(event)
    if (!point) return
    event.preventDefault()
    draft.settle()
    surface?.setPointerCapture(event.pointerId)
    setDrag({ start: point, current: point })
  }

  const onSurfaceMove = (event: PointerEvent) => {
    const current = drag()
    if (!current) return
    const point = toImage(event)
    if (point) setDrag({ ...current, current: point })
  }

  const onSurfaceUp = (event: PointerEvent) => {
    const current = drag()
    const imageSize = size()
    setDrag(undefined)
    if (!current || !imageSize || !surface) return
    const point = toImage(event) ?? current.current
    const scale = imageSize.width / surface.getBoundingClientRect().width
    draft.add(markFromDrag(current.start, point, imageSize, PIN_BELOW_SCREEN_PX * scale))
  }

  const openMark = (index: number, event: PointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
    draft.open(index)
  }

  const preview = createMemo(() => {
    const current = drag()
    const imageSize = size()
    return current && imageSize ? markFromDrag(current.start, current.current, imageSize, 0) : undefined
  })

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
        <div ref={setStage} data-slot="composer-marks-stage">
          <div data-slot="composer-marks-frame" style={shown()}>
            <img
              src={props.image.dataUrl}
              alt={props.image.filename}
              draggable={false}
              onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            />
            <Show when={size()}>
              {(imageSize) => (
                <svg
                  ref={(element) => (surface = element)}
                  data-slot="composer-marks-surface"
                  viewBox={`0 0 ${imageSize().width} ${imageSize().height}`}
                  onPointerDown={onSurfaceDown}
                  onPointerMove={onSurfaceMove}
                  onPointerUp={onSurfaceUp}
                  onPointerCancel={() => setDrag(undefined)}
                >
                  <ImageMarkLayer size={imageSize()} marks={draft.marks()} firstNumber={props.firstNumber} onMarkDown={openMark} />
                  <Show when={preview()}>
                    {(mark) => (
                      <rect
                        x={mark().x}
                        y={mark().y}
                        width={mark().width}
                        height={mark().height}
                        fill="transparent"
                        stroke={MARK_COLOR}
                        stroke-width={style()?.stroke}
                        stroke-dasharray={`${(style()?.stroke ?? 2) * 3}`}
                      />
                    )}
                  </Show>
                </svg>
              )}
            </Show>
            <Show when={measured() && draft.editing()} keyed>
              {(current) => (
                <Show when={draft.marks()[current.index]}>
                  {(target) => (
                    <div
                      ref={(element) => onMount(() => element.querySelector("textarea")?.focus())}
                      data-owns-escape
                      data-slot="composer-marks-comment"
                      style={commentBoxPosition(target(), size(), stageSize.width, stageSize.height)}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <Show when={!current.isNew}>
                        <Button size="small" variant="ghost" onClick={() => draft.remove(current.index)}>
                          {t("composer.marks.delete")}
                        </Button>
                      </Show>
                      <LineCommentEditor
                        value={draft.comment()}
                        selection={t("composer.marks.mark", { number: String(props.firstNumber + current.index) })}
                        onInput={draft.setComment}
                        onCancel={() => draft.cancel()}
                        onSubmit={(comment) => {
                          draft.setComment(comment)
                          draft.settle()
                        }}
                      />
                    </div>
                  )}
                </Show>
              )}
            </Show>
          </div>
        </div>
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
