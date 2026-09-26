import { createBeforeLeave, createRouter, keepDepth, notifyIfNotBlocked, saveCurrentDepth } from "@solidjs/router"
import type { JSX } from "solid-js"

type Write = { readonly value: string; readonly replace?: boolean; readonly scroll?: boolean; readonly state?: unknown }

function source(): { value: string; state: unknown } {
  const url = window.location.pathname.replace(/^\/+/, "/") + window.location.search
  const held = window.history.state as { _depth?: unknown } | null
  const state = held && held._depth && Object.keys(held).length === 1 ? undefined : held
  return { value: url + window.location.hash, state }
}

function write(next: Write): void {
  if (next.replace) window.history.replaceState(keepDepth(next.state), "", next.value)
  else window.history.pushState(next.state, "", next.value)
  const hash = decodeURIComponent(window.location.hash.slice(1))
  const target = hash ? document.getElementById(hash) : null
  if (target) target.scrollIntoView()
  else if (next.scroll) window.scrollTo(0, 0)
  saveCurrentDepth()
}

export function HistoryRouter(props: { readonly children?: JSX.Element }): JSX.Element {
  const beforeLeave = createBeforeLeave()
  let pending: Write[] = []
  const flush = () => {
    const writes = pending
    pending = []
    for (const next of writes) write(next)
  }
  const Component = createRouter({
    get: source,
    set: (next) => {
      if (pending.length === 0) setTimeout(flush, 0)
      pending.push(next)
    },
    init: (notify) => {
      const handler = notifyIfNotBlocked(notify, (delta) => {
        if (delta) return !beforeLeave.confirm(delta)
        const current = source()
        return !beforeLeave.confirm(current.value, { state: current.state })
      })
      window.addEventListener("popstate", handler)
      return () => window.removeEventListener("popstate", handler)
    },
    utils: { go: (delta) => window.history.go(delta), beforeLeave },
  })
  return <Component>{props.children}</Component>
}
