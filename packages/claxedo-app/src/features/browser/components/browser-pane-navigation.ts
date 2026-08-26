import { createEffect } from "solid-js"
import { createSignal, type Accessor } from "solid-js"

export function syncBrowserPaneUrl(
  requestedUrl: Accessor<string | undefined>,
  navigationVersion: Accessor<number | undefined>,
  currentUrl: Accessor<string | undefined>,
  navigate: (url: string) => Promise<{ ok: boolean; error?: string }>,
) {
  const [ready, setReady] = createSignal(false)
  createEffect(
    () => [requestedUrl(), navigationVersion(), ready(), currentUrl()] as const,
    ([next, version, isReady, current], previous) => {
      if (
        !next ||
        !isReady ||
        (next === previous?.[0] && version === previous[1] && isReady === previous[2]) ||
        next === current
      )
        return
      void navigate(next)
        .then((result) => {
          if (!result.ok) console.warn("[browser-pane] navigate failed", result.error)
        })
        .catch((error) => console.warn("[browser-pane] navigate failed", error))
    },
    { defer: true },
  )
  return () => setReady(true)
}
