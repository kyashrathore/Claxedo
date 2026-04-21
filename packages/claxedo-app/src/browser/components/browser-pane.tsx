import { type Component, Show } from "solid-js"

/**
 * Placeholder BrowserPane (Unit 1 seed).
 *
 * Unit 2 replaces the webview-host div with an actual Electron `<webview>`
 * (guarded on `window.api?.browser`) and wires address-bar actions through
 * the preload bridge + main-process BrowserRegistry. For now this renders a
 * legible placeholder so opening a browser tab doesn't produce the
 * "Unknown content type" fallback in `generic-leaf-node.tsx`.
 *
 * Lives in `packages/claxedo-app/src/browser/` (not `claxedo-ui/`) per the
 * pane-local-frontend-orchestration layer direction.
 */
export type BrowserPaneProps = {
  paneId: string
  browserId?: string
  initialUrl?: string
}

export const BrowserPane: Component<BrowserPaneProps> = (props) => {
  const hasBridge = () => typeof window !== "undefined" && !!(window as unknown as { api?: { browser?: unknown } }).api?.browser

  return (
    <div class="flex h-full w-full flex-col bg-background text-foreground">
      <div class="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <span class="font-medium">Browser</span>
        <Show when={props.initialUrl}>
          <span class="truncate text-muted-foreground">{props.initialUrl}</span>
        </Show>
      </div>
      <div class="relative flex-1">
        <div data-testid="browser-pane-webview-host" class="absolute inset-0">
          <Show
            when={hasBridge()}
            fallback={
              <div class="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                <div class="font-medium text-foreground">Browser tabs require the desktop app.</div>
                <div>
                  Set <code>CLAXEDO_ENABLE_BROWSER_TAB=1</code> and{" "}
                  <code>VITE_CLAXEDO_ENABLE_BROWSER_TAB=true</code> and relaunch to try this feature.
                </div>
              </div>
            }
          >
            <div class="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              Browser pane placeholder (paneId: <span class="font-mono">{props.paneId}</span>)
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
