import type { JSX } from "solid-js"
import { BrowserProvider } from "@/browser"
import { FilesProvider } from "@/files"
import { PanelProvider } from "@/panel"
import { ReviewProvider } from "@/review"
import { TerminalProvider } from "@/terminal"

export function PlacementProviders(props: { readonly children: JSX.Element }): JSX.Element {
  return (
    <PanelProvider>
      <TerminalProvider>
        <FilesProvider>
          <ReviewProvider>
            <BrowserProvider>{props.children}</BrowserProvider>
          </ReviewProvider>
        </FilesProvider>
      </TerminalProvider>
    </PanelProvider>
  )
}
