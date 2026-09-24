type ReadyWatcher = {
  observer?: MutationObserver
  token: number
}

export function createReadyWatcher(): ReadyWatcher {
  return { token: 0 }
}

export function clearReadyWatcher(state: ReadyWatcher) {
  state.observer?.disconnect()
  state.observer = undefined
}

/**
 * The nearest ancestor that scrolls `el` vertically, or `undefined` when nothing above it does.
 *
 * `pierre/virtualizer.ts` walks the same chain but also treats the deprecated
 * `overflow: overlay` as scrollable; the two are kept apart deliberately.
 */
export function scrollParent(el: HTMLElement): HTMLElement | undefined {
  let parent = el.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (style.overflowY === "auto" || style.overflowY === "scroll") return parent
    parent = parent.parentElement
  }
  return undefined
}

export function getViewerHost(container: HTMLElement | undefined): HTMLElement | undefined {
  if (!container) return undefined
  const host = container.querySelector("diffs-container")
  if (!(host instanceof HTMLElement)) return undefined
  return host
}

export function getViewerRoot(container: HTMLElement | undefined) {
  return getViewerHost(container)?.shadowRoot ?? undefined
}

export function applyViewerScheme(host: HTMLElement | undefined) {
  if (!host) return
  if (typeof document === "undefined") return

  const scheme = document.documentElement.dataset.colorScheme
  if (scheme === "dark" || scheme === "light") {
    host.dataset.colorScheme = scheme
    return
  }

  host.removeAttribute("data-color-scheme")
}

export function observeViewerScheme(getHost: () => HTMLElement | undefined) {
  if (typeof document === "undefined") return () => {}

  applyViewerScheme(getHost())
  if (typeof MutationObserver === "undefined") return () => {}

  const root = document.documentElement
  const monitor = new MutationObserver(() => applyViewerScheme(getHost()))
  monitor.observe(root, { attributes: true, attributeFilter: ["data-color-scheme"] })
  return () => monitor.disconnect()
}

export function notifyShadowReady(opts: {
  state: ReadyWatcher
  container: HTMLElement
  getRoot: () => ShadowRoot | undefined
  isReady: (root: ShadowRoot) => boolean
  onReady: () => void
  settleFrames?: number
}) {
  clearReadyWatcher(opts.state)
  opts.state.token += 1

  const token = opts.state.token
  const settle = Math.max(0, opts.settleFrames ?? 0)

  const runReady = () => {
    const step = (left: number) => {
      if (token !== opts.state.token) return
      if (left <= 0) {
        opts.onReady()
        return
      }
      requestAnimationFrame(() => step(left - 1))
    }

    requestAnimationFrame(() => step(settle))
  }

  const observeRoot = (root: ShadowRoot) => {
    if (opts.isReady(root)) {
      runReady()
      return
    }

    if (typeof MutationObserver === "undefined") return

    clearReadyWatcher(opts.state)
    opts.state.observer = new MutationObserver(() => {
      if (token !== opts.state.token) return
      if (!opts.isReady(root)) return

      clearReadyWatcher(opts.state)
      runReady()
    })
    opts.state.observer.observe(root, { childList: true, subtree: true })
  }

  const root = opts.getRoot()
  if (!root) {
    if (typeof MutationObserver === "undefined") return

    opts.state.observer = new MutationObserver(() => {
      if (token !== opts.state.token) return

      const next = opts.getRoot()
      if (!next) return

      observeRoot(next)
    })
    opts.state.observer.observe(opts.container, { childList: true, subtree: true })
    return
  }

  observeRoot(root)
}
