import { browserIntegration, createRouter, type LocationChange } from "@solidjs/router"
import type { JSX } from "solid-js"

export function HistoryRouter(props: { readonly children?: JSX.Element }): JSX.Element {
  const browser = browserIntegration({})
  let pending: LocationChange[] = []
  const flush = () => {
    const writes = pending
    pending = []
    for (const next of writes) browser.set(next)
  }
  const Component = createRouter({
    ...browser,
    set: (next) => {
      if (pending.length === 0) setTimeout(flush, 0)
      pending.push(next)
    },
    init: (notify) => {
      window.addEventListener("popstate", flush)
      const stop = browser.init(notify)
      return () => {
        window.removeEventListener("popstate", flush)
        stop()
      }
    },
  })
  return <Component>{props.children}</Component>
}
