import { Show } from "solid-js"
import { useDialog } from "@/ui"
import type { ImagePart } from "../model"
import { createComposer, type ComposerProps } from "../setup"
import { acceptedFileTypes } from "../attachments/files"
import { firstMarkNumber, numberImageMarks } from "../marks/marks"
import { ImageMarkEditor } from "../marks/editor"
import { ComposerEditor } from "./editor"
import { ComposerPopover } from "./popover"
import { ComposerNotice } from "./notice"
import { ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel } from "./composer-notice"
import { ComposerToolbar } from "./toolbar"
import { ContextItems } from "./context-items"
import { ImageAttachments } from "./image-attachments"
import "../composer.css"

export function Composer(props: ComposerProps) {
  const composer = createComposer(props)
  const notices = createComposerNoticeChannel()
  const dialog = useDialog()
  const t = composer.t
  const placeholder = () => {
    if (composer.controller.state.mode === "shell") return t("composer.placeholder.shell")
    if (composer.draft().goalArmed) return t("composer.placeholder.goal")
    return t("composer.placeholder.normal")
  }
  const openMarks = (image: ImagePart, focusIndex?: number) => {
    dialog.show(() => (
      <ImageMarkEditor
        image={image}
        firstNumber={firstMarkNumber(composer.images(), image.id)}
        focusIndex={focusIndex}
        onSave={(marks) => composer.store.setImageMarks(composer.key(), image.id, marks)}
      />
    ))
  }

  return (
    <ComposerNoticeProvider channel={notices}>
      <div ref={composer.refs.setRoot} data-component="composer" data-composer-key={props.composerKey}>
        <input
          ref={composer.refs.setFileInput}
          type="file"
          multiple
          accept={acceptedFileTypes.join(",")}
          data-slot="composer-file-input"
          onChange={(event) => {
            const list = event.currentTarget.files
            if (list) void composer.reader.addFiles(Array.from(list))
            event.currentTarget.value = ""
          }}
        />
        <Show when={composer.controller.state.popover.kind !== "closed"}>
          <ComposerPopover composer={composer} />
        </Show>
        <ComposerNoticeRow notice={notices.current()} />
        <ComposerNotice composer={composer} />
        <form
          data-slot="composer-frame"
          data-dragging={composer.dragging() ?? undefined}
          data-working={composer.working() ? "true" : undefined}
          onSubmit={(event) => {
            event.preventDefault()
            void composer.send.send()
          }}
        >
          <Show when={composer.dragging()}>
            {(type) => <div data-slot="composer-dropzone">{t(type() === "mention" ? "composer.dropzone.mention" : "composer.dropzone.files")}</div>}
          </Show>
          <ContextItems
            items={composer.draft().context}
            imageMarks={numberImageMarks(composer.images())}
            removeLabel={t("composer.context.removeFile")}
            removeMarkLabel={t("composer.marks.remove")}
            onRemove={(item) => composer.store.removeContext(composer.key(), item.key)}
            onOpenMark={(entry) => {
              const image = composer.images().find((part) => part.id === entry.imageId)
              if (image) openMarks(image, entry.index)
            }}
            onRemoveMark={(entry) => {
              const image = composer.images().find((part) => part.id === entry.imageId)
              if (image) composer.store.setImageMarks(composer.key(), image.id, (image.marks ?? []).filter((_, index) => index !== entry.index))
            }}
          />
          <ImageAttachments
            attachments={composer.images()}
            firstMarkNumber={(id) => firstMarkNumber(composer.images(), id)}
            removeLabel={t("composer.attachment.remove")}
            markLabel={t("composer.marks.open")}
            onOpen={(image) => openMarks(image)}
            onRemove={(id) => composer.store.removeImage(composer.key(), id)}
          />
          <ComposerEditor composer={composer} placeholder={placeholder()} />
          <ComposerToolbar composer={composer} locked={props.view !== undefined} />
        </form>
      </div>
    </ComposerNoticeProvider>
  )
}
