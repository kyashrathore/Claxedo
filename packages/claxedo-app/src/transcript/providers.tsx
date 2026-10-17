import type { ParentProps } from "solid-js"
import { SurfaceRichTextProvider, type SurfaceRichText } from "@/surface"
import { DialogProvider, FileComponentProvider, MarkedProvider } from "@/ui"
import { File } from "./file"
import { Markdown } from "./markdown"
import { handleTranscriptLinkClick } from "./transcript-link"

const surfaceRichText: SurfaceRichText = { Markdown, onLinkClick: handleTranscriptLinkClick }

export function TranscriptKitProviders(props: ParentProps) {
  return (
    <DialogProvider>
      <MarkedProvider>
        <FileComponentProvider component={File}>
          <SurfaceRichTextProvider value={surfaceRichText}>{props.children}</SurfaceRichTextProvider>
        </FileComponentProvider>
      </MarkedProvider>
    </DialogProvider>
  )
}
