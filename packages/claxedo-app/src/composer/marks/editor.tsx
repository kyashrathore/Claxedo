import { Show } from "solid-js"
import { useDialog, Dialog, Button, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import type { ImageMark, ImagePart as ImageAttachmentPart } from "../model"
import { useComposerText } from "../text"
import { MarkCommentBox, commentBoxPosition } from "./comment-box"
import { createMarkEditing } from "./mark-editing"
import { createStageFit } from "./stage-fit"
import { ImageMarkSurface } from "./surface"
import { createSurfaceDrag } from "./surface-drag"

export type ImageMarkEditorProps = {
  image: ImageAttachmentPart
  firstNumber: number
  focusIndex?: number
  onSave: (marks: ImageMark[]) => void
}

export function ImageMarkEditor(props: ImageMarkEditorProps) {
  const dialog = useDialog()
  const t = useComposerText()
  const fit = createStageFit()
  const editing = createMarkEditing(props.image.marks ?? [], props.focusIndex)
  let surface: SVGSVGElement | undefined
  const drag = createSurfaceDrag({
    size: fit.size,
    surface: () => surface,
    onStart: editing.settle,
    onDrawn: editing.add,
  })

  const openMark = (index: number, event: PointerEvent) => {
    event.stopPropagation()
    event.preventDefault()
    if (editing.editing()?.index === index) return
    editing.settle()
    editing.openAt(index)
  }

  const save = () => {
    editing.settle()
    props.onSave(editing.marks().filter((mark) => mark.comment.trim().length > 0))
    dialog.close()
  }

  return (
    <Dialog size="viewport" class="claxedo-modal-backdrop">
      <DialogHeader>
        <DialogTitle>{t("prompt.imageMarks.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-1 min-h-0 flex-col gap-3 px-4 pb-4">
        <div ref={fit.setStage} class="flex flex-1 min-h-0 min-w-0 items-center justify-center">
          <div class="relative select-none" style={fit.shown()}>
            <img
              src={props.image.dataUrl}
              alt={props.image.filename}
              draggable={false}
              class="block size-full rounded-md shadow-xs-border"
              onLoad={(event) =>
                fit.setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
            />
            <Show when={fit.size()}>
              {(imageSize) => (
                <ImageMarkSurface
                  size={imageSize()}
                  marks={editing.marks()}
                  firstNumber={props.firstNumber}
                  preview={drag.preview()}
                  surfaceRef={(el) => (surface = el)}
                  onPointerDown={drag.onPointerDown}
                  onPointerMove={drag.onPointerMove}
                  onPointerUp={drag.onPointerUp}
                  onPointerCancel={drag.cancel}
                  onMarkDown={openMark}
                />
              )}
            </Show>
            <Show when={fit.measured() && editing.editing()} keyed>
              {(current) => (
                <Show when={editing.marks()[current.index]}>
                  {(target) => (
                    <MarkCommentBox
                      isNew={current.isNew}
                      value={editing.draft()}
                      position={commentBoxPosition(target(), fit.size(), fit.stageSize)}
                      onInput={editing.setDraft}
                      onDelete={() => editing.remove(current.index)}
                      onCancel={() => {
                        if (current.isNew) editing.remove(current.index)
                        else editing.close()
                      }}
                      onSubmit={(comment) => {
                        editing.setDraft(comment)
                        editing.settle()
                      }}
                    />
                  )}
                </Show>
              )}
            </Show>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2 px-1">
          <span class="text-12-regular text-text-weak mr-auto">{t("prompt.imageMarks.hint")}</span>
          <Button size="large" variant="ghost" onClick={() => dialog.close()}>
            {t("composer.cancel")}
          </Button>
          <Button size="large" variant="contrast" onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
