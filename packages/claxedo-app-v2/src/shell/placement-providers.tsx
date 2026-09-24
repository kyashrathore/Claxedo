import { onCleanup, type JSX } from "solid-js"
import { BrowserProvider } from "@/browser"
import { FilesProvider } from "@/files"
import { ReviewProvider, reviewCommands, useReview } from "@/review"
import { useTerminalCommands } from "@/terminal/commands"
import { TerminalProvider } from "@/terminal/store"
import { useWorkbench } from "@/workbench"
import { useShellRegistries } from "./registries"
import { useShellRoute } from "./router"

function PlacementCommands(): JSX.Element {
  const registries = useShellRegistries()
  const disposers = [...useTerminalCommands(), ...reviewCommands(useReview())].map((entry) => registries.commands.add(entry))
  onCleanup(() => {
    for (const dispose of disposers) dispose()
  })
  return null
}

export function PlacementProviders(props: { readonly children: JSX.Element }): JSX.Element {
  const routing = useShellRoute()
  const workbench = useWorkbench()
  return (
    <TerminalProvider placementId={routing.placementId} openPane={workbench.openByKind}>
      <FilesProvider placementId={routing.placementId} openPane={workbench.openByKind}>
        <ReviewProvider placementId={routing.placementId} openPane={workbench.openByKind}>
          <BrowserProvider placementId={routing.placementId}>
            <PlacementCommands />
            {props.children}
          </BrowserProvider>
        </ReviewProvider>
      </FilesProvider>
    </TerminalProvider>
  )
}
