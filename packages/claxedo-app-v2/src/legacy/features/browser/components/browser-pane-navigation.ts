import { createEffect, createSignal, on, type Accessor } from "solid-js"
import { captureException } from "@/platform/telemetry/analytics"

export function syncBrowserPaneUrl(
  requestedUrl: Accessor<string | undefined>,
  navigationVersion: Accessor<number | undefined>,
  currentUrl: Accessor<string | undefined>,
  navigate: (url: string) => Promise<{ ok: boolean; error?: string }>,
) {
  const [ready, setReady] = createSignal(false)
  createEffect(on(
    () => [requestedUrl(), navigationVersion(), ready()] as const,
    ([next, version, isReady], previous) => {
      if (!next || !isReady || (next === previous?.[0] && version === previous[1] && isReady === previous[2]) || next === currentUrl()) return
      const report = (error: unknown) =>
        captureException(error, { surface: "desktop", operation: "browser-pane.navigate", url: next })
      void navigate(next)
        .then((result) => {
          if (!result.ok) report(new Error(result.error ?? "navigate failed"))
        })
        .catch(report)
    },
    { defer: true },
  ))
  return () => setReady(true)
}
