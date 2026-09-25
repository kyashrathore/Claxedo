import type { ParentProps } from "solid-js"
import { DialogProvider, FileComponentProvider, MarkedProvider } from "@/ui"
import { File } from "./file"

export function TranscriptKitProviders(props: ParentProps) {
  return (
    <DialogProvider>
      <MarkedProvider>
        <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
      </MarkedProvider>
    </DialogProvider>
  )
}
