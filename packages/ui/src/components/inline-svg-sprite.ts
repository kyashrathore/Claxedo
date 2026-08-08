const symbolPattern = /<symbol\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g

function parseSymbols(rootID: string, markup: string) {
  const symbols = new Map<string, string>()
  for (const match of markup.matchAll(symbolPattern)) symbols.set(match[1]!, match[0])
  if (symbols.size === 0) throw new Error(`SVG sprite ${rootID} has no symbols`)
  return symbols
}

function createSpriteRoot(rootID: string) {
  const existing = document.getElementById(rootID)
  if (existing instanceof SVGSVGElement) return existing

  const root = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  root.id = rootID
  root.setAttribute("aria-hidden", "true")
  root.setAttribute("width", "0")
  root.setAttribute("height", "0")
  root.style.position = "absolute"
  root.style.overflow = "hidden"
  document.body.insertBefore(root, document.body.firstChild)
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
        // A missing development asset must not become an unhandled rejection
        // that fails an unrelated render. The URL is immutable for the life of
        // this module, so log once and stop retrying every mounted icon.
        failed = true
        pending.clear()
        console.warn(`[svg-sprite] ${rootID} failed to load`, error)
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
  }
}
