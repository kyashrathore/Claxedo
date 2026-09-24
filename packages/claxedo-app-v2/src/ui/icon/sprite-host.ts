export function ensureSpriteHost(id: string): SVGSVGElement | undefined {
  if (typeof document === "undefined") return undefined
  const existing = document.getElementById(id)
  if (existing instanceof SVGSVGElement) return existing
  const body = document.body
  if (!body) return undefined
  const host = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  host.id = id
  host.setAttribute("aria-hidden", "true")
  host.setAttribute("width", "0")
  host.setAttribute("height", "0")
  host.style.position = "absolute"
  host.style.overflow = "hidden"
  host.style.contentVisibility = "hidden"
  body.insertBefore(host, body.firstChild)
  return host
}

const symbolPattern = /<symbol\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g

function parseSymbols(id: string, markup: string) {
  const symbols = new Map<string, string>()
  for (const match of markup.matchAll(symbolPattern)) symbols.set(match[1], match[0])
  if (symbols.size === 0) throw new Error(`Sprite ${id} has no symbols`)
  return symbols
}

export type LazySprite = {
  href: (name: string) => string
  ensure: (name: string) => void
  preload: () => void
}

export function createLazySprite(id: string, load: () => Promise<string>): LazySprite {
  const state = {
    symbols: undefined as Map<string, string> | undefined,
    loading: undefined as Promise<void> | undefined,
    pending: new Set<string>(),
  }
  const symbolId = (name: string) => `${id}-${name}`

  const insert = (name: string) => {
    const source = state.symbols?.get(name)
    if (!source || document.getElementById(symbolId(name))) return
    const host = ensureSpriteHost(id)
    host?.insertAdjacentHTML("beforeend", source.replace(`id="${name}"`, `id="${symbolId(name)}"`))
  }

  const start = () => {
    if (state.loading) return
    state.loading = load().then((markup) => {
      state.symbols = parseSymbols(id, markup)
      for (const name of state.pending) insert(name)
      state.pending.clear()
    })
  }

  return {
    href: (name) => `#${symbolId(name)}`,
    ensure: (name) => {
      if (typeof document === "undefined") return
      if (state.symbols) {
        insert(name)
        return
      }
      state.pending.add(name)
      start()
    },
    preload: () => {
      if (typeof document !== "undefined") start()
    },
  }
}
