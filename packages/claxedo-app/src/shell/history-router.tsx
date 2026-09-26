import { createBeforeLeave, createRouter, keepDepth, notifyIfNotBlocked, saveCurrentDepth } from "@solidjs/router"
import type { JSX } from "solid-js"

type Router = Parameters<NonNullable<Parameters<typeof createRouter>[0]["create"]>>[0]

type Write = { readonly value: string; readonly replace?: boolean; readonly scroll?: boolean; readonly state?: unknown }

function source(): { value: string; state: unknown } {
  const url = window.location.pathname.replace(/^\/+/, "/") + window.location.search
  const held = window.history.state as { _depth?: unknown } | null
  const state = held && held._depth && Object.keys(held).length === 1 ? undefined : held
  return { value: url + window.location.hash, state }
}

function writeHistory(next: Write): void {
  if (next.replace) window.history.replaceState(keepDepth(next.state), "", next.value)
  else window.history.pushState(next.state, "", next.value)
  const hash = decodeURIComponent(window.location.hash.slice(1))
  const target = hash ? document.getElementById(hash) : null
  if (target) target.scrollIntoView()
  else if (next.scroll) window.scrollTo(0, 0)
  saveCurrentDepth()
}

function anchorOf(event: MouseEvent): { anchor: HTMLAnchorElement; url: URL } | undefined {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return undefined
  const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
  if (!anchor || anchor.target || !anchor.href || anchor.hasAttribute("download")) return undefined
  if ((anchor.getAttribute("rel") ?? "").split(/\s+/).includes("external")) return undefined
  const url = new URL(anchor.href)
  if (url.origin !== window.location.origin) return undefined
  return { anchor, url }
}

function interceptAnchors(router: Router): void {
  const navigate = router.navigatorFactory(router.base)
  document.addEventListener("click", (event) => {
    const found = anchorOf(event)
    if (!found) return
    const state = found.anchor.getAttribute("state")
    event.preventDefault()
    navigate(router.parsePath(found.url.pathname + found.url.search + found.url.hash), {
      resolve: false,
      replace: found.anchor.hasAttribute("replace"),
      scroll: !found.anchor.hasAttribute("noscroll"),
      state: state ? (JSON.parse(state) as unknown) : undefined,
    })
  })
}

export function HistoryRouter(props: { readonly children?: JSX.Element }): JSX.Element {
  const beforeLeave = createBeforeLeave()
  let pending: Write[] = []
  const flush = () => {
    const writes = pending
    pending = []
    for (const next of writes) writeHistory(next)
  }
  const Component = createRouter({
    get: source,
    set: (next) => {
      if (pending.length === 0) setTimeout(flush, 0)
      pending.push(next)
    },
    init: (notify) => {
      const handler = notifyIfNotBlocked(notify, (delta) => {
        flush()
        if (delta) return !beforeLeave.confirm(delta)
        const current = source()
        return !beforeLeave.confirm(current.value, { state: current.state })
      })
      window.addEventListener("popstate", handler)
      return () => window.removeEventListener("popstate", handler)
    },
    create: interceptAnchors,
    utils: { go: (delta) => window.history.go(delta), beforeLeave },
  })
  return <Component>{props.children}</Component>
}
