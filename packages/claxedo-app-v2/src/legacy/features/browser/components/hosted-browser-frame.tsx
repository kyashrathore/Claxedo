import { Show } from "solid-js"
import { useBrowserPane } from "../store/browser-pane-context"

export function HostedBrowserFrame(props: { url?: string }) {
  const ctx = useBrowserPane()

  const blockedMixedContent = () => typeof location !== "undefined" && location.protocol === "https:" && props.url?.startsWith("http:")

  return (
    <Show
      when={props.url && !blockedMixedContent() ? props.url : undefined}
      fallback={
        <div class="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <div class="font-medium text-text-base">{blockedMixedContent() ? "This source requires HTTPS." : "Browser tabs are unavailable."}</div>
          <div>{blockedMixedContent() ? "Hosted Claxedo blocks insecure embedded content." : "Open this workspace in the Claxedo desktop app to use the browser."}</div>
        </div>
      }
    >
      {(url) => (
        <iframe
          src={url()}
          title="External source preview"
          sandbox=""
          referrerPolicy="no-referrer"
          class="size-full border-0 bg-background-base"
          onLoad={() => ctx.setCurrentUrl(url())}
        />
      )}
    </Show>
  )
}
