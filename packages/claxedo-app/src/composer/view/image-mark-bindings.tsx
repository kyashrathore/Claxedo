import type { useDialog } from "@/ui"
import type { ImageNoteContextItem, ImagePart } from "../model"
import type { ComposerSetup } from "../setup"
import { ImageMarkEditor } from "../marks/editor"
import { firstMarkNumber, numberImageMarks, type NumberedImageMark } from "../marks/marks"
import type { PromptContextStripProps } from "./context-strip"

export function createPromptImageMarkBindings(input: {
  composer: ComposerSetup
  dialog: ReturnType<typeof useDialog>
}): Pick<PromptContextStripProps, "imageAttachments" | "imageMarks" | "openImageMarks" | "removeImageMark" | "imageNotes" | "removeImageNote" | "removeAttachment"> {
  const composer = input.composer

  const openMarks = (image: ImagePart, focusIndex?: number) => {
    void input.dialog.show(() => (
      <ImageMarkEditor
        image={image}
        firstNumber={firstMarkNumber(composer.images(), image.id)}
        focusIndex={focusIndex}
        onSave={(marks) => composer.store.setImageMarks(composer.key(), image.id, marks)}
      />
    ))
  }
  const removeImageMark = (entry: NumberedImageMark) => {
    const image = composer.images().find((part) => part.id === entry.imageId)
    if (image) composer.store.setImageMarks(composer.key(), image.id, (image.marks ?? []).filter((_, index) => index !== entry.index))
  }

  return {
    get imageAttachments() {
      return composer.images()
    },
    get imageMarks() {
      return numberImageMarks(composer.images())
    },
    openImageMarks: openMarks,
    removeImageMark,
    get imageNotes() {
      return composer.draft().context.filter((item): item is ImageNoteContextItem => item.type === "image-note")
    },
    removeImageNote: (note) => composer.store.removeContext(composer.key(), note.key),
    removeAttachment: (id) => composer.store.removeImage(composer.key(), id),
  }
}
