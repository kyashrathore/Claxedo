import { reportUiError } from "../utils/report-error"

const symbolPattern = /<symbol\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g

function parseSymbols(rootID: string, markup: string) {
  const symbols = new Map<string, string>()
  for (const match of markup.matchAll(symbolPattern)) symbols.set(match[1], match[0])
  if (symbols.size === 0) throw new Error(`SVG sprite ${rootID} has no symbols`)
  return symbols
}

/**
 * The one place that builds an SVG sprite host. Every sprite in the app —
 * lazily materialized symbols here, and the eagerly built app/icon sprites —
 * shares this element recipe, so it lives here rather than being restated at
 * each call site.
 *
 * The host is display-locked. It holds `<symbol>` definitions that never paint,
 * but while it is *rendered* every symbol child is style-resolved on each
 * whole-document style recalculation — hundreds of elements of pure cost on an
 * invalidation that already dominates interaction latency. `content-visibility:
 * hidden` removes the subtree from style, layout and paint; `<use>` still
 * resolves its instance tree from these symbols by id, so icons are unchanged.
 *
 * Hosts live in one `display: contents` shelf at the top of `<body>`, and the
 * shelf itself is not `aria-hidden`. Kobalte's hide-outside pass (every menu,
 * dialog and popover) skips an element that is already `aria-hidden` without
 * recording it and walks into it, writing `aria-hidden` on each `<symbol>`:
 * about 500 writes to open the account menu and 168 to close it when the hosts
 * sat directly in `<body>`. The shelf is hidden with one write and not entered.
 */
export function ensureSvgSpriteHost(rootID: string): SVGSVGElement | undefined {
  if (typeof document === "undefined") return undefined
  const existing = document.getElementById(rootID)
  if (existing instanceof SVGSVGElement) return existing
  const shelf = spriteShelf()
  if (!shelf) return undefined

  const root = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  root.id = rootID
  root.setAttribute("aria-hidden", "true")
  root.setAttribute("width", "0")
  root.setAttribute("height", "0")
  root.style.position = "absolute"
  root.style.overflow = "hidden"
  root.style.contentVisibility = "hidden"
  shelf.append(root)
  return root
}

const shelfID = "svg-sprite-shelf"

function spriteShelf(): HTMLElement | undefined {
  const existing = document.getElementById(shelfID)
  if (existing) return existing
  const body = document.body as HTMLElement | null
  if (!body) return undefined
  const shelf = document.createElement("div")
  shelf.id = shelfID
  shelf.style.display = "contents"
  body.insertBefore(shelf, body.firstChild)
  return shelf
}

function createSpriteRoot(rootID: string) {
  const root = ensureSvgSpriteHost(rootID)
  if (!root) throw new Error(`SVG sprite ${rootID} has no document to mount into`)
  return root
}

function insertSymbol(rootID: string, symbols: Map<string, string>, name: string) {
  const id = `${rootID}-${name}`
  if (document.getElementById(id)) return

  const source = symbols.get(name)
  if (!source) throw new Error(`SVG sprite ${rootID} has no symbol ${name}`)
  createSpriteRoot(rootID).insertAdjacentHTML("beforeend", source.replace(`id="${name}"`, `id="${id}"`))
}

/**
 * Keeps SVG sprites inside the renderer document and materializes only symbols
 * that are actually used. External `<use>` references make Chromium retain a
 * parsed SVG document for each reference, which is especially expensive for
 * the file-icon sprite.
 */
export function createInlineSvgSprite(rootID: string, markup: string) {
  const symbols = parseSymbols(rootID, markup)

  const symbolID = (name: string) => `${rootID}-${name}`

  return {
    href(name: string) {
      return `#${symbolID(name)}`
    },
    ensure(name: string) {
      if (typeof document === "undefined") return
      insertSymbol(rootID, symbols, name)
    },
  }
}

/**
 * Keeps large sprites out of the startup JavaScript graph. Callers receive a
 * stable fragment href immediately; requested symbols materialize after the
 * browser loads the standalone asset once.
 */
export function createLazyInlineSvgSprite(rootID: string, load: () => Promise<string>) {
  let symbols: Map<string, string> | undefined
  let loading: Promise<void> | undefined
  let failed = false
  const pending = new Set<string>()

  const materialize = (name: string) => {
    if (!symbols || typeof document === "undefined") return
    insertSymbol(rootID, symbols, name)
  }

  const start = () => {
    if (loading || failed) return
    loading = load()
      .then((markup) => {
        symbols = parseSymbols(rootID, markup)
        for (const name of pending) materialize(name)
        pending.clear()
      })
      .catch((error) => {
        // A missing asset must not become an unhandled rejection that fails an
        // unrelated render. The URL is immutable for the life of this module,
        // so report once and stop retrying every mounted icon.
        failed = true
        pending.clear()
        reportUiError(error, `svg-sprite:${rootID}`)
      })
  }

  return {
    href(name: string) {
      return `#${rootID}-${name}`
    },
    ensure(name: string) {
      if (typeof document === "undefined") return
      if (symbols) {
        materialize(name)
        return
      }
      pending.add(name)
      start()
    },
    /**
     * Fetch the sprite asset ahead of first use. The first icon render
     * otherwise pays the asset's network time inside whatever interaction
     * mounted it; an idle-time preload moves that off every measured window.
     */
    preload() {
      if (typeof document === "undefined") return
      start()
    },
  }
}
