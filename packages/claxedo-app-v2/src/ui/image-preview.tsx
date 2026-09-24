import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { IconButton } from "./icon-button"
import "./image-preview.css"

export interface ImagePreviewProps {
  src: string
  alt?: string
  closeLabel?: string
}

export function ImagePreview(props: ImagePreviewProps) {
  return (
    <div data-component="image-preview" class="ui-image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={props.closeLabel ?? "Close"}
            />
          </div>
          <div data-slot="image-preview-body">
            <img src={props.src} alt={props.alt ?? "Preview"} data-slot="image-preview-image" />
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
