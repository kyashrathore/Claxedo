import type { Component } from "solid-js"
import type { ComposerTextKey } from "../i18n"
import type { ImagePart as ImageAttachmentPart } from "../model"
import type { AnnotationsChipProps } from "./annotations-chip"
import { firstMarkNumber, type NumberedImageMark } from "../marks/marks"
import { PromptContextItems } from "./context-items"
import { PromptImageAttachments } from "./image-attachments"

export type PromptContextItem = Parameters<typeof PromptContextItems>[0]["items"][number]

export type PromptContextStripProps = {
  contextItems: PromptContextItem[]
  contextActive: (item: PromptContextItem) => boolean
  openComment: (item: PromptContextItem) => void
  removeContextItem: (item: PromptContextItem) => void
  annotations: Omit<AnnotationsChipProps, "t">
  imageAttachments: ImageAttachmentPart[]
  imageMarks: NumberedImageMark[]
  openImageMarks: (attachment: ImageAttachmentPart, focusIndex?: number) => void
  removeImageMark: (entry: NumberedImageMark) => void
  removeAttachment: (id: string) => void
  t: (key: ComposerTextKey) => string
}

export const PromptContextStrip: Component<PromptContextStripProps> = (props) => {
  return (
    <>
      <PromptContextItems
        items={props.contextItems}
        active={props.contextActive}
        openComment={props.openComment}
        remove={props.removeContextItem}
        annotations={props.annotations}
        imageMarks={props.imageMarks}
        openImageMark={(entry) => {
          const attachment = props.imageAttachments.find((part) => part.id === entry.imageId)
          if (attachment) props.openImageMarks(attachment, entry.index)
        }}
        removeImageMark={props.removeImageMark}
        t={props.t}
      />
      <PromptImageAttachments
        attachments={props.imageAttachments}
        firstMarkNumber={(id) => firstMarkNumber(props.imageAttachments, id)}
        onOpen={(attachment) => props.openImageMarks(attachment)}
        onRemove={props.removeAttachment}
        removeLabel={props.t("prompt.attachment.remove")}
        markLabel={props.t("prompt.imageMarks.open")}
      />
    </>
  )
}
