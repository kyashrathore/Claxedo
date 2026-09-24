import type { ParentProps } from "solid-js"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@/transcript"
import "./transcript-kit.css"

export function TranscriptKitProviders(props: ParentProps) {
  return (
    <DialogProvider>
      <MarkedProvider>
        <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
      </MarkedProvider>
    </DialogProvider>
  )
}
