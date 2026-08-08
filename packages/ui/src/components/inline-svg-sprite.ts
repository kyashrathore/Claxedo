const symbolPattern = /<symbol\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g

/**
 * Keeps SVG sprites inside the renderer document and materializes only symbols
 * that are actually used. External `<use>` references make Chromium retain a
 * parsed SVG document for each reference, which is especially expensive for
 * the file-icon sprite.
 */
export function createInlineSvgSprite(rootID: string, markup: string) {
  const symbols = new Map<string, string>()
  for (const match of markup.matchAll(symbolPattern)) symbols.set(match[1]!, match[0])
  if (symbols.size === 0) throw new Error(`SVG sprite ${rootID} has no symbols`)

  const symbolID = (name: string) => `${rootID}-${name}`

  function ensureRoot() {
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

  return {
    href(name: string) {
      return `#${symbolID(name)}`
    },
    ensure(name: string) {
      if (typeof document === "undefined") return
      const id = symbolID(name)
      if (document.getElementById(id)) return

      const source = symbols.get(name)
      if (!source) throw new Error(`SVG sprite ${rootID} has no symbol ${name}`)
      const renamed = source.replace(`id="${name}"`, `id="${id}"`)
      ensureRoot().insertAdjacentHTML("beforeend", renamed)
    },
  }
}
