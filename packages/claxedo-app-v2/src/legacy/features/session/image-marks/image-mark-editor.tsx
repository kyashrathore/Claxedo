import { Show, createMemo, createSignal, onMount } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { LineCommentEditor } from "@/ui/session-kit"
import type { ImageAttachmentPart, ImageMark } from "@/features/session/providers/prompt"
import { useLanguage } from "@/platform/i18n/provider"
import { createElementSize } from "@solid-primitives/resize-observer"
import { ImageMarkLayer } from "./mark-layer"
import { MARK_COLOR, markFromDrag, markStyle, type Point, type Size } from "./marks"

export type ImageMarkEditorProps = {
  image: ImageAttachmentPart
  firstNumber: number
  focusIndex?: number
  onSave: (marks: ImageMark[]) => void
}

type Editing = { index: number; isNew: boolean }

const PIN_BELOW_SCREEN_PX = 4
const COMMENT_BOX_WIDTH_PX = 300
const COMMENT_BOX_HEIGHT_PX = 150
const GAP_PX = 12

export function ImageMarkEditor(props: ImageMarkEditorProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const [size, setSize] = createSignal<Size>()
  const [marks, setMarks] = createSignal((props.image.marks ?? []).map((mark) => ({ ...mark })))
  const initial = props.focusIndex === undefined ? undefined : marks()[props.focusIndex]
  const [editing, setEditing] = createSignal<Editing | undefined>(
    initial && props.focusIndex !== undefined ? { index: props.focusIndex, isNew: false } : undefined,
  )
  const [draft, setDraft] = createSignal(initial?.comment ?? "")
  const open = (next: Editing, comment: string) => {
    setDraft(comment)
    setEditing(next)
  }
  const [drag, setDrag] = createSignal<{ start: Point; current: Point }>()
  const [stage, setStage] = createSignal<HTMLDivElement>()
  const stageSize = createElementSize(stage)
  /** The image scaled down, never up, to the room the dialog leaves it, so Save stays on screen. */
  const measured = () => !!size() && !!stageSize.width && !!stageSize.height
  const shown = () => {
    const natural = size()
    const width = stageSize.width
    const height = stageSize.height
    if (!natural || !width || !height) return { visibility: "hidden" as const }
    const scale = Math.min(width / natural.width, height / natural.height, 1)
    return { width: `${natural.width * scale}px`, height: `${natural.height * scale}px` }
  }
  let surface: SVGSVGElement | undefined

  const style = createMemo(() => {
    const current = size()
    return current ? markStyle(current) : undefined
  })

  const toImage = (event: PointerEvent): Point | undefined => {
    const current = size()
    if (!surface || !current) return undefined
    const rect = surface.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    return {
      x: ((event.clientX - rect.left) * current.width) / rect.width,
      y: ((event.clientY - rect.top) * current.height) / rect.height,
    }
  }

  /** Keeps a typed comment, and drops a new mark the user never commented on. */
  const settle = () => {
    const current = editing()
    if (!current) return
    const comment = draft().trim()
    if (comment) {
      setMarks((list) => list.map((mark, index) => (index === current.index ? { ...mark, comment } : mark)))
    } else if (current.isNew || !marks()[current.index]?.comment) {
      setMarks((list) => list.filter((_, index) => index !== current.index))
    }
    setEditing(undefined)
  }

  const remove = (target: number) => {
    setMarks((list) => list.filter((_, index) => index !== target))
    setEditing(undefined)
  }

  const onSurfaceDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const point = toImage(event)
    if (!point) return
    event.preventDefault()
    settle()
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
    const mark = markFromDrag(current.start, point, imageSize, PIN_BELOW_SCREEN_PX * scale)
    const index = marks().length
    setMarks((list) => [...list, mark])
    open({ index, isNew: true }, "")
  }

  const openMark = (index: number, event: PointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
    if (editing()?.index === index) return
    settle()
    const mark = marks()[index]
    if (mark) open({ index, isNew: false }, mark.comment)
  }

  const preview = createMemo(() => {
    const current = drag()
    const imageSize = size()
    if (!current || !imageSize) return undefined
    return markFromDrag(current.start, current.current, imageSize, 0)
  })

  /** Beside the mark where the stage has room, so the box never hides the image being marked; below it otherwise. */
  const boxPosition = (mark: ImageMark) => {
    const natural = size()
    const stageWidth = stageSize.width
    if (!natural || !stageWidth) return {}
    const scale = Math.min(stageWidth / natural.width, (stageSize.height ?? 0) / natural.height, 1)
    const shownWidth = natural.width * scale
    const shownHeight = natural.height * scale
    const margin = (stageWidth - shownWidth) / 2
    const left = mark.x * scale
    const right = (mark.x + mark.width) * scale
    const top = Math.max(0, Math.min(mark.y * scale, shownHeight - COMMENT_BOX_HEIGHT_PX))
    if (shownWidth - right + margin >= COMMENT_BOX_WIDTH_PX + GAP_PX) return { left: `${right + GAP_PX}px`, top: `${top}px` }
    if (left + margin >= COMMENT_BOX_WIDTH_PX + GAP_PX) return { left: `${left - GAP_PX - COMMENT_BOX_WIDTH_PX}px`, top: `${top}px` }
    const below = (mark.y + mark.height) * scale + GAP_PX
    const x = Math.max(-margin, Math.min(left - 12, shownWidth + margin - COMMENT_BOX_WIDTH_PX))
    if (below + COMMENT_BOX_HEIGHT_PX <= shownHeight) return { left: `${x}px`, top: `${below}px` }
    return { left: `${x}px`, bottom: `${shownHeight - mark.y * scale + GAP_PX}px` }
  }

  const save = () => {
    settle()
    props.onSave(marks().filter((mark) => mark.comment.trim().length > 0))
    dialog.close()
  }

  return (
    <Dialog title={language.t("prompt.imageMarks.title")} size="viewport" scrim="strong">
      <div class="flex flex-1 min-h-0 flex-col gap-3" data-component="image-mark-editor">
        <div ref={setStage} class="flex flex-1 min-h-0 min-w-0 items-center justify-center">
          <div class="relative select-none" style={shown()}>
            <img
              src={props.image.dataUrl}
              alt={props.image.filename}
              draggable={false}
              class="block size-full rounded-md shadow-xs-border"
              onLoad={(event) =>
                setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
            />
            <Show when={size()}>
              {(imageSize) => (
                <svg
                  ref={(el) => (surface = el)}
                  data-slot="image-mark-surface"
                  class="absolute inset-0 size-full cursor-crosshair touch-none"
                  viewBox={`0 0 ${imageSize().width} ${imageSize().height}`}
                  onPointerDown={onSurfaceDown}
                  onPointerMove={onSurfaceMove}
                  onPointerUp={onSurfaceUp}
                  onPointerCancel={() => setDrag(undefined)}
                >
                  <ImageMarkLayer
                    size={imageSize()}
                    marks={marks()}
                    firstNumber={props.firstNumber}
                    onMarkDown={openMark}
                  />
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
            <Show when={measured() && editing()} keyed>
              {(current) => {
                const mark = () => marks()[current.index]
                return (
                  <Show when={mark()}>
                    {(target) => (
                      <div
                        ref={(el) => onMount(() => el.querySelector("textarea")?.focus())}
                        data-owns-escape
                        class="absolute z-10 flex flex-col items-end gap-1"
                        style={{ width: `${COMMENT_BOX_WIDTH_PX}px`, ...boxPosition(target()) }}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <Show when={!current.isNew}>
                          <Button size="small" variant="ghost" onClick={() => remove(current.index)}>
                            {language.t("prompt.imageMarks.delete")}
                          </Button>
                        </Show>
                        <LineCommentEditor
                          inline
                          class="w-full"
                          value={draft()}
                          selection={language.t("prompt.imageMarks.mark", {
                            number: String(props.firstNumber + current.index),
                          })}
                          onInput={setDraft}
                          onCancel={() => {
                            if (current.isNew) remove(current.index)
                            else setEditing(undefined)
                          }}
                          onSubmit={(comment) => {
                            setDraft(comment)
                            settle()
                          }}
                        />
                      </div>
                    )}
                  </Show>
                )
              }}
            </Show>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2 px-1">
          <span class="text-12-regular text-text-weak mr-auto">{language.t("prompt.imageMarks.hint")}</span>
          <Button size="large" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button size="large" variant="primary" onClick={save}>
            {language.t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
